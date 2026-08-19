#!/usr/bin/env node

import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {
    access,
    chmod,
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import process from "node:process";
import {createInterface} from "node:readline/promises";
import {Readable} from "node:stream";
import {pipeline} from "node:stream/promises";
import {
    hostIdentity,
    loadEnvironmentFile,
    loadLocalConfiguration,
    localConfigurationPath,
    repositoryRoot,
    resolveSettings,
    saveHostSettings,
} from "./tools/config.mjs";
import {
    detectLinuxLibc,
    selectCompatibleArtifact,
    sourceBuildAlternative,
    unsupportedLinuxMessage,
} from "./tools/host-compatibility.mjs";

const bootstrapPath = path.join(
    repositoryRoot, "tools", "reflection", "bootstrap.mjs");
const releaseToolPath = path.join(repositoryRoot, "tools", "release.mjs");
const packageClangPath = path.join(
    repositoryRoot, "tools", "package-clang-p2996.mjs");
const manifestPath = path.join(repositoryRoot, "toolchains.json");
const linuxInstallerPath = path.join(
    repositoryRoot, "platform", "linux", "install-modern-toolchains.sh");

let prompt = null;

function fail(message) {
    throw new Error(message);
}

function usage() {
    console.log(`Move toolchain manager

Usage:
  npm start                                      interactive menu
  npm start -- status
  npm start -- assign workspace|clangd|gcc|releases|xmake VALUE
  npm start -- integrate ROOT
  npm start -- build clangd [--jobs N]
  npm start -- build gcc [--jobs N] [--latest-release]
  npm start -- download clangd|gcc [--tag TAG]
  npm start -- package clangd [--force]
  npm start -- publish [--tag TAG] [--publish]
  npm start -- setup msys2 [--accept-system-changes]
  npm start -- setup xmake

Configuration precedence is command line, process environment, .env, saved
host configuration, then repository defaults. Saved assignments live in:
  ${localConfigurationPath}`);
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
        const detail = [result.stdout, result.stderr]
            .filter(Boolean).join("\n").trim();
        fail(`${command} exited with ${result.status}${detail ? `: ${detail}` : ""}`);
    }
    return (result.stdout ?? "").trim();
}

function tryRun(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: options.cwd ?? repositoryRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: options.env ?? process.env,
    });
    if (result.error || result.status !== 0) return null;
    return (result.stdout ?? "").trim();
}

function parseOptions(argv) {
    const positional = [];
    const flags = new Set();
    const values = new Map();
    const flagNames = new Set([
        "--accept-system-changes", "--force", "--latest-release", "--publish",
    ]);
    const valueNames = new Set(["--jobs", "--tag"]);
    for (let index = 0; index < argv.length; ++index) {
        const value = argv[index];
        if (flagNames.has(value)) {
            flags.add(value);
        } else if (valueNames.has(value)) {
            const argument = argv[++index];
            if (!argument || argument.startsWith("--")) fail(`${value} requires a value`);
            values.set(value, argument);
        } else if (value.startsWith("--")) {
            fail(`unknown option: ${value}`);
        } else {
            positional.push(value);
        }
    }
    return {positional, flags, values};
}

function resolveJobs(values) {
    const raw = values.get("--jobs") ?? "20";
    const jobs = Number(raw);
    if (!Number.isInteger(jobs) || jobs < 1 || jobs > 64) {
        fail("--jobs must be an integer from 1 through 64");
    }
    return jobs;
}

