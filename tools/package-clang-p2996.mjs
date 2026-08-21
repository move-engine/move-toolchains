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
import {existingBuildCacheErrors} from "./reflection/existing-build.mjs";
import {
    canonicalJson,
    verifyBuildReceipt,
    writeBuildReceipt,
} from "./build-receipt.mjs";
import {
    clangReceiptInput,
    clangSourceIdentity,
    clangToolsPackageRevision,
    clangToolsVersion,
} from "./clang-build-receipt.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const reflectionDirectory = path.join(repositoryRoot, "tools", "reflection");
const bootstrapPath = path.join(reflectionDirectory, "bootstrap.mjs");
const configurationPath = path.join(repositoryRoot, "toolchains.json");
const systemDlls = new Set([
    "advapi32.dll", "bcrypt.dll", "comdlg32.dll", "crypt32.dll",
    "dbghelp.dll", "gdi32.dll", "imagehlp.dll", "iphlpapi.dll",
    "kernel32.dll", "ntdll.dll", "ole32.dll", "oleaut32.dll",
    "psapi.dll", "rpcrt4.dll", "secur32.dll", "setupapi.dll",
    "shell32.dll", "shlwapi.dll", "user32.dll", "userenv.dll",
    "ucrtbase.dll", "version.dll", "winmm.dll", "ws2_32.dll",
]);

function fail(message) {
    throw new Error(message);
}

