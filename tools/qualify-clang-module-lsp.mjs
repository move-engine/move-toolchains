#!/usr/bin/env node

import {execFileSync, spawn} from "node:child_process";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import process from "node:process";
import {pathToFileURL} from "node:url";
import {canonicalJson} from "./build-receipt.mjs";

export const moduleLspProbeRevision = "move-toolchains-import-std-lsp-v2";

function fail(message) {
    throw new Error(message);
}

function parseArguments(argv) {
    const values = new Map();
    const allowed = new Set([
        "--clang-root", "--profile", "--ucrt64-root", "--output",
    ]);
    for (let index = 0; index < argv.length; index += 2) {
        const name = argv[index];
        const value = argv[index + 1];
        if (!allowed.has(name) || !value || values.has(name)) {
            fail(`invalid or duplicate argument: ${name ?? "<missing>"}`);
        }
        values.set(name, value);
    }
    for (const required of ["--clang-root", "--profile", "--output"]) {
        if (!values.has(required)) fail(`missing ${required}`);
    }
    const profile = values.get("--profile");
    if (![
        "windows-x86_64-ucrt64",
        "linux-x86_64-glibc2.35",
        "linux-x86_64-glibc2.38",
    ].includes(profile)) fail(`unsupported profile: ${profile}`);
    if (profile === "windows-x86_64-ucrt64" &&
        !values.has("--ucrt64-root")) fail("Windows profile requires --ucrt64-root");
    return {
        clangRoot: path.resolve(values.get("--clang-root")),
        profile,
        ucrt64Root: values.has("--ucrt64-root")
            ? path.resolve(values.get("--ucrt64-root")) : null,
        output: path.resolve(values.get("--output")),
    };
}

function positionOf(contents, token, occurrence = 0, offset = 0) {
    let index = -1;
    for (let current = 0; current <= occurrence; ++current) {
        index = contents.indexOf(token, index + 1);
        if (index < 0) fail(`probe token was not found: ${token}`);
    }
    index += offset;
    const prefix = contents.slice(0, index);
    const lines = prefix.split("\n");
    return {line: lines.length - 1, character: lines.at(-1).length};
}