async function manifest() {
    const value = JSON.parse(await readFile(manifestPath, "utf8"));
    if (value.schemaVersion !== 1) fail("unsupported toolchains.json schema");
    return value;
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

function executableName(name) {
    return process.platform === "win32" ? `${name}.exe` : name;
}

async function currentSettings() {
    await loadEnvironmentFile();
    return resolveSettings(await loadLocalConfiguration());
}

async function showStatus(settings) {
    const configuration = await manifest();
    console.log(`host: ${settings.host}`);
    console.log(`workspace root: ${settings.localRoot}`);
    console.log(`clang-p2996 root: ${settings.clangRoot}`);
    console.log(`GCC root: ${settings.gccRoot}`);
    if (settings.ucrt64Root) console.log(`UCRT64 root: ${settings.ucrt64Root}`);
    console.log(`Xmake override: ${settings.xmakePath ?? "system/default"}`);
    console.log(`release repository: ${settings.releaseRepository ?? "not assigned"}`);

    const clangRevision = configuration.components["clang-p2996"].revision;
    const clangInstall = path.join(
        settings.clangRoot, "clang-p2996", clangRevision, "install");
    const clangd = path.join(clangInstall, "bin", executableName("clangd"));
    console.log(`clangd: ${await exists(clangd) ? tryRun(clangd, ["--version"])?.split(/\r?\n/)[0] : "absent"}`);

    const gcc = path.join(settings.gccRoot, "bin", executableName("g++"));
    const gccVersion = await exists(gcc) ? tryRun(gcc, ["-dumpfullversion"]) : null;
    const gccTarget = await exists(gcc) ? tryRun(gcc, ["-dumpmachine"]) : null;
    console.log(`GCC: ${gccVersion ? `${gccVersion} (${gccTarget})` : "absent or unusable"}`);

    const xmake = settings.xmakePath ?? "xmake";
    const xmakeVersion = tryRun(xmake, ["--version"]);
    console.log(`Xmake: ${xmakeVersion ? xmakeVersion.split(/\r?\n/)[0] : "absent"}`);
}

async function assign(kind, value) {
    if (!value) fail(`assign ${kind} requires a value`);
    const resolved = kind === "releases" ? value : path.resolve(value);
    const fields = {
        workspace: {localRoot: resolved},
        clangd: {clangRoot: resolved},
        gcc: process.platform === "win32" ?
            {gccRoot: resolved, ucrt64Root: resolved} : {gccRoot: resolved},
        releases: {releaseRepository: resolved},
        xmake: {xmakePath: resolved},
    }[kind];
    if (!fields) fail(`unknown assignment kind: ${kind}`);
    await saveHostSettings(fields);
    console.log(`saved ${kind} assignment for ${hostIdentity()}: ${resolved}`);
}

async function findClangRoot(root, revision) {
    const resolved = path.resolve(root);
    const directMarker = path.join(resolved, "move-qualification.json");
    if (await exists(directMarker)) {
        const marker = JSON.parse(await readFile(directMarker, "utf8"));
        if (marker.revision === revision && path.basename(resolved) === "install") {
            const revisionDirectory = path.dirname(resolved);
            if (path.basename(revisionDirectory) === revision &&
                path.basename(path.dirname(revisionDirectory)) === "clang-p2996") {
                return path.dirname(path.dirname(revisionDirectory));
            }
        }
    }
    const expected = path.join(
        resolved, "clang-p2996", revision, "install", "move-qualification.json");
    return await exists(expected) ? resolved : null;
}

async function validateGccRoot(root) {
    const configuration = await manifest();
    const minimum = configuration.components.gcc.minimumCompatibleVersion;
    const compiler = path.join(root, "bin", executableName("g++"));
    if (!(await exists(compiler))) fail(`G++ is absent: ${compiler}`);
    const version = run(compiler, ["-dumpfullversion"]);
    const target = run(compiler, ["-dumpmachine"]);
    if (compareVersions(version, minimum) < 0) {
        fail(`GCC ${version} is older than the supported floor ${minimum}`);
    }
    if (process.platform === "win32" && target !== "x86_64-w64-mingw32") {
        fail(`Windows GCC must target x86_64-w64-mingw32, got ${target}`);
    }
    const temporary = await mkdtemp(path.join(tmpdir(), "move-gcc-probe-"));
    try {
        const source = path.join(temporary, "reflection.cpp");
        const output = path.join(temporary, executableName("reflection"));
        const windowsGuard = process.platform === "win32" ?
            `#include <corecrt.h>\n#if !defined(_WIN32) || !defined(__MINGW64__) || !defined(_UCRT)\n#error expected the MSYS2 UCRT64 target\n#endif\n` : "";
        await writeFile(source, `${windowsGuard}#include <meta>\nstruct Probe { int value; };\nconstexpr auto members = std::define_static_array(std::meta::nonstatic_data_members_of(^^Probe, std::meta::access_context::current()));\nstatic_assert(members.size() == 1);\nint main() { return 0; }\n`);
        run(compiler, ["-std=c++26", "-freflection", source, "-o", output], {
            env: {
                ...process.env,
                PATH: `${path.dirname(compiler)}${path.delimiter}${process.env.PATH ?? ""}`,
            },
        });
        run(output, [], {
            env: {
                ...process.env,
                PATH: `${path.dirname(compiler)}${path.delimiter}${process.env.PATH ?? ""}`,
            },
        });
    } finally {
        await rm(temporary, {recursive: true, force: true});
    }
    return {compiler, version, target};
}

async function integrate(root) {
    if (!root) fail("integrate requires an existing root");
    const configuration = await manifest();
    const revision = configuration.components["clang-p2996"].revision;
    const clangRoot = await findClangRoot(root, revision);
    let gcc = null;
    try {
        gcc = await validateGccRoot(path.resolve(root));
    } catch {
        // A combined workspace normally has GCC beneath gcc/current.
        const candidate = path.join(path.resolve(root), "gcc", "current");
        try {
            gcc = await validateGccRoot(candidate);
            gcc.root = candidate;
        } catch {
            gcc = null;
        }
    }
    if (!clangRoot && !gcc) {
        fail(`no qualified clang-p2996 or compatible GCC was found under ${root}`);
    }
    const update = {};
    if (clangRoot) update.clangRoot = clangRoot;
    if (gcc) {
        update.gccRoot = gcc.root ?? path.resolve(root);
        if (process.platform === "win32") update.ucrt64Root = update.gccRoot;
    }
    await saveHostSettings(update);
    if (clangRoot) console.log(`integrated clang-p2996 workspace: ${clangRoot}`);
    if (gcc) console.log(`integrated GCC ${gcc.version} (${gcc.target}): ${update.gccRoot}`);
}

async function buildClang(settings, jobs) {
    const args = [
        bootstrapPath, "install", "--accept-cost",
        "--root", settings.clangRoot,
        "--jobs", String(jobs),
    ];
    if (settings.ucrt64Root) args.push("--ucrt64-root", settings.ucrt64Root);
    run(process.execPath, args, {inherit: true});
}

async function buildGcc(settings, jobs, latestRelease) {
    if (process.platform === "win32") {
        fail("native Windows GCC source packaging is not implemented; use setup msys2 or download gcc");
    }
    const configuration = await manifest();
    const version = latestRelease ? "auto" : configuration.components.gcc.version;
    const prefixRoot = path.join(settings.localRoot, "gcc");
    run("bash", [linuxInstallerPath], {
        inherit: true,
        env: {
            ...process.env,
            GCC_VERSION: version,
            GCC_BUILD_JOBS: String(jobs),
            GCC_PREFIX_ROOT: prefixRoot,
            GCC_CURRENT_LINK: path.join(prefixRoot, "current"),
            INSTALL_ONLY: "1",
            UPDATE_GCC_LD_SO_CONF: "0",
        },
    });
    await saveHostSettings({gccRoot: path.join(prefixRoot, "current")});
}

async function githubRelease(repository, tag = null) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) {
        fail("assign a release repository as OWNER/REPO first");
    }
    const endpoint = tag && tag !== "latest" ?
        `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}` :
        `https://api.github.com/repos/${repository}/releases/latest`;
    const headers = {
        Accept: "application/vnd.github+json",
        "User-Agent": "move-toolchains",
        "X-GitHub-Api-Version": "2022-11-28",
    };
    if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
    const response = await fetch(endpoint, {headers});
    if (!response.ok) fail(`GitHub release lookup failed (${response.status}): ${endpoint}`);
    return await response.json();
}