function usage() {
    console.log(`Package a qualified Windows clang-p2996 build

Usage:
  npm run package:clang-p2996 -- [--root PATH] [--output-dir PATH]
      --source-root PATH --build-root PATH --nez-root PATH
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
        "--source-root", "--build-root", "--nez-root",
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
    for (const required of ["--source-root", "--build-root", "--nez-root"]) {
        if (!values.has(required)) fail(`${required} is required`);
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
        maxBuffer: 256 * 1024 * 1024,
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

async function recursiveFiles(root) {
    const files = [];
    const pending = [root];
    while (pending.length) {
        const directory = pending.pop();
        for (const entry of await readdir(directory, {withFileTypes: true})) {
            const candidate = path.join(directory, entry.name);
            if (entry.isDirectory()) pending.push(candidate);
            else if (entry.isFile()) files.push(candidate);
        }
    }
    return files;
}

async function auditPeRuntime(install, objdump) {
    const bin = path.join(install, "bin");
    const available = new Set((await readdir(bin))
        .filter((name) => name.toLowerCase().endsWith(".dll"))
        .map((name) => name.toLowerCase()));
    const graph = {};
    for (const file of (await recursiveFiles(bin)).filter((candidate) =>
        [".dll", ".exe"].includes(path.extname(candidate).toLowerCase()))) {
        const relative = path.relative(install, file).replaceAll("\\", "/");
        const imports = [...run(objdump, ["-p", file])
            .matchAll(/DLL Name:\s*([^\r\n]+)/g)]
            .map((match) => match[1].trim().toLowerCase());
        for (const dependency of imports) {
            if (available.has(dependency) || systemDlls.has(dependency) ||
                dependency.startsWith("api-ms-win-") ||
                dependency.startsWith("ext-ms-win-")) continue;
            fail(`${relative} has unresolved non-system import ${dependency}`);
        }
        graph[relative] = imports;
    }
    return graph;
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
    const sourceRoot = path.resolve(values.get("--source-root"));
    const buildRoot = path.resolve(values.get("--build-root"));
    const nezRoot = path.resolve(values.get("--nez-root"));
    const configuration = JSON.parse(await readFile(configurationPath, "utf8"));
    const rawReflection = configuration.components?.clangTools ??
        configuration.components?.["clang-p2996"];
    const reflection = rawReflection ? {
        ...rawReflection,
        revision: rawReflection.revision ?? rawReflection.source?.revision,
    } : null;
    if (!reflection || !/^[0-9a-f]{40}$/.test(reflection.revision)) {
        fail("invalid pinned clang-p2996 configuration");
    }
    const revision = reflection.revision;
    if (revision !== clangSourceIdentity.revision ||
        run("git", ["-c", `safe.directory=${sourceRoot.replaceAll("\\", "/")}`,
            "-C", sourceRoot, "rev-parse", "HEAD"]) !== revision ||
        run("git", ["-c", `safe.directory=${sourceRoot.replaceAll("\\", "/")}`,
            "-C", sourceRoot, "status", "--porcelain", "--untracked-files=all"])) {
        fail("clang source is not the exact clean pinned revision");
    }
    const sourceTree = run("git", ["-c",
        `safe.directory=${sourceRoot.replaceAll("\\", "/")}`,
        "-C", sourceRoot, "write-tree"]);
    const cache = await readFile(path.join(buildRoot, "CMakeCache.txt"), "utf8");
    const cacheErrors = existingBuildCacheErrors(
        reflection.hosts["win32-x64"], sourceRoot, cache);
    if (cacheErrors.length) fail(
        `clang build cache is not the pinned Windows Release profile:\n${cacheErrors.join("\n")}`);
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
    const evidenceFile = `${archive}.evidence.json`;
    if ((await exists(archive) || await exists(checksumFile) ||
        await exists(evidenceFile)) && !flags.has("--force")) {
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
        await rm(path.join(stagedInstall, "move-smoke"), {
            recursive: true, force: true,
        });
        const runtimeDirectory = await findVcRuntime(values.get("--vc-runtime-dir"));
        const runtimeFiles = await copyVcRuntime(
            runtimeDirectory, path.join(stagedInstall, "bin"));
        const peImports = await auditPeRuntime(stagedInstall,
            path.join(ucrt64Root, "bin", "objdump.exe"));
        const artifactMetadata = {
            schemaVersion: 1,
            component: "clang-p2996",
            revision,
            host: "windows-x86_64",
            qualificationKind: "language-server",
            vcRuntimeVersion: path.basename(
                path.dirname(path.dirname(runtimeDirectory))),
            vcRuntimeFiles: runtimeFiles,
            peImports,
            requirements: {
                ucrt64Gcc: reflection.hosts["win32-x64"].gccVersion,
                gccTarget: reflection.hosts["win32-x64"].gccTarget,
                clangTarget: reflection.hosts["win32-x64"].clangTarget,
            },
        };
        await writeFile(path.join(stagedInstall, "move-artifact.json"),
            `${JSON.stringify(artifactMetadata, null, 2)}\n`);

        run(process.execPath, [path.join(
            nezRoot, "tools", "reflection", "compdb_test.mjs")]);
        const profile = "windows-x86_64-ucrt64";
        const receiptInput = clangReceiptInput({
            profile,
            builderIdentity: "MSVC 2022 Release builder",
            bootstrapVersion: cache.match(
                /^CMAKE_CXX_COMPILER_VERSION:STRING=(.+)$/m)?.[1] ??
                "MSVC version recorded by the pinned Release build",
            configuration: reflection.hosts["win32-x64"].configuration,
            installTargets: reflection.hosts["win32-x64"].installTargets,
            environment: {},
            sourceTree,
        });
        const writtenReceipt = await writeBuildReceipt(
            stagedInstall, receiptInput);

        const executable = path.join(stagedInstall, "bin", "clangd.exe");
        run(executable, ["--version"], {
            env: {
                ...process.env,
                PATH: `${path.dirname(executable)};${process.env.PATH ?? ""}`,
            },
        });
        await rm(archive, {force: true});
        await rm(checksumFile, {force: true});
        await rm(evidenceFile, {force: true});
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
        const extractedInstall = path.join(
            extracted, "clang-p2996", revision, "install");
        const extractedReceipt = await verifyBuildReceipt(extractedInstall);
        if (extractedReceipt.sha256 !== writtenReceipt.sha256) {
            fail("relocated clang receipt changed after archiving");
        }
        const information = await stat(archive);
        await writeFile(evidenceFile, canonicalJson({
            schemaVersion: 1,
            component: "clangTools",
            profile,
            artifact: {file: archiveName, bytes: information.size, sha256: digest},
            receipt: {
                file: "move-build-receipt.json",
                sha256: writtenReceipt.sha256,
                installedTreeDigest: writtenReceipt.receipt.installedTree.digest,
            },
            cases: [
                {id: "archive-checksum", status: "passed"},
                {id: "archive-relocation-path-with-spaces", status: "passed"},
                {id: "archive-runtime-closure", status: "passed"},
                {id: "archive-reflection-and-modules", status: "passed"},
            ],
            componentIdentity: {
                version: clangToolsVersion,
                packageRevision: clangToolsPackageRevision,
            },
        }));
        console.log(`package: ${archive}`);
        console.log(`bytes: ${information.size}`);
        console.log(`sha256: ${digest}`);
        console.log(`checksum: ${checksumFile}`);
        console.log(`evidence: ${evidenceFile}`);
    } catch (error) {
        await rm(archive, {force: true});
        await rm(checksumFile, {force: true});
        await rm(evidenceFile, {force: true});
        throw error;
    } finally {
        await rm(temporary, {recursive: true, force: true});
    }
}

main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
});
