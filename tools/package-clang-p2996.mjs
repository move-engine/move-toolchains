#!/usr/bin/env node

import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {
    access,
    copyFile,
    cp,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const reflectionDirectory = path.join(repositoryRoot, "tools", "reflection");
const bootstrapPath = path.join(reflectionDirectory, "bootstrap.mjs");
const configurationPath = path.join(repositoryRoot, "toolchains.json");

function fail(message) {
    throw new Error(message);
}

function usage() {
    console.log(`Package a qualified Windows clang-p2996 build

Usage:
  node tools/package-clang-p2996.mjs [--root PATH] [--output-dir PATH]
      [--ucrt64-root PATH] [--vc-runtime-dir PATH] [--force]

The package is assembled from ROOT/clang-p2996/<revision>/install, receives the
Microsoft VC runtime's application-local DLL set, is archived, extracted to a
new path, and requalified through the pinned bootstrap before publication.`);
}

function parseArguments(argv) {
    const flags = new Set();
    const values = new Map();
    const flagNames = new Set(["--force"]);
    const valueNames = new Set([
        "--root", "--output-dir", "--ucrt64-root", "--vc-runtime-dir",
    ]);
    for (let index = 0; index < argv.length; ++index) {
        const name = argv[index];
        if (["help", "--help", "-h"].includes(name)) return {help: true};
        if (flagNames.has(name)) {
            if (flags.has(name)) fail(`duplicate argument: ${name}`);
            flags.add(name);
            continue;
        }
        if (!valueNames.has(name)) fail(`unknown argument: ${name}`);
        if (values.has(name)) fail(`duplicate argument: ${name}`);
        const value = argv[++index];
        if (!value || value.startsWith("--")) fail(`${name} requires a value`);
        values.set(name, value);
    }
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
    if (result.status !== 0) {
        const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        fail(`${command} exited with ${result.status}${detail ? `: ${detail}` : ""}`);
    }
    return (result.stdout ?? "").trim();
}

function compareVersions(left, right) {
    const a = left.split(".").map(Number);
    const b = right.split(".").map(Number);
    for (let index = 0; index < Math.max(a.length, b.length); ++index) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);
        if (difference !== 0) return difference;
    }
    return 0;
}

async function findVcRuntime(explicit) {
    if (explicit) {
        const resolved = path.resolve(explicit);
        if (!(await exists(resolved))) fail(`VC runtime directory is absent: ${resolved}`);
        return resolved;
    }
    const vswhere = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
    if (!(await exists(vswhere))) {
        fail("Visual Studio discovery is unavailable; pass --vc-runtime-dir");
    }
    const installation = run(vswhere, [
        "-latest", "-products", "*", "-property", "installationPath",
    ]).split(/\r?\n/)[0];
    if (!installation) fail("Visual Studio discovery returned no installation");
    const redistRoot = path.join(installation, "VC", "Redist", "MSVC");
    const versions = (await readdir(redistRoot, {withFileTypes: true}))
        .filter((entry) => entry.isDirectory() && /^\d+(\.\d+)+$/.test(entry.name))
        .map((entry) => entry.name).sort(compareVersions).reverse();
    for (const version of versions) {
        const candidate = path.join(
            redistRoot, version, "x64", "Microsoft.VC143.CRT");
        if (await exists(candidate)) return candidate;
    }
    fail(`no x64 Microsoft.VC143.CRT directory was found beneath ${redistRoot}`);
}

async function sha256(file) {
    return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function copyVcRuntime(runtimeDirectory, binaryDirectory) {
    const files = (await readdir(runtimeDirectory, {withFileTypes: true}))
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".dll"));
    if (files.length === 0) fail(`VC runtime has no DLLs: ${runtimeDirectory}`);
    for (const file of files) {
        await copyFile(
            path.join(runtimeDirectory, file.name),
            path.join(binaryDirectory, file.name));
    }
    return files.map((entry) => entry.name).sort();
}