function releaseAsset(release, name) {
    const asset = release.assets?.find((candidate) => candidate.name === name);
    if (!asset) fail(`release ${release.tag_name} has no asset named ${name}`);
    return asset;
}

async function downloadAsset(asset, destination) {
    const headers = {"User-Agent": "move-toolchains"};
    if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
    const response = await fetch(asset.browser_download_url, {headers});
    if (!response.ok || !response.body) {
        fail(`asset download failed (${response.status}): ${asset.name}`);
    }
    await mkdir(path.dirname(destination), {recursive: true});
    const temporary = `${destination}.partial-${process.pid}`;
    await pipeline(Readable.fromWeb(response.body),
        (await import("node:fs")).createWriteStream(temporary, {flags: "wx"}));
    if (asset.digest?.startsWith("sha256:")) {
        const expected = asset.digest.slice("sha256:".length).toLowerCase();
        const actual = await sha256(temporary);
        if (actual !== expected) {
            await rm(temporary, {force: true});
            fail(`GitHub digest mismatch for ${asset.name}`);
        }
    }
    await rm(destination, {force: true});
    await rename(temporary, destination);
}

async function sha256(file) {
    return createHash("sha256").update(await readFile(file)).digest("hex");
}

function parseChecksum(text, expectedFile) {
    const match = text.trim().match(/^([0-9a-fA-F]{64})\s+[*]?(.+)$/);
    if (!match || path.basename(match[2].trim()) !== expectedFile) {
        fail(`invalid checksum for ${expectedFile}`);
    }
    return match[1].toLowerCase();
}

