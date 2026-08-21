#!/usr/bin/env node

import {spawnSync} from "node:child_process";
import {mkdirSync, rmSync} from "node:fs";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const dockerfile = path.join(
    repositoryRoot, "tools", "linux", "Dockerfile.clang-p2996-ubuntu2204");
const image = "move-toolchains/clang-p2996-builder:ubuntu22.04";
const baseImage = "ubuntu@sha256:2edbbc5dc405e9612ba3584ce95480277e3eb374407b5505fe26f17df77c7dbc";
const defaultDistro = "MoveToolchains-Ubuntu2204";

function fail(message) {
    throw new Error(message);
}

function usage() {
    console.log(`Ubuntu 22.04 clang-p2996 builder

Usage:
  npm run ubuntu2204:clangd -- setup-wsl --storage-root WINDOWS_PATH
      [--distro NAME]
  npm run ubuntu2204:clangd -- build [--root LINUX_PATH] [--jobs N]
      [--distro NAME]
  npm run ubuntu2204:clangd -- package [--root LINUX_PATH] [--output-dir PATH] [--distro NAME] [--force]
  npm run ubuntu2204:clangd -- shell [--distro NAME]

The build and package run inside the pinned Ubuntu 22.04/glibc 2.35 image.
On Windows, setup-wsl imports that image as a dedicated WSL2 distribution and
ROOT defaults to /opt/move-toolchains inside its VHD. Put the WSL storage root
on a large drive. No host glibc or host Linux packages are changed.`);
}

function parseArguments(argv) {
    const command = argv[0] ?? "help";
    const flags = new Set();
    const values = new Map();
    for (let index = 1; index < argv.length; ++index) {
        const name = argv[index];
        if (name === "--force") {
            flags.add(name);
            continue;
        }
        if (!["--root", "--jobs", "--output-dir", "--storage-root", "--distro"]
            .includes(name)) {
            fail(`unknown argument: ${name}`);
        }
        const value = argv[++index];
        if (!value || value.startsWith("--")) fail(`${name} requires a value`);
        values.set(name, value);
    }
    return {command, flags, values};
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: options.cwd ?? repositoryRoot,
        encoding: "utf8",
        stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    if (result.error) fail(`${command} could not start: ${result.error.message}`);
    if (result.status !== 0) {
        const detail = options.capture
            ? [result.stdout, result.stderr].filter(Boolean).join("\n").trim()
            : "";
        fail(`${command} exited with ${result.status}${detail ? `: ${detail}` : ""}`);
    }
    return (result.stdout ?? "").trim();
}

function resolvedValue(values, name, fallback = null) {
    const value = values.get(name) ?? fallback;
    return value ? path.resolve(value) : null;
}

function normalizedWslOutput(value) {
    return value.replaceAll("\0", "").replaceAll("\r", "").trim();
}

function wslDistros() {
    return normalizedWslOutput(run("wsl", ["--list", "--quiet"], {capture: true}))
        .split("\n").map((entry) => entry.trim()).filter(Boolean);
}

function assertWslDistro(distro) {
    if (!wslDistros().some((entry) => entry.toLowerCase() === distro.toLowerCase())) {
        fail(`WSL distribution ${distro} is absent; run setup-wsl first`);
    }
    const glibc = normalizedWslOutput(run("wsl", [
        "--distribution", distro, "--exec", "getconf", "GNU_LIBC_VERSION",
    ], {capture: true}));
    if (glibc !== "glibc 2.35") {
        fail(`WSL distribution ${distro} is not the Ubuntu 22.04 baseline: ${glibc}`);
    }
    const osRelease = normalizedWslOutput(run("wsl", [
        "--distribution", distro, "--exec", "cat", "/etc/os-release",
    ], {capture: true}));
    if (!/^ID=ubuntu$/m.test(osRelease) || !/^VERSION_ID="?22\.04"?$/m.test(osRelease)) {
        fail(`WSL distribution ${distro} is not Ubuntu 22.04`);
    }
    const node = normalizedWslOutput(run("wsl", [
        "--distribution", distro, "--exec", "node", "--version",
    ], {capture: true}));
    if (node !== "v20.18.0") {
        fail(`WSL distribution ${distro} has unexpected Node.js: ${node}`);
    }
    const listing = normalizedWslOutput(run("wsl", [
        "--list", "--verbose",
    ], {capture: true}));
    const row = listing.split("\n").find((line) =>
        line.toLowerCase().includes(distro.toLowerCase()));
    if (!row || !/\s2\s*$/.test(row)) {
        fail(`WSL distribution ${distro} is not running as WSL2`);
    }
}

function wslPath(distro, windowsPath) {
    return normalizedWslOutput(run("wsl", [
        "--distribution", distro, "--exec", "wslpath", "-a", windowsPath,
    ], {capture: true}));
}

