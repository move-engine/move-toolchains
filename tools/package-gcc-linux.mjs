#!/usr/bin/env node

import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {createReadStream} from "node:fs";
import {
    access, copyFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile,
} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {detectLinuxLibc} from "./host-compatibility.mjs";
import {normalizeLinuxGccRuntime} from "./gcc-linux-runtime.mjs";
import {qualifyLinuxGcc} from "./qualify-gcc-linux.mjs";
import {
    canonicalJson,
    sha256Bytes,
    verifyBuildReceipt,
    writeBuildReceipt,
} from "./build-receipt.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const revision = "ced2ae7f6670c0371e0464e5aaa888c44ebd012a";
const tree = "57f5cc6c172e3e3e08a66c4f1efcf032c84c0b65";
const version = "16.2.0";
const packageRevision = "move.1";
const probeRevision = "06105d7c2cc9fa78c6db10231ace8c6847cadb67";
const probeTree = "bfe086d87ff2c5c84d4c899b497e7a704e7e85f1";
const upstreamBaseRevision = "78d4ac73dd391005b895a6148cd9831e28e1208b";
const sourceDateEpoch = 1787208838;
const configureArguments = Object.freeze([
    "--prefix=@install@",
    "--build=x86_64-pc-linux-gnu",
    "--host=x86_64-pc-linux-gnu",
    "--target=x86_64-pc-linux-gnu",
    "--enable-bootstrap",
    "--enable-checking=release",
    "--with-arch=x86-64",
    "--with-tune=generic",
    "--enable-languages=c,c++,lto",
    "--enable-lto",
    "--enable-shared",
    "--enable-static",
    "--enable-libatomic",
    "--enable-threads=posix",
    "--enable-tls",
    "--enable-graphite",
    "--enable-libstdcxx-backtrace=yes",
    "--enable-libstdcxx-filesystem-ts",
    "--enable-libstdcxx-time",
    "--enable-libgomp",
    "--disable-multilib",
    "--disable-nls",
    "--disable-werror",
    "--with-system-zlib",
    "--with-pkgversion=Move GCC 16.2.0 move.1",
    "--with-bugurl=https://github.com/move-engine/gcc/issues",
    "--with-boot-ldflags=-static-libstdc++ -static-libgcc",
    "--with-stage1-ldflags=-static-libstdc++ -static-libgcc",
]);

function fail(message) { throw new Error(message); }

function usage() {
    console.log(`Package a qualified Linux Move GCC build

Usage:
  npm run package:gcc:linux -- --install-root PATH --source-root PATH
      --minimum-glibc VERSION --probe-root PATH --xmake PATH
      --build-image IMAGE [--jobs N]
      [--output-dir PATH] [--staging-root PATH] [--force]

The build installation is preserved. A staged copy receives an isolated,
relative ELF runtime closure, is qualified, archived deterministically, then
extracted beneath a path containing spaces and qualified again.`);
}

export function parseArguments(argv) {
    const values = new Map();
    const flags = new Set();
    for (let index = 0; index < argv.length; ++index) {
        const name = argv[index];
        if (["--help", "-h"].includes(name)) return {help: true, values, flags};
        if (name === "--force") {
            if (flags.has(name)) fail(`duplicate argument: ${name}`);
            flags.add(name);
            continue;
        }
        if (!["--install-root", "--source-root", "--minimum-glibc",
            "--probe-root", "--xmake", "--build-image", "--jobs",
            "--output-dir", "--staging-root"]
            .includes(name)) fail(`unknown argument: ${name}`);
        if (values.has(name)) fail(`duplicate argument: ${name}`);
        const value = argv[++index];
        if (!value || value.startsWith("--")) fail(`${name} requires a value`);
        values.set(name, value);
    }
    for (const required of ["--install-root", "--source-root",
        "--minimum-glibc", "--probe-root", "--xmake", "--build-image"]) {
        if (!values.has(required)) fail(`${required} is required`);
    }
    return {help: false, values, flags};
}