function inspectArchive(file) {
    const listing = file.toLowerCase().endsWith(".zip") && process.platform !== "win32"
        ? run("unzip", ["-Z1", file])
        : run("tar", ["-tf", file]);
    const entries = listing.split(/\r?\n/)
        .map((entry) => entry.replaceAll("\\", "/").replace(/^\.\//, ""))
        .filter(Boolean);
    for (const entry of entries) {
        const normalized = entry.replace(/\/$/, "");
        if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) ||
            normalized.split("/").includes("..")) {
            fail(`unsafe archive entry in ${path.basename(file)}: ${entry}`);
        }
    }
    return entries;
}

function extractArchive(file, destination) {
    if (file.toLowerCase().endsWith(".zip") && process.platform !== "win32") {
        run("unzip", ["-q", file, "-d", destination]);
    } else {
        run("tar", ["-xf", file, "-C", destination]);
    }
}

async function downloadToolchain(settings, component, tag) {
    const libc = settings.host === "linux-x64" ? detectLinuxLibc() : null;
    if (settings.host === "linux-x64" && libc.family !== "glibc") {
        fail(sourceBuildAlternative(unsupportedLinuxMessage(libc, component)));
    }
    const release = await githubRelease(settings.releaseRepository, tag);
    const temporary = await mkdtemp(path.join(tmpdir(), "move-toolchain-download-"));
    try {
        const manifestAsset = releaseAsset(release, "release-manifest.json");
        const manifestChecksumAsset = releaseAsset(
            release, "release-manifest.json.sha256");
        const downloadedManifest = path.join(temporary, manifestAsset.name);
        const downloadedManifestChecksum = path.join(
            temporary, manifestChecksumAsset.name);
        await downloadAsset(manifestAsset, downloadedManifest);
        await downloadAsset(manifestChecksumAsset, downloadedManifestChecksum);
        const expectedManifest = parseChecksum(
            await readFile(downloadedManifestChecksum, "utf8"),
            manifestAsset.name);
        if (await sha256(downloadedManifest) !== expectedManifest) {
            fail("release manifest checksum mismatch");
        }
        const releaseManifest = JSON.parse(await readFile(downloadedManifest, "utf8"));
        const artifact = selectCompatibleArtifact(
            releaseManifest.artifacts, component, settings.host, libc);
        if (!artifact) {
            const message = settings.host === "linux-x64"
                ? unsupportedLinuxMessage(libc, component)
                : `release ${release.tag_name} has no ${component} artifact for ${settings.host}`;
            fail(component === "clangd"
                ? sourceBuildAlternative(message)
                : message);
        }
        const archiveAsset = releaseAsset(release, artifact.file);
        const checksumAsset = releaseAsset(release, artifact.checksumFile);
        const archive = path.join(temporary, artifact.file);
        const checksum = path.join(temporary, artifact.checksumFile);
        await downloadAsset(archiveAsset, archive);
        await downloadAsset(checksumAsset, checksum);
        const expected = parseChecksum(await readFile(checksum, "utf8"), artifact.file);
        if (await sha256(archive) !== expected || expected !== artifact.sha256) {
            fail(`release checksum disagreement for ${artifact.file}`);
        }

        const root = component === "clangd" ? settings.clangRoot : settings.localRoot;
        await mkdir(root, {recursive: true});
        const staging = path.join(root, `.download-${process.pid}-${Date.now()}`);
        await mkdir(staging);
        try {
            inspectArchive(archive);
            extractArchive(archive, staging);
            if (component === "clangd") {
                const revision = releaseManifest.source?.components?.["clang-p2996"]?.revision;
                if (!/^[0-9a-f]{40}$/.test(revision ?? "")) {
                    fail("release manifest has no full clang-p2996 revision");
                }
                const source = path.join(staging, "clang-p2996", revision);
                const container = path.join(root, "clang-p2996");
                const target = path.join(container, revision);
                if (!(await exists(source))) fail("clang-p2996 archive layout is invalid");
                if (await exists(target)) {
                    fail(`clang-p2996 revision exists and was preserved: ${target}`);
                }
                await mkdir(container, {recursive: true});
                await rename(source, target);
                const args = [
                    bootstrapPath, "adopt", "--accept-prebuilt", "--root", root,
                ];
                if (settings.ucrt64Root) {
                    args.push("--ucrt64-root", settings.ucrt64Root);
                }
                try {
                    run(process.execPath, args, {inherit: true});
                } catch (error) {
                    const quarantine = `${target}.failed-${Date.now()}`;
                    await rename(target, quarantine);
                    fail(`downloaded clang-p2996 failed qualification and was preserved at ${quarantine}: ${error.message}`);
                }
            } else {
                const entries = await readdir(staging);
                if (entries.length !== 1) fail("GCC archive must contain one root directory");
                const target = path.join(root, entries[0]);
                if (await exists(target)) fail(`GCC target exists and was preserved: ${target}`);
                await rename(path.join(staging, entries[0]), target);
                await validateGccRoot(target);
                await saveHostSettings({gccRoot: target});
            }
        } finally {
            await rm(staging, {recursive: true, force: true});
        }
        console.log(`installed ${component} from ${settings.releaseRepository} ${release.tag_name}`);
    } finally {
        await rm(temporary, {recursive: true, force: true});
    }
}

