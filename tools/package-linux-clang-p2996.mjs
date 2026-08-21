#!/usr/bin/env node

import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {createReadStream} from "node:fs";
import {
    access,
    cp,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    realpath,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {auditElfTree} from "./elf-compatibility.mjs";
import {detectLinuxLibc} from "./host-compatibility.mjs";
import {existingBuildCacheErrors} from "./reflection/existing-build.mjs";
import {
    canonicalJson,
    verifyBuildReceipt,
    writeBuildReceipt,
} from "./build-receipt.mjs";
import {validateReceiptIdentity} from "./artifact-contract.mjs";
import {
    clangReceiptInput,
    clangSourceIdentity,
    clangToolsPackageRevision,
    clangToolsVersion,
} from "./clang-build-receipt.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const bootstrapPath = path.join(
    repositoryRoot, "tools", "reflection", "bootstrap.mjs");
const configurationPath = path.join(repositoryRoot, "toolchains.json");

function fail(message) {
    throw new Error(message);
}

function usage() {
    console.log(`Package a qualified Linux clang-p2996 build

Usage:
  npm run package:clang-p2996:linux -- --root PATH --source-root PATH
      --build-root PATH --nez-root PATH --gcc-archive PATH [--output-dir PATH]
      --minimum-glibc VERSION --build-image ID [--force]

The package is assembled from ROOT/clang-p2996/<revision>/install. Every ELF
executable and shared library is audited against the declared glibc floor,
then the archive is extracted under a different path containing spaces and
requalified through the pinned bootstrap.`);
}

function parseArguments(argv) {
    const flags = new Set();
    const values = new Map();
    for (let index = 0; index < argv.length; ++index) {
        const name = argv[index];
        if (["help", "--help", "-h"].includes(name)) return {help: true};
        if (name === "--force") {
            flags.add(name);
            continue;
        }
        if (!["--root", "--output-dir", "--minimum-glibc", "--build-image",
            "--source-root", "--build-root", "--nez-root", "--gcc-archive"]
            .includes(name)) {
            fail(`unknown argument: ${name}`);
        }
        const value = argv[++index];
        if (!value || value.startsWith("--")) fail(`${name} requires a value`);
        values.set(name, value);
    }
    for (const required of ["--root", "--minimum-glibc", "--build-image",
        "--source-root", "--build-root", "--nez-root", "--gcc-archive"]) {
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
    });
    if (result.error) fail(`${command} could not start: ${result.error.message}`);
    if (result.status !== 0) {
        const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        fail(`${command} exited with ${result.status}${detail ? `: ${detail}` : ""}`);
    }
    return (result.stdout ?? "").trim();
}

async function sha256(file) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest("hex");
}

function firstLine(value) {
    return value.split(/\r?\n/)[0];
}

function parseOsRelease(text) {
    const values = {};
    for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^([A-Z_]+)=(.*)$/);
        if (!match) continue;
        values[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
    return values;
}

async function makeRuntimeLibrariesRelocatable(install) {
    const canonicalInstall = await realpath(install);
    const root = path.join(install, "lib");
    const candidates = [root];
    for (const entry of await readdir(root, {withFileTypes: true})) {
        if (entry.isDirectory()) candidates.push(path.join(root, entry.name));
    }
    const names = ["libc++.so.1", "libc++abi.so.1", "libunwind.so.1"];
    let runtimeDirectory = null;
    for (const candidate of candidates) {
        if ((await Promise.all(names.map(
            (name) => exists(path.join(candidate, name))))).every(Boolean)) {
            runtimeDirectory = candidate;
            break;
        }
    }
    if (!runtimeDirectory) {
        fail("installed libc++, libc++abi, and libunwind shared libraries were not found together");
    }
    const patched = new Set();
    for (const name of names) {
        const library = await realpath(path.join(runtimeDirectory, name));
        const relative = path.relative(canonicalInstall, library);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)) {
            fail(`runtime symlink escaped the packaged installation: ${library}`);
        }
        if (patched.has(library)) continue;
        run("patchelf", ["--set-rpath", "$ORIGIN", library]);
        if (run("patchelf", ["--print-rpath", library]) !== "$ORIGIN") {
            fail(`failed to set a relative runtime search path on ${library}`);
        }
        patched.add(library);
    }
}

async function qualifyInstall(install, root, revision, maximumGlibc) {
    const binary = (name) => path.join(install, "bin", name);
    const versions = {
        clang: firstLine(run(binary("clang"), ["--version"])),
        clangxx: firstLine(run(binary("clang++"), ["--version"])),
        clangd: firstLine(run(binary("clangd"), ["--version"])),
    };
    const audit = await auditElfTree(install, maximumGlibc);
    run(process.execPath, [
        bootstrapPath, "adopt", "--accept-prebuilt", "--root", root,
    ], {inherit: true});
    const marker = JSON.parse(await readFile(
        path.join(install, "move-qualification.json"), "utf8"));
    if (marker.qualified !== true || marker.host !== "linux-x64" ||
        marker.revision !== revision ||
        marker.qualificationKind !== "full-toolchain") {
        fail("relocated installation did not retain full Linux qualification");
    }
    return {versions, audit};
}