async function exists(file) {
    try { await access(file); return true; } catch { return false; }
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: options.cwd ?? repositoryRoot,
        encoding: "utf8",
        env: options.env ?? process.env,
        stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
        maxBuffer: 128 * 1024 * 1024,
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

async function buildReceiptInput(options) {
    const buildRoot = path.dirname(options.install);
    const packagesFile = path.join(buildRoot, "builder-packages.txt");
    const buildLog = await readFile(path.join(buildRoot, "build.log"), "utf8");
    const bootstrap = buildLog.match(/^bootstrap_cc=(.+)$/m)?.[1];
    if (!bootstrap || !buildLog.includes(`glibc=glibc ${options.minimumGlibc}`) ||
        !buildLog.includes(`source=${revision}`) ||
        !buildLog.includes(`tree=${tree}`) ||
        !/^build_completed=/m.test(buildLog)) {
        fail("Linux GCC build evidence is incomplete or disagrees with the package");
    }
    const builderPackagesSha256 = await sha256(packagesFile);
    const buildScriptSha256 = await sha256(path.join(
        repositoryRoot, "tools", "linux", "build-gcc.sh"));
    const profile = `linux-x86_64-glibc${options.minimumGlibc}`;
    const buildCommands = [[
        "make", "-C", "@build@", `-j${options.jobs}`,
        "BOOT_CFLAGS=-O2 -march=x86-64 -mtune=generic", "profiledbootstrap",
    ]];
    const installCommands = [["make", "-C", "@build@", "install"]];
    const derivation = {
        profile,
        source: {revision, tree, upstreamBaseRevision, patchRevisions: [revision]},
        sourceDateEpoch,
        buildImage: options.buildImage,
        builderPackagesSha256,
        buildScriptSha256,
        configure: configureArguments,
        buildCommands,
        installCommands,
        probe: {revision: probeRevision, tree: probeTree},
    };
    return {
        component: "gcc",
        componentVersion: version,
        packageRevision,
        manifestDigest: sha256Bytes(canonicalJson(derivation)),
        profile,
        source: {
            repository: "https://github.com/move-engine/gcc.git",
            revision,
            tree,
            upstreamBaseRevision,
            patchRevisions: [revision],
        },
        sourceDateEpoch,
        schemas: {manifest: 2, qualification: 1, package: 1},
        build: {
            triples: {
                build: "x86_64-pc-linux-gnu",
                host: "x86_64-pc-linux-gnu",
                target: "x86_64-pc-linux-gnu",
            },
            configure: [...configureArguments],
            bootstrap: {
                identity: `Ubuntu glibc ${options.minimumGlibc} system GCC`,
                observedVersion: bootstrap,
            },
            buildCommands,
            installCommands,
        },
        environment: {
            builderIdentity: `${options.buildImage}+dpkg@sha256:${builderPackagesSha256}`,
            runtimeIdentity: {
                family: "glibc", minimumVersion: options.minimumGlibc,
            },
            targetCpuBaseline: "x86-64",
            variables: {
                CC: "/usr/bin/gcc",
                CXX: "/usr/bin/g++",
                SOURCE_DATE_EPOCH: String(sourceDateEpoch),
            },
        },
        dependencies: [{
            id: "nez-imported-namespace-probe",
            kind: "git",
            source: "https://github.com/move-engine/nez.git",
            version: probeRevision.slice(0, 8),
            revision: probeRevision,
            tree: probeTree,
        }],
        qualification: options.qualification,
    };
}

async function validateInputs(install, source) {
    for (const relative of ["bin/gcc", "bin/g++",
        "include/c++/16.2.0/meta", "lib64/libstdc++.so.6"]) {
        if (!(await exists(path.join(install, ...relative.split("/"))))) {
            fail(`GCC installation is incomplete: ${relative}`);
        }
    }
    if (run("git", ["-C", source, "rev-parse", "HEAD"]) !== revision ||
        run("git", ["-C", source, "write-tree"]) !== tree ||
        run("git", ["-C", source, "status", "--porcelain", "--untracked-files=all"])) {
        fail("GCC source identity is not the exact clean Move release");
    }
}

function packageOwning(file) {
    const candidates = [file];
    if (file.startsWith("/usr/lib/")) candidates.push(file.slice(4));
    if (file.startsWith("/lib/")) candidates.push(`/usr${file}`);
    for (const candidate of candidates) {
        const result = spawnSync("dpkg-query", ["-S", candidate], {
            encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        });
        if (result.status !== 0) continue;
        const match = result.stdout.match(/^([^\s:]+)(?::[^\s:]+)?:\s/m);
        if (match) return match[1];
    }
    fail(`no installed Debian package owns bundled runtime ${file}`);
}

async function copyRuntimeLicenses(stage, copied) {
    const packages = {};
    const licenseRoot = path.join(stage, "licenses", "runtime");
    await mkdir(licenseRoot, {recursive: true});
    for (const [soname, source] of Object.entries(copied)) {
        const packageName = packageOwning(source);
        const version = run("dpkg-query", ["-W", "-f=${Version}", packageName]);
        const copyright = path.join("/usr/share/doc", packageName, "copyright");
        if (!(await exists(copyright))) {
            fail(`copyright record is absent for bundled runtime package ${packageName}`);
        }
        await copyFile(copyright, path.join(licenseRoot, `${packageName}.copyright`));
        packages[soname] = {package: packageName, version};
    }
    return Object.fromEntries(Object.entries(packages).sort());
}

async function main() {
    if (process.platform !== "linux" || process.arch !== "x64") {
        fail("Linux GCC packaging requires native Linux x64");
    }
    const parsed = parseArguments(process.argv.slice(2));
    if (parsed.help) return usage();
    const install = path.resolve(parsed.values.get("--install-root"));
    const source = path.resolve(parsed.values.get("--source-root"));
    const probeRoot = path.resolve(parsed.values.get("--probe-root"));
    const xmake = path.resolve(parsed.values.get("--xmake"));
    const minimumGlibc = parsed.values.get("--minimum-glibc");
    if (!/^\d+\.\d+$/.test(minimumGlibc)) fail("--minimum-glibc is invalid");
    const buildImage = parsed.values.get("--build-image");
    if (!/^ubuntu@sha256:[0-9a-f]{64}$/.test(buildImage)) {
        fail("--build-image must be an immutable Ubuntu image digest");
    }
    const jobs = Number(parsed.values.get("--jobs") ?? "20");
    if (!Number.isInteger(jobs) || jobs < 1 || jobs > 64) {
        fail("--jobs must be an integer from 1 through 64");
    }
    const libc = detectLinuxLibc();
    if (libc.family !== "glibc" || libc.version !== minimumGlibc) {
        fail(`packaging requires glibc ${minimumGlibc}; found ${libc.family} ${libc.version}`);
    }
    await validateInputs(install, source);

    const output = path.resolve(parsed.values.get("--output-dir") ??
        path.join(repositoryRoot, ".local", "prebuilt"));
    const stagingRoot = path.resolve(parsed.values.get("--staging-root") ?? tmpdir());
    const container = `gcc-${version}-${packageRevision}`;
    const archiveName = `${container}-linux-x86_64-glibc${minimumGlibc}.tar.gz`;
    const archive = path.join(output, archiveName);
    const checksum = `${archive}.sha256`;
    const evidence = `${archive}.evidence.json`;
    if ((await exists(archive) || await exists(checksum) || await exists(evidence)) &&
        !parsed.flags.has("--force")) {
        fail(`output exists and was preserved: ${archive}`);
    }
    await mkdir(output, {recursive: true});
    await mkdir(stagingRoot, {recursive: true});
    const temporary = await mkdtemp(path.join(stagingRoot, ".move-gcc-linux-package-"));
    try {
        const archiveTree = path.join(temporary, "archive");
        const stage = path.join(archiveTree, container, "install");
        await mkdir(path.dirname(stage), {recursive: true});
        await cp(install, stage, {
            recursive: true, preserveTimestamps: true, verbatimSymlinks: true,
        });
        const licenseRoot = path.join(stage, "licenses", "gcc");
        await mkdir(licenseRoot, {recursive: true});
        for (const name of ["COPYING3", "COPYING.RUNTIME"]) {
            await copyFile(path.join(source, name), path.join(licenseRoot, name));
        }
        const runtime = await normalizeLinuxGccRuntime(stage);
        runtime.packages = await copyRuntimeLicenses(stage, runtime.copied);
        runtime.copied = Object.fromEntries(Object.keys(runtime.copied).sort()
            .map((soname) => [soname, `lib64/${soname}`]));
        const stagedQualification = await qualifyLinuxGcc({
            installRoot: stage, sourceRoot: source, minimumGlibc,
            probeRoot, xmake, scratchRoot: path.join(temporary, "staged-qualification"),
        });
        const metadata = {
            schemaVersion: 1, component: "gcc", version, packageRevision,
            profile: `linux-x86_64-glibc${minimumGlibc}`,
            source: {repository: "https://github.com/move-engine/gcc.git", revision, tree},
            requirements: {architecture: "x86-64-baseline", minimumGlibc},
            runtime, qualification: stagedQualification.qualification,
        };
        const receiptInput = await buildReceiptInput({
            install, minimumGlibc, buildImage, jobs,
            qualification: stagedQualification.qualification,
        });
        metadata.derivation = {configurationDigest: receiptInput.manifestDigest};
        await writeFile(path.join(stage, "move-artifact.json"),
            `${JSON.stringify(metadata, null, 2)}\n`);
        await writeFile(path.join(stage, "move-qualification.json"),
            `${JSON.stringify({qualified: true, ...metadata}, null, 2)}\n`);
        const writtenReceipt = await writeBuildReceipt(stage, receiptInput);

        await rm(archive, {force: true});
        await rm(checksum, {force: true});
        await rm(evidence, {force: true});
        const epoch = run("git", ["-C", source, "show", "-s", "--format=%ct", "HEAD"]);
        run("tar", ["--sort=name", `--mtime=@${epoch}`, "--owner=0", "--group=0",
            "--numeric-owner", "-czf", archive, "-C", archiveTree, container]);

        const relocatedRoot = path.join(temporary, "relocated package with spaces");
        await mkdir(relocatedRoot);
        run("tar", ["-xzf", archive, "-C", relocatedRoot]);
        const relocated = path.join(relocatedRoot, container, "install");
        const relocatedQualification = await qualifyLinuxGcc({
            installRoot: relocated, sourceRoot: source, minimumGlibc,
            probeRoot, xmake, scratchRoot: path.join(temporary, "relocated qualification"),
        });
        const relocatedReceipt = await verifyBuildReceipt(relocated);
        if (relocatedReceipt.sha256 !== writtenReceipt.sha256) {
            fail("relocated build receipt identity changed after archiving");
        }
        const digest = await sha256(archive);
        await writeFile(checksum, `${digest}  ${archiveName}\n`);
        const information = await stat(archive);
        await writeFile(evidence, canonicalJson({
            schemaVersion: 1,
            component: "gcc",
            profile: `linux-x86_64-glibc${minimumGlibc}`,
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
            hostRuntime: relocatedQualification.hostRuntime,
        }));
        console.log(`package: ${archive}`);
        console.log(`bytes: ${information.size}`);
        console.log(`sha256: ${digest}`);
        console.log(`receipt sha256: ${writtenReceipt.sha256}`);
        console.log(`installed tree: ${writtenReceipt.receipt.installedTree.digest}`);
    } catch (error) {
        await rm(archive, {force: true});
        await rm(checksum, {force: true});
        await rm(evidence, {force: true});
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