async function packageClang(settings, force) {
    const args = [packageClangPath, "--root", settings.clangRoot];
    if (settings.ucrt64Root) args.push("--ucrt64-root", settings.ucrt64Root);
    if (force) args.push("--force");
    run(process.execPath, args, {inherit: true});
}

async function publish(settings, tag, real) {
    if (!settings.releaseRepository) fail("assign a release repository first");
    const args = [releaseToolPath, "publish", "--repository", settings.releaseRepository];
    if (tag) args.push("--tag", tag);
    if (real) args.push("--publish");
    run(process.execPath, args, {inherit: true});
}

async function setupMsys2(settings, accepted) {
    if (process.platform !== "win32") fail("MSYS2 setup is available only on Windows");
    const root = settings.ucrt64Root ?? "C:\\msys64\\ucrt64";
    let existing = null;
    try {
        existing = await validateGccRoot(root);
    } catch (error) {
        console.log(`existing UCRT64 check: ${error.message}`);
    }
    if (existing) {
        console.log(`MSYS2/UCRT64 GCC is already qualified: ${existing.version}`);
        if (settings.gccRoot !== root || settings.ucrt64Root !== root) {
            await saveHostSettings({gccRoot: root, ucrt64Root: root});
        }
        return;
    }
    if (!accepted) {
        fail("setup changes the system; rerun with --accept-system-changes after reviewing the operation");
    }
    const msysRoot = path.dirname(root);
    let bash = path.join(msysRoot, "usr", "bin", "bash.exe");
    if (!(await exists(bash))) {
        if (!tryRun("winget", ["--version"])) fail("winget is unavailable");
        run("winget", [
            "install", "--exact", "--id", "MSYS2.MSYS2",
            "--accept-package-agreements", "--accept-source-agreements",
        ], {inherit: true});
        bash = path.join(msysRoot, "usr", "bin", "bash.exe");
        if (!(await exists(bash))) {
            fail(`MSYS2 was installed but not found at the expected root ${msysRoot}`);
        }
    }
    run(bash, ["-lc", "pacman -Syu --noconfirm"], {inherit: true});
    run(bash, ["-lc",
        "pacman -S --needed --noconfirm mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-cmake mingw-w64-ucrt-x86_64-ninja git"],
    {inherit: true});
    const qualified = await validateGccRoot(root);
    await saveHostSettings({gccRoot: root, ucrt64Root: root});
    console.log(`qualified MSYS2/UCRT64 GCC ${qualified.version}`);
}

