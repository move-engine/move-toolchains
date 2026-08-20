#!/usr/bin/env node

import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {createReadStream} from "node:fs";
import {
    access, copyFile, cp, mkdir, mkdtemp, rm, stat, writeFile,
} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {detectLinuxLibc} from "./host-compatibility.mjs";
import {normalizeLinuxGccRuntime} from "./gcc-linux-runtime.mjs";
import {qualifyLinuxGcc} from "./qualify-gcc-linux.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const revision = "ced2ae7f6670c0371e0464e5aaa888c44ebd012a";
const tree = "57f5cc6c172e3e3e08a66c4f1efcf032c84c0b65";
const version = "16.2.0";
const packageRevision = "move.1";

function fail(message) { throw new Error(message); }

function usage() {
    console.log(`Package a qualified Linux Move GCC build

Usage:
  npm run package:gcc:linux -- --install-root PATH --source-root PATH
      --minimum-glibc VERSION --probe-root PATH --xmake PATH
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
            "--probe-root", "--xmake", "--output-dir", "--staging-root"]
            .includes(name)) fail(`unknown argument: ${name}`);
        if (values.has(name)) fail(`duplicate argument: ${name}`);
        const value = argv[++index];
        if (!value || value.startsWith("--")) fail(`${name} requires a value`);
        values.set(name, value);
    }
    for (const required of ["--install-root", "--source-root",
        "--minimum-glibc", "--probe-root", "--xmake"]) {
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
    if ((await exists(archive) || await exists(checksum)) &&
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
        await writeFile(path.join(stage, "move-artifact.json"),
            `${JSON.stringify(metadata, null, 2)}\n`);
        await writeFile(path.join(stage, "move-qualification.json"),
            `${JSON.stringify({qualified: true, ...metadata}, null, 2)}\n`);

        await rm(archive, {force: true});
        await rm(checksum, {force: true});
        const epoch = run("git", ["-C", source, "show", "-s", "--format=%ct", "HEAD"]);
        run("tar", ["--sort=name", `--mtime=@${epoch}`, "--owner=0", "--group=0",
            "--numeric-owner", "-czf", archive, "-C", archiveTree, container]);

        const relocatedRoot = path.join(temporary, "relocated package with spaces");
        await mkdir(relocatedRoot);
        run("tar", ["-xzf", archive, "-C", relocatedRoot]);
        const relocated = path.join(relocatedRoot, container, "install");
        await qualifyLinuxGcc({
            installRoot: relocated, sourceRoot: source, minimumGlibc,
            probeRoot, xmake, scratchRoot: path.join(temporary, "relocated qualification"),
        });
        const digest = await sha256(archive);
        await writeFile(checksum, `${digest}  ${archiveName}\n`);
        const information = await stat(archive);
        console.log(`package: ${archive}`);
        console.log(`bytes: ${information.size}`);
        console.log(`sha256: ${digest}`);
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