async function main() {
    if (process.platform !== "win32" || process.arch !== "x64") {
        fail("the v1 packager currently supports only native Windows x64");
    }
    const parsed = parseArguments(process.argv.slice(2));
    if (parsed.help) {
        usage();
        return;
    }
    const {flags, values} = parsed;
    const root = path.resolve(values.get("--root") ??
        path.join(repositoryRoot, ".local", "toolchains"));
    const outputDirectory = path.resolve(values.get("--output-dir") ??
        path.join(repositoryRoot, ".local", "prebuilt"));
    const ucrt64Root = path.resolve(values.get("--ucrt64-root") ??
        "C:\\msys64\\ucrt64");
    const configuration = JSON.parse(await readFile(configurationPath, "utf8"));
    const reflection = configuration.components?.["clang-p2996"];
    if (!reflection || !/^[0-9a-f]{40}$/.test(reflection.revision)) {
        fail("invalid pinned clang-p2996 configuration");
    }
    const revision = reflection.revision;
    const sourceInstall = path.join(root, "clang-p2996", revision, "install");
    const markerPath = path.join(sourceInstall, "move-qualification.json");
    if (!(await exists(path.join(sourceInstall, "bin", "clangd.exe"))) ||
        !(await exists(markerPath))) {
        fail(`qualified clang-p2996 installation is missing: ${sourceInstall}`);
    }
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    if (marker.qualified !== true || marker.host !== "win32-x64" ||
        marker.revision !== revision || marker.qualificationKind !== "language-server") {
        fail("the source installation has no matching Windows qualification marker");
    }

    await mkdir(outputDirectory, {recursive: true});
    const shortRevision = revision.slice(0, 8);
    const archiveName = `clangd-p2996-${shortRevision}-windows-x86_64.zip`;
    const archive = path.join(outputDirectory, archiveName);
    const checksumFile = `${archive}.sha256`;
    if ((await exists(archive) || await exists(checksumFile)) && !flags.has("--force")) {
        fail(`output exists and was preserved: ${archive}; pass --force to replace it`);
    }

    const temporary = await mkdtemp(path.join(tmpdir(), "move-clang-package-"));
    try {
        const archiveTree = path.join(temporary, "archive");
        const stagedInstall = path.join(
            archiveTree, "clang-p2996", revision, "install");
        await mkdir(path.dirname(stagedInstall), {recursive: true});
        await cp(sourceInstall, stagedInstall, {
            recursive: true,
            preserveTimestamps: true,
        });
        const runtimeDirectory = await findVcRuntime(values.get("--vc-runtime-dir"));
        const runtimeFiles = await copyVcRuntime(
            runtimeDirectory, path.join(stagedInstall, "bin"));
        const artifactMetadata = {
            schemaVersion: 1,
            component: "clang-p2996",
            revision,
            host: "windows-x86_64",
            qualificationKind: "language-server",
            vcRuntimeVersion: path.basename(
                path.dirname(path.dirname(runtimeDirectory))),
            vcRuntimeFiles: runtimeFiles,
            requirements: {
                ucrt64Gcc: reflection.hosts["win32-x64"].gccVersion,
                gccTarget: reflection.hosts["win32-x64"].gccTarget,
                clangTarget: reflection.hosts["win32-x64"].clangTarget,
            },
        };
        await writeFile(path.join(stagedInstall, "move-artifact.json"),
            `${JSON.stringify(artifactMetadata, null, 2)}\n`);

        const executable = path.join(stagedInstall, "bin", "clangd.exe");
        run(executable, ["--version"], {
            env: {
                ...process.env,
                PATH: `${path.dirname(executable)};${process.env.PATH ?? ""}`,
            },
        });
        await rm(archive, {force: true});
        await rm(checksumFile, {force: true});
        run("tar", ["-a", "-cf", archive, "-C", archiveTree, "clang-p2996"]);
        const digest = await sha256(archive);
        await writeFile(checksumFile, `${digest}  ${archiveName}\n`);

        const extracted = path.join(temporary, "extracted");
        await mkdir(extracted, {recursive: true});
        run("tar", ["-xf", archive, "-C", extracted]);
        run(process.execPath, [
            bootstrapPath,
            "adopt",
            "--accept-prebuilt",
            "--root", extracted,
            "--ucrt64-root", ucrt64Root,
        ], {inherit: true});
        const information = await stat(archive);
        console.log(`package: ${archive}`);
        console.log(`bytes: ${information.size}`);
        console.log(`sha256: ${digest}`);
        console.log(`checksum: ${checksumFile}`);
    } catch (error) {
        await rm(archive, {force: true});
        await rm(checksumFile, {force: true});
        throw error;
    } finally {
        await rm(temporary, {recursive: true, force: true});
    }
}

main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
});