async function setupXmake(settings) {
    const configuration = await manifest();
    const minimum = configuration.components.xmake.minimumVersion;
    const configured = settings.xmakePath;
    const systemVersion = tryRun(configured ?? "xmake", ["--version"]);
    const match = systemVersion?.match(/xmake v(\d+\.\d+\.\d+)/i);
    if (match && compareVersions(match[1], minimum) >= 0) {
        console.log(`Xmake ${match[1]} is already suitable: ${configured ?? "system PATH"}`);
        return;
    }
    const release = await githubRelease("xmake-io/xmake");
    const tag = release.tag_name;
    let pattern;
    if (settings.host === "win32-x64") pattern = new RegExp(`^xmake-${tag}\\.win64\\.zip$`);
    else if (settings.host === "linux-x64") pattern = new RegExp(`^xmake-bundle-${tag}\\.linux\\.x86_64$`);
    else if (settings.host === "darwin-x64") pattern = new RegExp(`^xmake-bundle-${tag}\\.macos\\.x86_64$`);
    else if (settings.host === "darwin-arm64") pattern = new RegExp(`^xmake-bundle-${tag}\\.macos\\.arm64$`);
    else fail(`no portable Xmake mapping for ${settings.host}`);
    const asset = release.assets.find((candidate) => pattern.test(candidate.name));
    if (!asset?.digest?.startsWith("sha256:")) {
        fail("official Xmake release has no matching digest-qualified portable asset");
    }
    const installRoot = path.join(settings.localRoot, "xmake", tag);
    const temporary = await mkdtemp(path.join(tmpdir(), "move-xmake-"));
    let staging = null;
    try {
        const download = path.join(temporary, asset.name);
        await downloadAsset(asset, download);
        if (await exists(installRoot)) {
            fail(`portable Xmake target exists and was preserved: ${installRoot}`);
        }
        const parent = path.dirname(installRoot);
        await mkdir(parent, {recursive: true});
        staging = path.join(parent, `.staging-${tag}-${process.pid}`);
        await rm(staging, {recursive: true, force: true});
        await mkdir(staging);
        let executable;
        if (settings.host === "win32-x64") {
            inspectArchive(download);
            extractArchive(download, staging);
            const pending = [staging];
            executable = null;
            while (pending.length && !executable) {
                const directory = pending.pop();
                for (const entry of await readdir(directory, {withFileTypes: true})) {
                    const candidate = path.join(directory, entry.name);
                    if (entry.isDirectory()) pending.push(candidate);
                    else if (entry.name.toLowerCase() === "xmake.exe") executable = candidate;
                }
            }
            if (!executable) fail("portable Xmake archive has no xmake.exe");
        } else {
            executable = path.join(staging, "xmake");
            await copyFile(download, executable);
            await chmod(executable, 0o755);
        }
        const output = run(executable, ["--version"]);
        const relativeExecutable = path.relative(staging, executable);
        await rename(staging, installRoot);
        staging = null;
        const installedExecutable = path.join(installRoot, relativeExecutable);
        await saveHostSettings({xmakePath: installedExecutable});
        console.log(`installed portable ${output.split(/\r?\n/)[0]} at ${installedExecutable}`);
    } finally {
        if (staging) await rm(staging, {recursive: true, force: true});
        await rm(temporary, {recursive: true, force: true});
    }
}

async function ask(question, fallback = null) {
    const suffix = fallback ? ` [${fallback}]` : "";
    const answer = (await prompt.question(`${question}${suffix}: `)).trim();
    return answer || fallback;
}

async function confirm(question) {
    return /^(y|yes)$/i.test((await prompt.question(`${question} [y/N]: `)).trim());
}

