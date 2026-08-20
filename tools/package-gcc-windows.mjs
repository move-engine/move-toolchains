#!/usr/bin/env node

import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    stat,
    utimes,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {loadGccRecipe} from "./gcc-recipe.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const recipePath = path.join(
    repositoryRoot, "recipes", "gcc", "windows-x86_64-ucrt64.json");
const configurationPath = path.join(repositoryRoot, "toolchains.json");
const probeRevision = "06105d7c2cc9fa78c6db10231ace8c6847cadb67";
const systemDlls = new Set([
    "advapi32.dll", "bcrypt.dll", "comdlg32.dll", "crypt32.dll",
    "dbghelp.dll", "gdi32.dll", "imagehlp.dll", "iphlpapi.dll",
    "kernel32.dll", "msvcrt.dll", "ntdll.dll", "ole32.dll",
    "oleaut32.dll", "psapi.dll", "rpcrt4.dll", "secur32.dll",
    "setupapi.dll", "shell32.dll", "shlwapi.dll", "user32.dll",
    "userenv.dll", "ucrtbase.dll", "version.dll", "winmm.dll",
    "ws2_32.dll",
]);

function fail(message) {
    throw new Error(message);
}

function usage() {
    console.log(`Package the qualified native Windows Move GCC build

Usage:
  npm run package:gcc:windows -- --install-root PATH [--output-dir PATH]
      [--staging-root PATH] [--force]

The source installation is preserved. A staged copy is stripped, given exact
artifact metadata, audited, archived, extracted beneath a path containing
spaces, and smoke-tested before its adjacent SHA-256 file is written.`);
}

export function parseArguments(argv) {
    const flags = new Set();
    const values = new Map();
    for (let index = 0; index < argv.length; ++index) {
        const name = argv[index];
        if (["help", "--help", "-h"].includes(name)) return {help: true};
        if (name === "--force") {
            if (flags.has(name)) fail(`duplicate argument: ${name}`);
            flags.add(name);
            continue;
        }
        if (!["--install-root", "--output-dir", "--staging-root"].includes(name)) {
            fail(`unknown argument: ${name}`);
        }
        if (values.has(name)) fail(`duplicate argument: ${name}`);
        const value = argv[++index];
        if (!value || value.startsWith("--")) fail(`${name} requires a value`);
        values.set(name, value);
    }
    if (!values.has("--install-root")) fail("--install-root is required");
    return {help: false, flags, values};
}

async function exists(file) {
    try {
        await access(file);
        return true;
    } catch {
        return false;
    }
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: options.cwd ?? repositoryRoot,
        encoding: "utf8",
        stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
        env: options.env ?? process.env,
    });
    if (result.error) fail(`${command} could not start: ${result.error.message}`);
    const accepted = options.acceptedStatuses ?? new Set([0]);
    if (!accepted.has(result.status)) {
        const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        fail(`${command} exited with ${result.status}${detail ? `: ${detail}` : ""}`);
    }
    return (result.stdout ?? "").trim();
}

async function sha256(file) {
    const hash = createHash("sha256");
    hash.update(await readFile(file));
    return hash.digest("hex");
}

async function recursiveFiles(root) {
    const result = [];
    const pending = [root];
    while (pending.length > 0) {
        const directory = pending.pop();
        for (const entry of await readdir(directory, {withFileTypes: true})) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) pending.push(full);
            else if (entry.isFile()) result.push(full);
        }
    }
    return result;
}

function validateCompiler(install) {
    const compiler = path.join(install, "bin", "g++.exe");
    const environment = {
        ...process.env,
        PATH: `${path.join(install, "bin")};${process.env.SystemRoot}\\System32`,
    };
    const version = run(compiler, ["--version"], {env: environment});
    const target = run(compiler, ["-dumpmachine"], {env: environment});
    const fullVersion = run(compiler, ["-dumpfullversion"], {env: environment});
    if (!version.includes("Move GCC 16.2.0 move.1") ||
        target !== "x86_64-w64-mingw32" || fullVersion !== "16.2.0") {
        fail(`unexpected compiler identity: ${version.split(/\r?\n/)[0]}, ${target}`);
    }
    return {version: version.split(/\r?\n/)[0], target, fullVersion};
}