function locations(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

function workspaceDocumentCount(edit) {
    if (!edit || typeof edit !== "object") return 0;
    const changed = new Set(Object.keys(edit.changes ?? {}));
    for (const change of edit.documentChanges ?? []) {
        const uri = change?.textDocument?.uri ?? change?.uri;
        if (typeof uri === "string") changed.add(uri);
    }
    return changed.size;
}

class LspClient {
    constructor(executable, args) {
        this.child = spawn(executable, args, {stdio: ["pipe", "pipe", "pipe"]});
        this.buffer = Buffer.alloc(0);
        this.nextId = 1;
        this.pending = new Map();
        this.diagnostics = new Map();
        this.stderr = "";
        this.exit = new Promise(resolve => this.child.once("exit", resolve));
        this.child.stdout.on("data", chunk => this.receive(chunk));
        this.child.stderr.on("data", chunk => { this.stderr += chunk.toString(); });
        this.child.on("exit", code => {
            if (code !== 0 && this.pending.size) {
                const error = new Error(`clangd exited with ${code}: ${this.stderr}`);
                for (const {reject} of this.pending.values()) reject(error);
                this.pending.clear();
            }
        });
    }

    receive(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
            const headerEnd = this.buffer.indexOf("\r\n\r\n");
            if (headerEnd < 0) return;
            const header = this.buffer.subarray(0, headerEnd).toString("ascii");
            const match = header.match(/(?:^|\r\n)Content-Length: (\d+)(?:\r\n|$)/i);
            if (!match) fail("clangd emitted an invalid LSP frame");
            const length = Number(match[1]);
            const bodyStart = headerEnd + 4;
            if (this.buffer.length < bodyStart + length) return;
            const message = JSON.parse(
                this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8"));
            this.buffer = this.buffer.subarray(bodyStart + length);
            if (message.id !== undefined && this.pending.has(message.id)) {
                const pending = this.pending.get(message.id);
                this.pending.delete(message.id);
                if (message.error) pending.reject(new Error(
                    `${pending.method}: ${JSON.stringify(message.error)}`));
                else pending.resolve(message.result);
            } else if (message.method === "textDocument/publishDiagnostics") {
                this.diagnostics.set(
                    message.params.uri, message.params.diagnostics ?? []);
            }
        }
    }

    send(message) {
        const body = Buffer.from(JSON.stringify({jsonrpc: "2.0", ...message}));
        this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
        this.child.stdin.write(body);
    }

    request(method, params) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} timed out`));
            }, 30000);
            this.pending.set(id, {
                method,
                resolve: value => { clearTimeout(timer); resolve(value); },
                reject: error => { clearTimeout(timer); reject(error); },
            });
            this.send({id, method, params});
        });
    }

    notify(method, params) {
        this.send({method, params});
    }

    async waitForDiagnostics(uris) {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
            if (uris.every(uri => this.diagnostics.has(uri))) return;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        fail(`clangd diagnostics timed out: ${this.stderr}`);
    }

    async close() {
        try {
            await this.request("shutdown", null);
            this.notify("exit", null);
        } finally {
            this.child.stdin.end();
            await this.exit;
        }
    }
}

function run(executable, args) {
    execFileSync(executable, args, {stdio: "inherit", windowsHide: true});
}

async function qualify(options) {
    const executable = name => path.join(options.clangRoot, "bin",
        process.platform === "win32" ? `${name}.exe` : name);
    const clangxx = executable("clang++");
    const clangd = executable("clangd");
    const revisionOutput = execFileSync(clangd, ["--version"], {
        encoding: "utf8", windowsHide: true,
    });
    const revision = revisionOutput.match(/\b([0-9a-f]{40})\b/)?.[1];
    if (!revision) fail("clangd version lacks a full source revision");
    const host = options.profile === "windows-x86_64-ucrt64"
        ? "win32-x64" : "linux-x64";
    const root = await mkdtemp(path.join(tmpdir(), "move clang module lsp "));
    try {
        const stdSource = path.join(
            options.clangRoot, "share", "libc++", "v1", "std.cppm");
        const stdPcm = path.join(root, "std.pcm");
        const modulePcm = path.join(root, "Move.Probe.pcm");
        const moduleFile = path.join(root, "move_probe.cppm");
        const consumerFile = path.join(root, "consumer.cpp");
        const common = [
            "-std=c++26", "-freflection-latest", "-fentity-proxy-reflection",
            "-Wno-reserved-module-identifier",
        ];
        if (host === "win32-x64") {
            common.push(
                "--target=x86_64-w64-windows-gnu",
                `--sysroot=${options.ucrt64Root}`,
                "-nostdinc++", "-isystem",
                path.join(options.clangRoot, "include", "c++", "v1"));
        } else {
            common.push("-stdlib=libc++");
        }
        const moduleSource = `export module Move.Probe;
export namespace Move::Probe {
struct Record { int Value; };
struct WeightedValue { int Value; };
}
`;
        const consumerSource = `import std;
import Move.Probe;

struct [[=42, =1.0f]] Tagged {};

static_assert(std::meta::annotations_of_with_type(^^Tagged, ^^int).size() == 1);
static_assert(std::meta::extract<int>(
    std::meta::annotations_of_with_type(^^Tagged, ^^int)[0]) == 42);
static constexpr auto StaticValues = std::define_static_array(std::array{1, 2, 3});
static_assert(StaticValues.size() == 3 && StaticValues[2] == 3);
static_assert(std::string_view(std::define_static_string("module std")) ==
              "module std");

int main() {
    Move::Probe::Record record{};
    Move::Probe::Record second{};
    Move::Probe::WeightedValue weighted{};
    return record.Value + second.Value + weighted.Value;
}
`;
        await writeFile(moduleFile, moduleSource);
        await writeFile(consumerFile, consumerSource);
        run(clangxx, [...common, "--precompile", stdSource, "-o", stdPcm]);
        run(clangxx, [...common, "--precompile", moduleFile, "-o", modulePcm]);
        const imports = [
            `-fmodule-file=std=${stdPcm}`,
            `-fmodule-file=Move.Probe=${modulePcm}`,
        ];
        run(clangxx, [...common, ...imports, "-fsyntax-only", consumerFile]);
        await writeFile(path.join(root, "compile_commands.json"),
            `${JSON.stringify([
                {directory: root,
                    arguments: [clangxx, ...common, "--precompile", moduleFile,
                        "-o", modulePcm], file: moduleFile},
                {directory: root,
                    arguments: [clangxx, ...common, ...imports, "-c", consumerFile],
                    file: consumerFile},
            ], null, 2)}\n`);

        const client = new LspClient(clangd, ["--log=error"]);
        const moduleUri = pathToFileURL(moduleFile).href;
        const consumerUri = pathToFileURL(consumerFile).href;
        try {
            await client.request("initialize", {
                processId: process.pid,
                rootUri: pathToFileURL(root).href,
                capabilities: {
                    workspace: {workspaceEdit: {documentChanges: true}},
                    textDocument: {
                        completion: {completionItem: {snippetSupport: false}},
                        semanticTokens: {requests: {full: true}, tokenTypes: [],
                            tokenModifiers: [], formats: ["relative"]},
                    },
                },
            });
            client.notify("initialized", {});
            client.notify("textDocument/didOpen", {textDocument: {
                uri: moduleUri, languageId: "cpp", version: 1, text: moduleSource,
            }});
            client.notify("textDocument/didOpen", {textDocument: {
                uri: consumerUri, languageId: "cpp", version: 1,
                text: consumerSource,
            }});
            await client.waitForDiagnostics([moduleUri, consumerUri]);
            const recordPosition = positionOf(consumerSource, "Record", 0, 2);
            const localPosition = positionOf(consumerSource, "weighted", 0, 2);
            const completionPosition = positionOf(
                consumerSource, "Move::Probe::Record second", 0,
                "Move::Probe::".length);
            const textDocument = {uri: consumerUri};
            const hover = await client.request("textDocument/hover", {
                textDocument, position: recordPosition,
            });
            const definition = await client.request("textDocument/definition", {
                textDocument, position: recordPosition,
            });
            const references = await client.request("textDocument/references", {
                textDocument, position: recordPosition,
                context: {includeDeclaration: true},
            });
            const importedPrepare = await client.request(
                "textDocument/prepareRename", {textDocument, position: recordPosition});
            const localPrepare = await client.request(
                "textDocument/prepareRename", {textDocument, position: localPosition});
            const importedRename = await client.request("textDocument/rename", {
                textDocument, position: recordPosition, newName: "RenamedRecord",
            });
            const localRename = await client.request("textDocument/rename", {
                textDocument, position: localPosition, newName: "localWeighted",
            });
            const semantic = await client.request(
                "textDocument/semanticTokens/full", {textDocument});
            const completion = await client.request("textDocument/completion", {
                textDocument, position: completionPosition,
                context: {triggerKind: 1},
            });
            const completionLabels = completion => new Set(
                (Array.isArray(completion) ? completion : completion?.items ?? [])
                    .map(item => item.label.trim()));
            const labels = completionLabels(completion);
            const diagnostics = [
                ...(client.diagnostics.get(moduleUri) ?? []),
                ...(client.diagnostics.get(consumerUri) ?? []),
            ];
            return {
                probeRevision: moduleLspProbeRevision,
                toolchainRevision: revision,
                toolchainHost: host,
                hover: hover !== null,
                importedPrepareRename: importedPrepare !== null,
                prepareRename: localPrepare !== null,
                completionHasImportedMember: labels.has("Record"),
                diagnosticCount: diagnostics.length,
                diagnostics,
                definitionLocations: locations(definition).length,
                importedRenameDocuments: workspaceDocumentCount(importedRename),
                referenceLocations: locations(references).length,
                renameDocuments: workspaceDocumentCount(localRename),
                semanticTokenWords: Math.floor((semantic?.data?.length ?? 0) / 5),
            };
        } finally {
            await client.close();
        }
    } finally {
        await rm(root, {recursive: true, force: true});
    }
}

async function main() {
    const options = parseArguments(process.argv.slice(2));
    const result = await qualify(options);
    for (const [name, value] of Object.entries(result)) {
        if (name === "diagnostics") continue;
        if (typeof value === "boolean" && value !== true) {
            fail(`module LSP qualification failed: ${name}: ${JSON.stringify(result)}`);
        }
        if (typeof value === "number" && value < 1 && name !== "diagnosticCount") {
            fail(`module LSP qualification produced no ${name}`);
        }
    }
    if (result.diagnosticCount !== 0) {
        fail(`module LSP qualification reported diagnostics: ${JSON.stringify(result.diagnostics)}`);
    }
    await writeFile(options.output, canonicalJson(result));
    console.log(`module LSP qualification: ${options.output}`);
}

main().catch(error => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
});