async function main() {
    if (process.platform !== "linux" || process.arch !== "x64") {
        fail("Linux clang-p2996 packaging requires native Linux x64");
    }
    const parsed = parseArguments(process.argv.slice(2));
    if (parsed.help) {
        usage();
        return;
    }
    const {flags, values} = parsed;
    const root = path.resolve(values.get("--root") ??
        path.join(repositoryRoot, ".local", "toolchains"));
    const sourceRoot = path.resolve(values.get("--source-root"));
    const buildRoot = path.resolve(values.get("--build-root"));
    const nezRoot = path.resolve(values.get("--nez-root"));
    const gccArchive = path.resolve(values.get("--gcc-archive"));
    const outputDirectory = path.resolve(values.get("--output-dir") ??
        path.join(repositoryRoot, ".local", "prebuilt"));
    const maximumGlibc = values.get("--minimum-glibc");
    if (!/^\d+(?:\.\d+)+$/.test(maximumGlibc ?? "")) {
        fail("--minimum-glibc requires a dotted version");
    }
    const libc = detectLinuxLibc();
    const osRelease = parseOsRelease(await readFile("/etc/os-release", "utf8"));
    const requiredDistribution = {
        "2.35": "22.04",
        "2.38": "23.10",
    }[maximumGlibc];
    if (!requiredDistribution || libc.family !== "glibc" ||
        libc.version !== maximumGlibc || osRelease.ID !== "ubuntu" ||
        osRelease.VERSION_ID !== requiredDistribution) {
        fail(
            `packaging requires Ubuntu ${requiredDistribution ?? "unsupported"}/` +
            `glibc ${maximumGlibc}; found ` +
            `${osRelease.ID ?? "unknown"} ${osRelease.VERSION_ID ?? "unknown"}/` +
            `${libc.family} ${libc.version ?? "unknown"}`);
    }
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
    const profile = `linux-x86_64-glibc${maximumGlibc}`;
    const gccArtifact = configuration.artifacts?.find(candidate =>
        candidate.component === "gcc" && candidate.profile === profile);
    if (!gccArtifact || path.basename(gccArchive) !== gccArtifact.file ||
        await sha256(gccArchive) !== gccArtifact.sha256) {
        fail(`--gcc-archive is not the exact paired GCC artifact for ${profile}`);
    }
    if (revision !== clangSourceIdentity.revision ||
        run("git", ["-C", sourceRoot, "rev-parse", "HEAD"]) !== revision ||
        run("git", ["-C", sourceRoot, "status", "--porcelain",
            "--untracked-files=all"])) {
        fail("clang source is not the exact clean pinned revision");
    }
    const sourceTree = run("git", ["-C", sourceRoot, "write-tree"]);
    const cache = await readFile(path.join(buildRoot, "CMakeCache.txt"), "utf8");
    const cacheErrors = existingBuildCacheErrors(
        reflection.hosts["linux-x64"], sourceRoot, cache);
    if (cacheErrors.length) fail(
        `clang build cache is not the pinned Linux Release profile:\n${cacheErrors.join("\n")}`);
    const sourceInstall = path.join(root, "clang-p2996", revision, "install");
    const marker = JSON.parse(await readFile(
        path.join(sourceInstall, "move-qualification.json"), "utf8"));
    if (marker.qualified !== true || marker.host !== "linux-x64" ||
        marker.revision !== revision ||
        marker.qualificationKind !== "full-toolchain") {
        fail("the source installation has no matching Linux qualification marker");
    }
    await mkdir(outputDirectory, {recursive: true});
    const archiveName = `clangd-p2996-${revision.slice(0, 8)}-linux-x86_64-glibc${maximumGlibc}.tar.gz`;
    const archive = path.join(outputDirectory, archiveName);
    const checksumFile = `${archive}.sha256`;
    const evidenceFile = `${archive}.evidence.json`;
    if ((await exists(archive) || await exists(checksumFile) ||
        await exists(evidenceFile)) &&
        !flags.has("--force")) {
        fail(`output exists and was preserved: ${archive}; pass --force to replace it`);
    }

    const temporary = await mkdtemp(path.join(tmpdir(), "move clang package-"));
    try {
        const archiveTree = path.join(temporary, "archive");
        const stagedInstall = path.join(
            archiveTree, "clang-p2996", revision, "install");
        await mkdir(path.dirname(stagedInstall), {recursive: true});
        await cp(sourceInstall, stagedInstall, {
            recursive: true,
            preserveTimestamps: true,
            verbatimSymlinks: true,
        });
        // Qualification regenerates this workspace after extraction. Its
        // executable is host evidence, not part of the portable toolchain.
        await rm(path.join(stagedInstall, "move-smoke"), {
            recursive: true, force: true,
        });
        const pairedGccRoot = path.join(temporary, "paired-gcc");
        await mkdir(pairedGccRoot, {recursive: true});
        run("tar", ["-xzf", gccArchive, "-C", pairedGccRoot]);
        const pairedGccInstall = path.join(
            pairedGccRoot, ...gccArtifact.archiveRoot.split("/"));
        const pairedGccReceipt = await verifyBuildReceipt(pairedGccInstall);
        validateReceiptIdentity(
            pairedGccReceipt.receipt, gccArtifact, configuration);
        if (pairedGccReceipt.sha256 !== gccArtifact.receipt.sha256) {
            fail("paired GCC embedded receipt digest disagrees with toolchains.json");
        }
        const libgcc = path.join(pairedGccInstall, "lib64", "libgcc_s.so.1");
        if (!await exists(libgcc)) {
            fail("paired GCC archive does not contain lib64/libgcc_s.so.1");
        }
        await cp(libgcc, path.join(stagedInstall, "lib", "libgcc_s.so.1"), {
            preserveTimestamps: true,
        });
        await makeRuntimeLibrariesRelocatable(stagedInstall);
        const audit = await auditElfTree(stagedInstall, maximumGlibc);
        const metadata = {
            schemaVersion: 1,
            component: "clang-p2996",
            revision,
            host: `linux-x86_64-glibc${maximumGlibc}`,
            qualificationKind: "full-toolchain",
            buildEnvironment: {
                distribution: `${osRelease.ID} ${osRelease.VERSION_ID}`,
                glibc: libc.version,
                image: values.get("--build-image") ?? null,
            },
            requirements: {
                architecture: "x86-64-baseline",
                minimumGlibc: maximumGlibc,
            },
            elfAudit: {
                elfCount: audit.elfCount,
                newestRequiredGlibc: audit.newestRequiredGlibc,
            },
        };
        await writeFile(path.join(stagedInstall, "move-artifact.json"),
            `${JSON.stringify(metadata, null, 2)}\n`);
        run(process.execPath, [path.join(
            nezRoot, "tools", "reflection", "compdb_test.mjs")]);
        const receiptInput = clangReceiptInput({
            profile,
            builderIdentity: values.get("--build-image"),
            bootstrapVersion: run("c++", ["--version"]).split(/\r?\n/)[0],
            configuration: reflection.hosts["linux-x64"].configuration,
            installTargets: reflection.hosts["linux-x64"].installTargets,
            environment: {},
            sourceTree,
            runtimeDependency: {
                id: "paired-move-gcc-runtime",
                kind: "archive",
                file: gccArtifact.file,
                source: `https://github.com/move-engine/move-toolchains/releases/download/${configuration.release.tag}/${gccArtifact.file}`,
                version: `${configuration.components.gcc.version}-${configuration.components.gcc.packageRevision}`,
                checksum: {algorithm: "sha256", digest: gccArtifact.sha256},
            },
        });
        const writtenReceipt = await writeBuildReceipt(
            stagedInstall, receiptInput);

        await rm(archive, {force: true});
        await rm(checksumFile, {force: true});
        await rm(evidenceFile, {force: true});
        run("tar", ["-czf", archive, "-C", archiveTree, "clang-p2996"]);
        const digest = await sha256(archive);
        await writeFile(checksumFile, `${digest}  ${archiveName}\n`);

        const relocatedRoot = path.join(temporary, "relocated package with spaces");
        await mkdir(relocatedRoot, {recursive: true});
        run("tar", ["-xzf", archive, "-C", relocatedRoot]);
        const relocatedInstall = path.join(
            relocatedRoot, "clang-p2996", revision, "install");
        const qualified = await qualifyInstall(
            relocatedInstall, relocatedRoot, revision, maximumGlibc);
        const relocatedReceipt = await verifyBuildReceipt(relocatedInstall);
        if (relocatedReceipt.sha256 !== writtenReceipt.sha256) {
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
                {id: "archive-reflection-runtime", status: "passed"},
            ],
            componentIdentity: {
                version: clangToolsVersion,
                packageRevision: clangToolsPackageRevision,
            },
        }));
        console.log(`package: ${archive}`);
        console.log(`bytes: ${information.size}`);
        console.log(`sha256: ${digest}`);
        console.log(`ELF files: ${qualified.audit.elfCount}`);
        console.log(`newest required glibc: ${qualified.audit.newestRequiredGlibc}`);
        console.log(`clang: ${qualified.versions.clang}`);
        console.log(`clang++: ${qualified.versions.clangxx}`);
        console.log(`clangd: ${qualified.versions.clangd}`);
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