async function interactive() {
    prompt = createInterface({input: process.stdin, output: process.stdout});
    try {
        for (;;) {
            const settings = await currentSettings();
            console.log(`\nMove toolchains (${settings.host})`);
            console.log("  1. Show status");
            console.log("  2. Assign workspace/build root");
            console.log("  3. Assign or integrate clangd root");
            console.log("  4. Build clang-p2996");
            console.log("  5. Download latest compatible clangd");
            console.log("  6. Assign or integrate GCC root");
            console.log("  7. Download latest compatible GCC prebuilt");
            console.log("  8. Build configured GCC release");
            console.log("  9. Build latest official stable GCC release");
            console.log(" 10. Set up/check MSYS2 UCRT64 GCC");
            console.log(" 11. Set up/check portable Xmake");
            console.log(" 12. Package Windows clang-p2996");
            console.log(" 13. Assign GitHub release repository");
            console.log(" 14. Verify/dry-run GitHub Release");
            console.log(" 15. Publish GitHub Release");
            console.log("  0. Exit");
            const choice = await ask("What do you want to do?");
            if (choice === "0" || /^q(uit)?$/i.test(choice ?? "")) return;
            try {
                if (choice === "1") await showStatus(settings);
                else if (choice === "2") await assign("workspace",
                    await ask("Workspace/build root", settings.localRoot));
                else if (choice === "3") await integrate(
                    await ask("Existing clang-p2996 workspace or install root", settings.clangRoot));
                else if (choice === "4") await buildClang(settings,
                    Number(await ask("Parallel jobs", "20")));
                else if (choice === "5") await downloadToolchain(settings, "clangd", "latest");
                else if (choice === "6") await integrate(
                    await ask("Existing GCC/UCRT64 root", settings.gccRoot));
                else if (choice === "7") await downloadToolchain(settings, "gcc", "latest");
                else if (choice === "8") await buildGcc(settings,
                    Number(await ask("Parallel jobs", "20")), false);
                else if (choice === "9") await buildGcc(settings,
                    Number(await ask("Parallel jobs", "20")), true);
                else if (choice === "10") await setupMsys2(settings,
                    await confirm("Allow winget/pacman to modify this system if required?"));
                else if (choice === "11") await setupXmake(settings);
                else if (choice === "12") await packageClang(settings,
                    await confirm("Replace an existing archive?"));
                else if (choice === "13") await assign("releases",
                    await ask("GitHub repository (OWNER/REPO)", settings.releaseRepository));
                else if (choice === "14") await publish(settings, null, false);
                else if (choice === "15") {
                    if (await confirm("Publish the complete verified release to GitHub?")) {
                        await publish(settings, null, true);
                    }
                } else console.log(`unknown choice: ${choice}`);
            } catch (error) {
                console.error(`error: ${error.message}`);
            }
        }
    } finally {
        prompt.close();
        prompt = null;
    }
}

async function main() {
    const parsed = parseOptions(process.argv.slice(2));
    const [command, subject, value] = parsed.positional;
    if (!command) {
        await interactive();
        return;
    }
    if (["help", "-h"].includes(command)) {
        usage();
        return;
    }
    const settings = await currentSettings();
    if (command === "status") await showStatus(settings);
    else if (command === "assign") await assign(subject, value);
    else if (command === "integrate") await integrate(subject);
    else if (command === "build" && subject === "clangd") {
        await buildClang(settings, resolveJobs(parsed.values));
    } else if (command === "build" && subject === "gcc") {
        await buildGcc(settings, resolveJobs(parsed.values),
            parsed.flags.has("--latest-release"));
    } else if (command === "download" && ["clangd", "gcc"].includes(subject)) {
        await downloadToolchain(settings, subject, parsed.values.get("--tag") ?? "latest");
    } else if (command === "package" && subject === "clangd") {
        await packageClang(settings, parsed.flags.has("--force"));
    } else if (command === "publish") {
        await publish(settings, parsed.values.get("--tag"), parsed.flags.has("--publish"));
    } else if (command === "setup" && subject === "msys2") {
        await setupMsys2(settings, parsed.flags.has("--accept-system-changes"));
    } else if (command === "setup" && subject === "xmake") {
        await setupXmake(settings);
    } else {
        fail("unsupported command; run npm start -- help");
    }
}

main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
});