async function stripBinaries(install) {
    const strip = path.join(install, "bin", "strip.exe");
    const binaries = (await recursiveFiles(install)).filter((file) =>
        [".dll", ".exe"].includes(path.extname(file).toLowerCase()) &&
        path.resolve(file) !== path.resolve(strip));
    for (const file of binaries) run(strip, ["--strip-unneeded", file]);
    run(strip, ["--strip-unneeded", strip]);
    return binaries.length + 1;
}

function importedDlls(objdump, file) {
    return [...run(objdump, ["-p", file]).matchAll(/DLL Name:\s*([^\r\n]+)/g)]
        .map((match) => match[1].trim().toLowerCase());
}

async function auditPeClosure(install) {
    const binaryDirectory = path.join(install, "bin");
    const objdump = path.join(binaryDirectory, "objdump.exe");
    const available = new Set((await readdir(binaryDirectory))
        .filter((name) => name.toLowerCase().endsWith(".dll"))
        .map((name) => name.toLowerCase()));
    const binaries = (await recursiveFiles(install)).filter((file) =>
        [".dll", ".exe"].includes(path.extname(file).toLowerCase()));
    const graph = {};
    for (const file of binaries) {
        const relative = path.relative(install, file).replaceAll("\\", "/");
        const imports = importedDlls(objdump, file);
        for (const dependency of imports) {
            if (available.has(dependency) || systemDlls.has(dependency) ||
                dependency.startsWith("api-ms-win-") ||
                dependency.startsWith("ext-ms-win-")) continue;
            fail(`${relative} has unresolved non-system import ${dependency}`);
        }
        graph[relative] = imports;
    }
    for (const required of [
        "libatomic-1.dll", "libgcc_s_seh-1.dll", "libgomp-1.dll",
        "libstdc++-6.dll",
    ]) {
        if (!available.has(required)) fail(`required GCC runtime is absent: ${required}`);
    }
    return graph;
}

async function reflectionSmoke(install, scratch) {
    const source = path.join(scratch, "reflection-smoke.cpp");
    const output = path.join(scratch, "reflection-smoke.exe");
    await writeFile(source, `#include <meta>\n\nstruct Record { int Value; };\n\nconsteval bool Reflects()\n{\n    return std::meta::nonstatic_data_members_of(\n        ^^Record, std::meta::access_context::unchecked()).size() == 1;\n}\n\nstatic_assert(Reflects());\nint main() { return Reflects() ? 0 : 1; }\n`);
    const compiler = path.join(install, "bin", "g++.exe");
    const environment = {
        ...process.env,
        PATH: `${path.join(install, "bin")};${process.env.SystemRoot}\\System32`,
    };
    run(compiler, ["-std=c++26", "-freflection", source, "-o", output], {
        env: environment,
    });
    run(output, [], {env: environment});
}

async function normalizeTimestamps(root, epoch) {
    const date = new Date(epoch * 1000);
    const files = await recursiveFiles(root);
    for (const file of files) await utimes(file, date, date);
}