function setupWsl(storageRoot, distro) {
    if (process.platform !== "win32") fail("setup-wsl is available only on Windows");
    if (wslDistros().some((entry) => entry.toLowerCase() === distro.toLowerCase())) {
        assertWslDistro(distro);
        console.log(`WSL distribution is already qualified: ${distro}`);
        return;
    }
    const identity = ensureImage();
    const resolvedStorage = path.resolve(storageRoot);
    mkdirSync(resolvedStorage, {recursive: true});
    const rootfs = path.join(resolvedStorage, "ubuntu2204-rootfs.tar");
    const container = `move-toolchains-ubuntu2204-export-${process.pid}`;
    try {
        run("docker", ["create", "--name", container, image, "/bin/true"]);
        run("docker", ["export", "--output", rootfs, container]);
        run("wsl", [
            "--import", distro, resolvedStorage, rootfs, "--version", "2",
        ]);
    } catch (error) {
        if (wslDistros().some((entry) => entry.toLowerCase() === distro.toLowerCase())) {
            fail(`${error.message}; imported ${distro} was preserved for inspection`);
        }
        throw error;
    } finally {
        spawnSync("docker", ["rm", container], {stdio: "ignore"});
        rmSync(rootfs, {force: true});
    }
    assertWslDistro(distro);
    console.log(`imported ${distro} at ${resolvedStorage}`);
    console.log(`builder image: ${identity}`);
}

function runInWsl(distro, args, options = {}) {
    assertWslDistro(distro);
    run("wsl", [
        "--distribution", distro,
        "--cd", repositoryRoot,
        "--exec", ...args,
    ], options);
}

function containerArguments(root, outputDirectory = null) {
    const args = [
        "run", "--rm", "--platform", "linux/amd64",
        "--mount", `type=bind,source=${repositoryRoot},target=/repo,readonly`,
        "--mount", `type=bind,source=${root},target=/toolchain`,
        "--env", "MOVE_CLANG_P2996_ROOT=/toolchain",
        "--workdir", "/repo",
    ];
    if (outputDirectory) {
        args.push("--mount", `type=bind,source=${outputDirectory},target=/artifacts`);
    }
    return args;
}

function ensureImage() {
    run("docker", [
        "build", "--platform", "linux/amd64", "--file", dockerfile,
        "--tag", image, repositoryRoot,
    ]);
    const identity = run("docker", [
        "image", "inspect", image, "--format", "{{.Id}}",
    ], {capture: true});
    return identity;
}

function main() {
    const {command, flags, values} = parseArguments(process.argv.slice(2));
    if (["help", "--help", "-h"].includes(command)) {
        usage();
        return;
    }
    const distro = values.get("--distro") ?? defaultDistro;
    if (command === "setup-wsl") {
        const storageRoot = values.get("--storage-root");
        if (!storageRoot) fail("setup-wsl requires --storage-root WINDOWS_PATH");
        setupWsl(storageRoot, distro);
        return;
    }
    const root = process.platform === "win32"
        ? values.get("--root") ?? "/opt/move-toolchains"
        : resolvedValue(values, "--root");
    if (!root && command !== "shell") fail(`${command} requires --root PATH`);
    const jobs = Number(values.get("--jobs") ?? "20");
    if (!Number.isInteger(jobs) || jobs < 1 || jobs > 64) {
        fail("--jobs must be an integer from 1 through 64");
    }
    const outputDirectory = resolvedValue(values, "--output-dir",
        path.join(repositoryRoot, ".local", "prebuilt"));
    if (process.platform === "win32") {
        if (command === "build") {
            runInWsl(distro, [
                "env", `MOVE_CLANG_P2996_ROOT=${root}`,
                "npm", "start", "--", "build", "clangd", "--jobs", String(jobs),
            ]);
            return;
        }
        if (command === "package") {
            runInWsl(distro, [
                "node", "tools/package-linux-clang-p2996.mjs",
                "--root", root,
                "--source-root", `${root}/clang-p2996/7220baffd57ea5b0f8cf59bee494dd5b7cc2b748/source`,
                "--build-root", `${root}/clang-p2996/7220baffd57ea5b0f8cf59bee494dd5b7cc2b748/build`,
                "--output-dir", wslPath(distro, outputDirectory),
                "--minimum-glibc", "2.35", "--build-image", baseImage,
                ...(flags.has("--force") ? ["--force"] : []),
            ]);
            return;
        }
        if (command === "shell") {
            run("wsl", ["--distribution", distro, "--cd", repositoryRoot]);
            return;
        }
        fail(`unknown command: ${command}`);
    }
    const imageIdentity = ensureImage();
    if (command === "build") {
        run("docker", [
            ...containerArguments(root), image,
            "npm", "start", "--", "build", "clangd", "--jobs", String(jobs),
        ]);
        return;
    }
    if (command === "package") {
        run("docker", [
            ...containerArguments(root, outputDirectory), image,
            "node", "tools/package-linux-clang-p2996.mjs",
            "--root", "/toolchain", "--output-dir", "/artifacts",
            "--source-root", "/toolchain/clang-p2996/7220baffd57ea5b0f8cf59bee494dd5b7cc2b748/source",
            "--build-root", "/toolchain/clang-p2996/7220baffd57ea5b0f8cf59bee494dd5b7cc2b748/build",
            "--minimum-glibc", "2.35", "--build-image", imageIdentity,
            ...(flags.has("--force") ? ["--force"] : []),
        ]);
        return;
    }
    if (command === "shell") {
        run("docker", [
            ...containerArguments(root, outputDirectory).slice(0, -2),
            "--interactive", "--tty", image, "bash",
        ]);
        return;
    }
    fail(`unknown command: ${command}`);
}

try {
    main();
} catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
}