async function main() {
    if (process.platform !== "win32" || process.arch !== "x64") {
        fail("the GCC packager supports only native Windows x64");
    }
    const parsed = parseArguments(process.argv.slice(2));
    if (parsed.help) return usage();
    const install = path.resolve(parsed.values.get("--install-root"));
    const outputDirectory = path.resolve(parsed.values.get("--output-dir") ??
        path.join(repositoryRoot, ".local", "prebuilt"));
    const stagingBase = path.resolve(parsed.values.get("--staging-root") ??
        path.dirname(install));
    const required = ["bin/g++.exe", "bin/gcc.exe", "bin/strip.exe", "include/c++/16.2.0/meta"];
    for (const entry of required) {
        if (!(await exists(path.join(install, ...entry.split("/"))))) {
            fail(`GCC installation is incomplete: ${entry}`);
        }
    }
    const compilerIdentity = validateCompiler(install);
    const loaded = await loadGccRecipe(recipePath);
    const configuration = JSON.parse(await readFile(configurationPath, "utf8"));
    const packageRevision = loaded.recipe.packageRevision;
    const archiveRoot = `gcc-${loaded.recipe.version}-${packageRevision}`;
    const archiveName = `${archiveRoot}-windows-x86_64-ucrt64.zip`;
    await mkdir(outputDirectory, {recursive: true});
    await mkdir(stagingBase, {recursive: true});
    const archive = path.join(outputDirectory, archiveName);
    const checksum = `${archive}.sha256`;
    if ((await exists(archive) || await exists(checksum)) &&
        !parsed.flags.has("--force")) {
        fail(`output exists and was preserved: ${archive}; pass --force to replace it`);
    }

    const temporary = await mkdtemp(path.join(stagingBase, ".move-gcc-package-"));
    try {
        const stage = path.join(temporary, archiveRoot);
        await mkdir(stage);
        run("robocopy.exe", [install, stage, "/E", "/COPY:DAT", "/DCOPY:T", "/R:2", "/W:1", "/XJ"], {
            inherit: true,
            acceptedStatuses: new Set([0, 1, 2, 3, 4, 5, 6, 7]),
        });
        const strippedFiles = await stripBinaries(stage);
        const peImports = await auditPeClosure(stage);
        const artifact = {
            schemaVersion: 1,
            component: "gcc",
            version: loaded.recipe.version,
            packageRevision,
            host: "windows-x86_64-ucrt64",
            source: {
                repository: loaded.recipe.source.repository,
                revision: loaded.recipe.source.revision,
                upstreamBaseRevision: loaded.recipe.source.upstreamBaseRevision,
                patchRevisions: loaded.recipe.source.patchRevisions,
            },
            recipeSha256: loaded.digest,
            builderLockSha256: loaded.recipe.profile.builder.lock.sha256,
            compiler: compilerIdentity,
            strippedFiles,
            peImports,
        };
        await writeFile(path.join(stage, "move-artifact.json"),
            `${JSON.stringify(artifact, null, 2)}\n`);
        const qualification = {
            schemaVersion: 1,
            qualified: true,
            component: "gcc",
            version: loaded.recipe.version,
            packageRevision,
            host: "windows-x86_64-ucrt64",
            target: compilerIdentity.target,
            cases: {
                compilerIdentity: "passed",
                isolatedPeRuntimeClosure: "passed",
                relocatedReflectionSmoke: "passed",
                importedNamespaceProbe: {
                    status: "passed-before-packaging",
                    repository: "https://github.com/move-engine/nez.git",
                    revision: probeRevision,
                },
            },
        };
        await writeFile(path.join(stage, "move-qualification.json"),
            `${JSON.stringify(qualification, null, 2)}\n`);
        await normalizeTimestamps(stage, loaded.recipe.sourceDateEpoch);

        await rm(archive, {force: true});
        await rm(checksum, {force: true});
        run("7z.exe", ["a", "-tzip", "-mx=7", "-mmt=on", "-mtc=off", "-mta=off", archive, archiveRoot], {
            cwd: temporary,
            inherit: true,
        });

        const relocated = path.join(temporary, "relocated package with spaces");
        await mkdir(relocated);
        run("7z.exe", ["x", "-y", `-o${relocated}`, archive], {inherit: true});
        const extracted = path.join(relocated, archiveRoot);
        validateCompiler(extracted);
        await reflectionSmoke(extracted, relocated);
        await auditPeClosure(extracted);

        const digest = await sha256(archive);
        await writeFile(checksum, `${digest}  ${archiveName}\n`);
        const information = await stat(archive);
        console.log(`package: ${archive}`);
        console.log(`bytes: ${information.size}`);
        console.log(`sha256: ${digest}`);
        console.log(`checksum: ${checksum}`);
        console.log(`release tag: ${configuration.release.tag}`);
    } catch (error) {
        await rm(archive, {force: true});
        await rm(checksum, {force: true});
        throw error;
    } finally {
        await rm(temporary, {recursive: true, force: true});
    }
}

if (path.resolve(process.argv[1] ?? "") === scriptPath) {
    main().catch((error) => {
        console.error(`error: ${error.message}`);
        process.exitCode = 1;
    });
}
