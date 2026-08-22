#!/usr/bin/env node

import {
    access,
    cp,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    realpath,
    rename,
    rm,
    statfs,
    writeFile,
} from "node:fs/promises";
import {constants as fsConstants} from "node:fs";
import {spawn, spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {availableParallelism} from "node:os";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {parseLdd} from "../elf-compatibility.mjs";
import {
    existingBuildCacheErrors,
    sameRepository,
} from "./existing-build.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..", "..");
const configPath = path.join(projectRoot, "toolchains.json");
const defaultToolchainRoot = path.join(projectRoot, ".local", "toolchains");
const selectionPath = path.join(
    projectRoot, ".local", "reflection-toolchain.json");
const toolchainRootEnvironment = "MV_REFLECTION_TOOLCHAIN_ROOT";
const ucrt64RootEnvironment = "MV_WINDOWS_UCRT64_ROOT";
let activeChild = null;
let interruptedSignal = null;

function usage() {
    console.log(`Move experimental reflection toolchain bootstrap

Usage:
  npm run doctor:clangd -- [--root PATH] [--ucrt64-root PATH]
  npm run status:clangd -- [--root PATH] [--ucrt64-root PATH]
  npm run install:clangd -- --accept-cost [--root PATH] [--ucrt64-root PATH] [--jobs N]
  npm run import-build:clangd -- --source PATH --build PATH [--root PATH] [--ucrt64-root PATH] [--jobs N]
  npm run adopt:clangd -- [--root PATH] [--ucrt64-root PATH]
  npm run configure:clangd -- [--force] [--root PATH] [--ucrt64-root PATH]

Linux installs and qualifies pinned Clang, clangd, libc++, libc++abi, and
libunwind as one experimental toolchain. Windows installs a native clangd plus
Clang resource headers and reflection-capable libc++ headers for LSP use while
GCC/UCRT64 remains the production compiler. Expect at least 80 GiB of free disk
and a long LLVM build. The root defaults to ${toolchainRootEnvironment} or the
repository's ignored .local/toolchains directory. Nothing is downloaded during
normal Xmake configuration, help, doctor, status, adopt, or configure. Adopt
executes and requalifies an already extracted trusted prebuilt for the local
host; verify the archive checksum before passing --accept-prebuilt.`);
}

function fail(message) {
    throw new Error(message);
}

function parseArguments(argv) {
    const command = argv[0] ?? "help";
    const flags = new Set();
    const values = new Map();
    const booleanNames = new Set([
        "--accept-cost", "--accept-existing-build", "--accept-prebuilt", "--force",
    ]);
    const valueNames = new Set([
        "--root", "--ucrt64-root", "--jobs", "--source", "--build",
    ]);
    for (let index = 1; index < argv.length; ++index) {
        const value = argv[index];
        if (booleanNames.has(value)) {
            if (flags.has(value)) {
                fail(`duplicate argument: ${value}`);
            }
            flags.add(value);
            continue;
        }
        if (!valueNames.has(value)) {
            fail(`unknown argument: ${value}`);
        }
        if (values.has(value)) {
            fail(`duplicate argument: ${value}`);
        }
        const argument = argv[++index];
        if (!argument || argument.startsWith("--")) {
            fail(`${value} requires a value`);
        }
        values.set(value, argument);
    }
    return {command, flags, values};
}

function validateCommandArguments(command, flags, values) {
    const allowedFlags =
        command === "install" ? new Set(["--accept-cost"]) :
        command === "import-build" ? new Set(["--accept-existing-build"]) :
        command === "adopt" ? new Set(["--accept-prebuilt"]) :
        command === "configure" ? new Set(["--force"]) :
        new Set();
    const allowedValues =
        ["install", "import-build"].includes(command)
            ? new Set(["--root", "--ucrt64-root", "--jobs"])
            : ["doctor", "status", "adopt", "configure"].includes(command)
                ? new Set(["--root", "--ucrt64-root"])
                : new Set();
    if (command === "import-build") {
        allowedValues.add("--source");
        allowedValues.add("--build");
    }
    for (const flag of flags) {
        if (!allowedFlags.has(flag)) {
            fail(`${flag} is not valid for ${command}`);
        }
    }
    for (const name of values.keys()) {
        if (!allowedValues.has(name)) {
            fail(`${name} is not valid for ${command}`);
        }
    }
}

async function readJson(file) {
    return JSON.parse(await readFile(file, "utf8"));
}

export function reflectionConfiguration(root) {
    let config = null;
    if (root.schemaVersion === 1) {
        config = root.components?.["clang-p2996"] ?? null;
    } else if (root.schemaVersion === 2 && root.components?.clangTools) {
        const component = root.components.clangTools;
        config = {
            ...component,
            repository: component.source?.repository,
            revision: component.source?.revision,
        };
    }
    if (!config) {
        fail("unsupported reflection toolchain configuration schema");
    }
    if (!/^[0-9a-f]{40}$/.test(config.revision)) {
        fail("toolchain revision must be a full lowercase Git commit");
    }
    if (!Number.isInteger(config.qualificationSchemaVersion) ||
        config.qualificationSchemaVersion < 1) {
        fail("toolchain qualification schema must be a positive integer");
    }
    if (!config.hosts || typeof config.hosts !== "object") {
        fail("reflection toolchain host configurations are missing");
    }
    return config;
}

async function readConfiguration() {
    return reflectionConfiguration(await readJson(configPath));
}

function hostIdentity() {
    return `${process.platform}-${process.arch}`;
}

function hostProfile(config) {
    return config.hosts[hostIdentity()] ?? null;
}

function resolveToolchainRoot(values) {
    return path.resolve(
        values.get("--root") ??
        process.env[toolchainRootEnvironment] ??
        defaultToolchainRoot);
}

function resolveUcrt64Root(values) {
    if (hostIdentity() !== "win32-x64") return null;
    return path.resolve(
        values.get("--ucrt64-root") ??
        process.env[ucrt64RootEnvironment] ??
        "C:\\msys64\\ucrt64");
}

function resolveJobs(values) {
    const raw = values.get("--jobs");
    const jobs = raw === undefined
        ? Math.min(4, availableParallelism())
        : Number(raw);
    if (!Number.isSafeInteger(jobs) || jobs < 1 || jobs > 64) {
        fail("--jobs must be an integer from 1 through 64");
    }
    return jobs;
}

export function reflectionConfigurationIdentity(
    config, profile, ucrt64Root, host = hostIdentity()) {
    return createHash("sha256").update(JSON.stringify({
        host,
        repository: config.repository,
        revision: config.revision,
        profile,
        ucrt64: ucrt64Root ? {
            gccVersion: profile.gccVersion,
            gccTarget: profile.gccTarget,
        } : null,
    })).digest("hex");
}

const configurationIdentity = reflectionConfigurationIdentity;

function pathsFor(config, toolchainRoot) {
    const root = path.join(toolchainRoot, "clang-p2996", config.revision);
    return {
        root,
        source: path.join(root, "source"),
        build: path.join(root, "build"),
        staging: path.join(root, "staging"),
        install: path.join(root, "install"),
        localQualification: path.join(root, "local-qualification.json"),
        lock: path.join(root, "install.lock"),
        buildState: path.join(root, "build-state.json"),
    };
}

function interruptedError() {
    const error = new Error(
        `interrupted by ${interruptedSignal}; matching build state is resumable`);
    error.exitCode = 130;
    return error;
}

function throwIfInterrupted() {
    if (interruptedSignal) {
        throw interruptedError();
    }
}

async function run(command, args, options = {}) {
    throwIfInterrupted();
    if (activeChild) {
        fail("reflection bootstrap attempted overlapping child processes");
    }

    return await new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd ?? projectRoot,
            stdio: options.capture
                ? ["ignore", "pipe", "pipe"]
                : "inherit",
            env: options.env ?? process.env,
        });
        activeChild = child;
        let stdout = "";
        let stderr = "";
        if (options.capture) {
            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stdout.on("data", (chunk) => {
                stdout += chunk;
            });
            child.stderr.on("data", (chunk) => {
                stderr += chunk;
            });
        }
        child.once("error", (error) => {
            activeChild = null;
            reject(new Error(
                `${command} could not start: ${error.message}`));
        });
        child.once("close", (status, signal) => {
            activeChild = null;
            if (interruptedSignal) {
                reject(interruptedError());
                return;
            }
            if (status !== 0) {
                const reason = signal
                    ? `signal ${signal}`
                    : `status ${status}`;
                const detail = options.capture
                    ? `\n${stderr || stdout}`.trimEnd()
                    : "";
                reject(new Error(
                    `${command} exited with ${reason}${detail}`));
                return;
            }
            resolve(options.capture ? stdout.trim() : "");
        });
    });
}

function checkProgram(command, args = ["--version"]) {
    const result = spawnSync(command, args, {
        encoding: "utf8",
        stdio: "pipe",
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
        .split("\n")[0].trim();
    return {
        command,
        ready: !result.error && result.status === 0,
        detail: output || result.error?.message || `status ${result.status}`,
    };
}

function executableName(name) {
    return process.platform === "win32" ? `${name}.exe` : name;
}

function findPython() {
    const candidates = process.platform === "win32"
        ? [
            ["python3", ["-c", "import sys; print(sys.executable)"]],
            ["python", ["-c", "import sys; print(sys.executable)"]],
            ["py", ["-3", "-c", "import sys; print(sys.executable)"]],
        ]
        : [["python3", ["-c", "import sys; print(sys.executable)"]]];
    for (const [command, args] of candidates) {
        const check = checkProgram(command, args);
        if (check.ready) {
            return {...check, executable: check.detail};
        }
    }
    return {
        command: process.platform === "win32" ? "python3/python/py -3" : "python3",
        ready: false,
        detail: "no usable Python 3 interpreter was found",
        executable: null,
    };
}

async function nearestExistingPath(value) {
    let candidate = path.resolve(value);
    while (!(await exists(candidate))) {
        const parent = path.dirname(candidate);
        if (parent === candidate) {
            fail(`no existing parent is available for toolchain root: ${value}`);
        }
        candidate = parent;
    }
    return candidate;
}

async function availableGiB(toolchainRoot) {
    const stats = await statfs(
        await nearestExistingPath(toolchainRoot), {bigint: true});
    return Number((stats.bavail * stats.bsize) / (1024n ** 3n));
}

async function doctor(config, profile, toolchainRoot, ucrt64Root) {
    const python = findPython();
    const checks = [
        checkProgram(process.execPath),
        checkProgram("git"),
        checkProgram("cmake"),
        checkProgram("ninja"),
        python,
    ];
    if (profile?.qualificationKind === "full-toolchain") {
        checks.push(checkProgram("c++"));
    } else if (profile?.qualificationKind === "language-server") {
        checks.push(checkProgram("cl", ["/nologo", "/?"]));
        const gxx = path.join(ucrt64Root, "bin", "g++.exe");
        const version = checkProgram(gxx, ["-dumpfullversion"]);
        version.ready = version.ready && version.detail === profile.gccVersion;
        version.command = `${gxx} -dumpfullversion`;
        if (!version.ready && version.detail === profile.gccVersion) {
            version.detail = "compiler version check failed";
        }
        checks.push(version);
        const target = checkProgram(gxx, ["-dumpmachine"]);
        target.ready = target.ready && target.detail === profile.gccTarget;
        target.command = `${gxx} -dumpmachine`;
        checks.push(target);
    }
    for (const check of checks) {
        console.log(`${check.ready ? "ok" : "missing"}: ${check.command}: ${check.detail}`);
    }
    const free = await availableGiB(toolchainRoot);
    const enoughDisk = free >= config.minimumFreeGiB;
    console.log(`${enoughDisk ? "ok" : "insufficient"}: free disk: ${free} GiB; ${config.minimumFreeGiB} GiB required`);
    const supported = profile !== null;
    console.log(`${supported ? "ok" : "unsupported"}: host: ${hostIdentity()}`);
    console.log(`toolchain root: ${toolchainRoot}`);
    if (ucrt64Root) console.log(`UCRT64 root: ${ucrt64Root}`);
    return checks.every((check) => check.ready) && enoughDisk && supported;
}

async function exists(file) {
    try {
        await access(file, fsConstants.F_OK);
        return true;
    } catch {
        return false;
    }
}

async function atomicJson(file, value) {
    await mkdir(path.dirname(file), {recursive: true});
    const temporary = `${file}.tmp-${process.pid}`;
    try {
        await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
            flag: "wx",
        });
        await rename(temporary, file);
    } finally {
        await rm(temporary, {force: true});
    }
}

async function readQualification(install) {
    const marker = path.join(install, "move-qualification.json");
    try {
        return await readJson(marker);
    } catch (error) {
        if (error.code === "ENOENT") {
            return null;
        }
        throw error;
    }
}

async function readEffectiveQualification(paths) {
    try {
        return await readJson(paths.localQualification);
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    return await readQualification(paths.install);
}

function qualifiedMarker(marker, config, profile, ucrt64Root) {
    return marker?.schemaVersion === config.qualificationSchemaVersion &&
        marker.qualified === true &&
        marker.revision === config.revision &&
        marker.host === hostIdentity() &&
        marker.qualificationKind === profile.qualificationKind &&
        marker.configurationIdentity ===
            configurationIdentity(config, profile, ucrt64Root);
}

async function status(config, profile, toolchainRoot, ucrt64Root) {
    const paths = pathsFor(config, toolchainRoot);
    const marker = await readEffectiveQualification(paths);
    const markerQualified = qualifiedMarker(
        marker, config, profile, ucrt64Root);
    const clangxx = markerQualified
        ? checkProgram(path.join(
            paths.install, "bin", executableName("clang++")))
        : null;
    const clangd = markerQualified
        ? checkProgram(path.join(
            paths.install, "bin", executableName("clangd")))
        : null;
    const resource = markerQualified
        ? checkProgram(
            path.join(paths.install, "bin", executableName("clang++")),
            ["-print-resource-dir"])
        : null;
    const libcxxHeaders = markerQualified &&
        await exists(path.join(paths.install, "include", "c++", "v1"));
    const libcxxLibraryDir = markerQualified &&
        profile.qualificationKind === "full-toolchain"
        ? await runtimeLibraryDirectory(paths.install)
        : null;
    const qualified = markerQualified &&
        clangxx.ready && clangd.ready && resource.ready &&
        libcxxHeaders &&
        (profile.qualificationKind !== "full-toolchain" ||
         libcxxLibraryDir !== null);
    console.log(`repository: ${config.repository}`);
    console.log(`revision: ${config.revision}`);
    console.log(`install: ${paths.install}`);
    console.log(`qualification: ${profile.qualificationKind}`);
    console.log(`installation: ${qualified ? "qualified" : "absent or unqualified"}`);
    if (markerQualified) {
        console.log(`${clangxx.ready ? "ok" : "invalid"}: compiler: ${clangxx.detail}`);
        console.log(`${clangd.ready ? "ok" : "invalid"}: clangd: ${clangd.detail}`);
        console.log(`${resource.ready ? "ok" : "invalid"}: resource directory: ${resource.detail}`);
        console.log(`${libcxxHeaders ? "ok" : "missing"}: libc++ headers`);
        if (profile.qualificationKind === "full-toolchain") {
            console.log(`${libcxxLibraryDir ? "ok" : "missing"}: libc++ library directory`);
        }
    }
    try {
        const selection = await readJson(selectionPath);
        const selected = selection.mode === "clang-p2996" &&
            selection.revision === config.revision &&
            selection.host === hostIdentity() &&
            selection.qualificationKind === profile.qualificationKind &&
            selection.configurationIdentity ===
                configurationIdentity(config, profile, ucrt64Root) &&
            selection.installDir === paths.install &&
            selection.qualified === true &&
            qualified;
        console.log(`selection: ${selected ? "native experimental" : "not selected or stale"}`);
    } catch (error) {
        if (error.code === "ENOENT") {
            console.log("selection: portable default");
        } else {
            throw error;
        }
    }
}

async function acquireLock(lock, identity) {
    try {
        await mkdir(lock);
    } catch (error) {
        if (error.code === "EEXIST") {
            let owner = null;
            try {
                owner = await readJson(path.join(lock, "owner.json"));
            } catch {
                fail(`an unreadable install lock was preserved: ${lock}`);
            }
            let ownerAlive = true;
            if (owner.host === hostIdentity() &&
                Number.isSafeInteger(owner.pid) && owner.pid > 0) {
                try {
                    process.kill(owner.pid, 0);
                } catch (processError) {
                    ownerAlive = processError.code !== "ESRCH";
                }
            }
            if (ownerAlive) {
                fail(`another install owns the lock: ${lock}`);
            }
            await rm(lock, {recursive: true, force: true});
            await mkdir(lock);
        }
        else {
            throw error;
        }
    }
    try {
        await atomicJson(path.join(lock, "owner.json"), {
            pid: process.pid,
            host: hostIdentity(),
            configurationIdentity: identity,
        });
    } catch (error) {
        await rm(lock, {recursive: true, force: true});
        throw error;
    }
}

async function ensureSource(config, paths) {
    if (!(await exists(paths.source))) {
        await mkdir(paths.source, {recursive: true});
        await run("git", ["init"], {cwd: paths.source});
        await run("git", [
            "remote", "add", "origin", config.repository,
        ], {cwd: paths.source});
    }
    const origin = await run(
        "git", ["remote", "get-url", "origin"],
        {cwd: paths.source, capture: true});
    if (!sameRepository(origin, config.repository)) {
        fail(`source origin mismatch: expected ${config.repository}, found ${origin}`);
    }
    const current = spawnSync("git", ["rev-parse", "HEAD"], {
        cwd: paths.source,
        encoding: "utf8",
        stdio: "pipe",
    });
    let head = current.status === 0 ? current.stdout.trim() : null;
    if (head !== config.revision) {
        await run("git", [
            "fetch", "--depth=1", "--no-tags", "origin", config.revision,
        ], {
            cwd: paths.source,
        });
        await run("git", ["checkout", "--detach", config.revision], {
            cwd: paths.source,
        });
        head = await run("git", ["rev-parse", "HEAD"], {
            cwd: paths.source,
            capture: true,
        });
    }
    if (head !== config.revision) {
        fail(`source revision mismatch: expected ${config.revision}, found ${head}`);
    }
    const sourceStatus = await run(
        "git", ["status", "--porcelain", "--untracked-files=all"],
        {cwd: paths.source, capture: true});
    if (sourceStatus !== "") {
        fail(`source checkout is dirty; preserve and inspect ${paths.source} before retrying`);
    }
}

async function verifyExistingBuild(config, profile, source, build) {
    for (const required of [source, build]) {
        if (!(await exists(required))) {
            fail(`existing build path does not exist: ${required}`);
        }
    }
    const origin = await run(
        "git", ["remote", "get-url", "origin"],
        {cwd: source, capture: true});
    if (!sameRepository(origin, config.repository)) {
        fail(
            `existing source origin mismatch: expected ${config.repository}, ` +
            `found ${origin}`);
    }
    const head = await run("git", ["rev-parse", "HEAD"], {
        cwd: source,
        capture: true,
    });
    if (head !== config.revision) {
        fail(
            `existing source revision mismatch: expected ${config.revision}, ` +
            `found ${head}`);
    }
    const sourceStatus = await run(
        "git", ["status", "--porcelain", "--untracked-files=all"],
        {cwd: source, capture: true});
    if (sourceStatus !== "") {
        fail(`existing source checkout is dirty: ${source}`);
    }
    const cachePath = path.join(build, "CMakeCache.txt");
    if (!(await exists(cachePath))) {
        fail(`existing build is missing CMakeCache.txt: ${build}`);
    }
    const cacheErrors = existingBuildCacheErrors(
        profile, source, await readFile(cachePath, "utf8"));
    if (cacheErrors.length !== 0) {
        fail(`existing build configuration mismatch:\n${cacheErrors.join("\n")}`);
    }
    for (const name of ["clang", "clang++", "clangd"]) {
        const binary = path.join(build, "bin", executableName(name));
        if (!(await exists(binary))) {
            fail(`existing build is missing ${name}: ${binary}`);
        }
        const version = await run(binary, ["--version"], {capture: true});
        if (!version.includes(config.revision)) {
            fail(
                `existing ${name} does not identify pinned revision ` +
                `${config.revision}: ${binary}`);
        }
    }
}

async function ensureBuildState(config, profile, paths, ucrt64Root) {
    const expected = {
        schemaVersion: 2,
        host: hostIdentity(),
        revision: config.revision,
        qualificationKind: profile.qualificationKind,
        configurationIdentity:
            configurationIdentity(config, profile, ucrt64Root),
    };
    if (await exists(paths.buildState)) {
        const actual = await readJson(paths.buildState);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            fail(`build state mismatch; preserve and inspect ${paths.root} before retrying`);
        }
    } else {
        await atomicJson(paths.buildState, expected);
    }
    return expected;
}

function cmakeArguments(profile, paths, python) {
    const configuration = profile.configuration;
    const args = [
        "-S", path.join(paths.source, "llvm"),
        "-B", paths.build,
        "-G", configuration.generator,
        `-DCMAKE_BUILD_TYPE=${configuration.buildType}`,
        `-DCMAKE_INSTALL_PREFIX=${paths.staging}`,
        `-DLLVM_ENABLE_PROJECTS=${configuration.projects}`,
        `-DLLVM_ENABLE_RUNTIMES=${configuration.runtimes}`,
        `-DLLVM_TARGETS_TO_BUILD=${configuration.targets}`,
        "-DCLANG_DEFAULT_CXX_STDLIB=libc++",
        "-DLLVM_INCLUDE_TESTS=OFF",
        "-DLLVM_INCLUDE_BENCHMARKS=OFF",
        "-DLLVM_INCLUDE_EXAMPLES=OFF",
        "-DLLVM_ENABLE_ZLIB=OFF",
        "-DLLVM_ENABLE_ZSTD=OFF",
        "-DLLVM_ENABLE_LIBXML2=OFF",
        "-DLLVM_ENABLE_CURL=OFF",
        "-DLIBCXX_INSTALL_MODULES=ON",
    ];
    if (configuration.cFlags) {
        args.push(`-DCMAKE_C_FLAGS=${configuration.cFlags}`);
    }
    if (configuration.cxxFlags) {
        args.push(`-DCMAKE_CXX_FLAGS=${configuration.cxxFlags}`);
    }
    if (configuration.linkerFlags) {
        args.push(`-DCMAKE_EXE_LINKER_FLAGS=${configuration.linkerFlags}`);
        args.push(`-DCMAKE_SHARED_LINKER_FLAGS=${configuration.linkerFlags}`);
        args.push(`-DCMAKE_MODULE_LINKER_FLAGS=${configuration.linkerFlags}`);
    }
    if (configuration.staticLinkCxxStdlib === true) {
        args.push("-DLLVM_STATIC_LINK_CXX_STDLIB=ON");
    }
    if (python?.executable) {
        const cmakePython = process.platform === "win32"
            ? python.executable.replaceAll("\\", "/")
            : python.executable;
        args.push(`-DPython3_EXECUTABLE=${cmakePython}`);
    }
    return args;
}

const reflectionSmoke = `#include <array>
#include <cstddef>
#include <meta>

struct MovePolicy {
    unsigned Flags;
    constexpr auto operator<=>(const MovePolicy&) const = default;
};

inline constexpr MovePolicy MoveSerialize{1};
inline constexpr MovePolicy MoveInspect{2};

struct MoveProbe {
    [[=MoveSerialize, =MoveInspect]]
    int Value;
    float Weight;
};

struct MoveGenerated;
consteval {
    std::meta::define_aggregate(^^MoveGenerated, {
        std::meta::data_member_spec(^^int, {.name = "GeneratedValue"}),
        std::meta::data_member_spec(^^float, {.name = "GeneratedWeight"}),
    });
}

consteval bool Probe() {
    static constexpr auto members = std::define_static_array(
        std::meta::nonstatic_data_members_of(
            ^^MoveProbe, std::meta::access_context::current()));
    static constexpr auto annotations = std::define_static_array(
        std::meta::annotations_of(members.front()));
    static constexpr auto policies = std::define_static_array(
        std::meta::annotations_of_with_type(members.front(), ^^MovePolicy));
    if (annotations.size() != 2 || policies.size() != 2) return false;
    unsigned policyFlags = 0;
    for (const std::meta::info policy : policies)
        policyFlags |= std::meta::extract<MovePolicy>(policy).Flags;
    if (policyFlags != 3) return false;
    std::size_t count = 0;
    template for (constexpr std::meta::info member : members) {
        using Field = [:std::meta::type_of(member):];
        if (std::meta::identifier_of(member).empty() ||
            sizeof(Field) == 0) return false;
        ++count;
    }
    return count == 2;
}

static_assert(Probe());
static_assert(sizeof(MoveGenerated) >= sizeof(int) + sizeof(float));
int main() {
    MoveGenerated generated{42, 1.0f};
    return Probe() && generated.GeneratedValue == 42 ? 0 : 1;
}
`;

const importStdReflectionSmoke = `import std;

struct MoveImportedMetaProbe {
    int Value;
};

struct [[=42, =1.0f]] MoveImportedAnnotationProbe {};

static_assert(std::meta::is_class_type(^^MoveImportedMetaProbe));
static_assert(std::meta::annotations_of_with_type(
                  ^^MoveImportedAnnotationProbe, ^^int).size() == 1);
static_assert(std::meta::extract<int>(
                  std::meta::annotations_of_with_type(
                      ^^MoveImportedAnnotationProbe, ^^int)[0]) == 42);
static constexpr auto MoveImportedStaticArray =
    std::define_static_array(std::array{1, 2, 3});
static_assert(MoveImportedStaticArray.size() == 3);
static_assert(MoveImportedStaticArray[2] == 3);
static_assert(std::string_view(std::define_static_string("import std")) ==
              "import std");

int main() {
    std::vector<int> values;
    return values.empty() ? 0 : 1;
}
`;

function qualificationMarker(config, profile, ucrt64Root) {
    return {
        schemaVersion: config.qualificationSchemaVersion,
        qualified: true,
        host: hostIdentity(),
        revision: config.revision,
        qualificationKind: profile.qualificationKind,
        configurationIdentity:
            configurationIdentity(config, profile, ucrt64Root),
    };
}

function prebuiltMarker(marker, config, profile) {
    return marker?.schemaVersion === config.qualificationSchemaVersion &&
        marker.qualified === true &&
        marker.revision === config.revision &&
        marker.host === hostIdentity() &&
        marker.qualificationKind === profile.qualificationKind &&
        typeof marker.configurationIdentity === "string";
}

async function runtimeLibraryDirectory(install) {
    const root = path.join(install, "lib");
    if (!(await exists(root))) return null;
    const candidates = [root];
    for (const entry of await readdir(root, {withFileTypes: true})) {
        if (entry.isDirectory()) {
            candidates.push(path.join(root, entry.name));
        }
    }
    for (const candidate of candidates) {
        const libraries = ["libc++.so", "libc++abi.so", "libunwind.so"];
        const found = await Promise.all(libraries.map(
            (library) => exists(path.join(candidate, library))));
        if (found.every(Boolean)) return candidate;
    }
    return null;
}

async function qualifyImportedStdModule(
    profile, install, smokeRoot, ucrt64Root = null) {
    const clangxx = path.join(install, "bin", executableName("clang++"));
    const clangd = path.join(install, "bin", executableName("clangd"));
    const moduleSource = path.join(
        install, "share", "libc++", "v1", "std.cppm");
    const metaExports = path.join(
        install, "share", "libc++", "v1", "std", "meta.inc");
    for (const required of [clangxx, clangd, moduleSource, metaExports]) {
        if (!(await exists(required))) {
            fail(`import std qualification is missing: ${required}`);
        }
    }
    const moduleRoot = path.join(smokeRoot, "import-std");
    await mkdir(moduleRoot, {recursive: true});
    const source = path.join(moduleRoot, "import_std.cpp");
    const pcm = path.join(moduleRoot, "std.pcm");
    await writeFile(source, importStdReflectionSmoke);
    const common = [
        "-std=c++26",
        "-freflection-latest",
        "-fentity-proxy-reflection",
        "-Wno-reserved-module-identifier",
    ];
    if (profile.qualificationKind === "language-server") {
        common.push(
            `--target=${profile.clangTarget}`,
            `--sysroot=${ucrt64Root}`,
            "-nostdinc++",
            "-isystem", path.join(install, "include", "c++", "v1"));
    } else {
        common.push("-stdlib=libc++");
    }
    await run(clangxx, [...common, "--precompile", moduleSource, "-o", pcm]);
    const importArguments = [...common, `-fmodule-file=std=${pcm}`];
    await run(clangxx, [...importArguments, "-fsyntax-only", source]);
    await writeFile(path.join(moduleRoot, "compile_commands.json"),
        `${JSON.stringify([{
            directory: moduleRoot,
            arguments: [clangxx, ...importArguments, "-c", source],
            file: source,
        }], null, 2)}\n`);
    await run(clangd, [
        `--check=${source}`,
        `--compile-commands-dir=${moduleRoot}`,
    ]);
}

async function qualifyFullToolchain(config, profile, install, scratchRoot = null) {
    const clangxx = path.join(
        install, "bin", executableName("clang++"));
    const clangd = path.join(install, "bin", executableName("clangd"));
    const smokeRoot = scratchRoot ?? path.join(install, "move-smoke");
    await mkdir(smokeRoot, {recursive: true});
    const source = path.join(smokeRoot, "reflection.cpp");
    const executable = path.join(smokeRoot, "reflection");
    const runtimeLibraryDir = await runtimeLibraryDirectory(install);
    if (runtimeLibraryDir === null) {
        fail("qualification could not find the isolated runtime libraries");
    }
    const installLibraryRoot = await realpath(path.join(install, "lib"));
    const runtimeLibraryRoot = await realpath(runtimeLibraryDir);
    const runtimeRelative = path.relative(
        installLibraryRoot, runtimeLibraryRoot);
    if (runtimeRelative === ".." ||
        runtimeRelative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(runtimeRelative)) {
        fail(
            "qualification found runtime libraries outside the isolated " +
            `toolchain: ${runtimeLibraryRoot}`);
    }
    const smokeRuntimeRoot = await realpath(smokeRoot);
    const smokeRuntimeRelative = path.relative(
        smokeRuntimeRoot, runtimeLibraryRoot).split(path.sep).join("/");
    await writeFile(source, reflectionSmoke);
    await run(clangxx, [
        "-std=c++26", "-freflection", "-fannotation-attributes",
        "-fexpansion-statements", "-stdlib=libc++",
        source, "-o", executable,
        `-Wl,-rpath,$ORIGIN/${smokeRuntimeRelative}`,
    ]);
    await run(executable, []);
    const linked = await run("ldd", [executable], {capture: true});
    if (linked.includes("libstdc++")) {
        fail("qualification detected forbidden mixed libstdc++ linkage");
    }
    const linkedLibraries = parseLdd(linked);
    for (const library of ["libc++.so", "libc++abi.so", "libunwind.so"]) {
        const row = linkedLibraries.find((entry) =>
            entry.name === library || entry.name.startsWith(`${library}.`));
        if (!row || row.resolved === "not found" ||
            !path.isAbsolute(row.resolved)) {
            fail(
                `qualification did not resolve ${library} from the ` +
                "isolated toolchain");
        }
        const resolved = await realpath(row.resolved);
        const relative = path.relative(runtimeLibraryRoot, resolved);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)) {
            fail(
                `qualification resolved ${library} outside the isolated ` +
                `toolchain: ${resolved}`);
        }
    }
    const database = [{
        directory: smokeRoot,
        arguments: [
            clangxx, "-std=c++26", "-freflection", "-stdlib=libc++",
            "-fannotation-attributes", "-fexpansion-statements",
            "-c", source,
        ],
        file: source,
    }];
    await writeFile(
        path.join(smokeRoot, "compile_commands.json"),
        `${JSON.stringify(database, null, 2)}\n`);
    await run(clangd, [
        `--check=${source}`,
        `--compile-commands-dir=${smokeRoot}`,
    ]);
    await qualifyImportedStdModule(profile, install, smokeRoot);
    return qualificationMarker(config, profile, null);
}

async function stageLibcxxHeaders(profile, paths) {
    if (!profile.stageLibcxxHeaders) return;
    const source = path.join(paths.source, "libcxx", "include");
    const generated = path.join(paths.build, "include", "c++", "v1");
    const destination = path.join(paths.staging, "include", "c++", "v1");
    for (const required of [
        path.join(source, "meta"),
        path.join(generated, "__config_site"),
    ]) {
        if (!(await exists(required))) {
            fail(`libc++ header staging is missing: ${required}`);
        }
    }
    await mkdir(destination, {recursive: true});
    for (const root of [source, generated]) {
        for (const entry of await readdir(root)) {
            await cp(
                path.join(root, entry),
                path.join(destination, entry),
                {recursive: true, force: true});
        }
    }
}

async function installLibcxxModules(profile, paths, jobs) {
    if (!profile.configuration.runtimes.split(";").includes("libcxx")) return;
    if (profile.stageLibcxxHeaders) {
        const generated = path.join(paths.build, "modules", "c++", "v1");
        const source = path.join(paths.source, "libcxx", "modules");
        const destination = path.join(paths.staging, "share", "libc++", "v1");
        const libraryDestination = path.join(paths.staging, "lib");
        for (const required of [
            path.join(generated, "CMakeLists.txt"),
            path.join(generated, "std.cppm"),
            path.join(generated, "std.compat.cppm"),
            path.join(paths.build, "lib", "libc++.modules.json"),
            path.join(source, "std", "meta.inc"),
        ]) {
            if (!(await exists(required))) {
                fail(`libc++ module staging is missing: ${required}`);
            }
        }
        await mkdir(destination, {recursive: true});
        await mkdir(libraryDestination, {recursive: true});
        for (const file of ["CMakeLists.txt", "std.cppm", "std.compat.cppm"]) {
            await cp(path.join(generated, file), path.join(destination, file),
                {force: true});
        }
        for (const directory of ["std", "std.compat"]) {
            await cp(path.join(source, directory), path.join(destination, directory),
                {recursive: true, force: true});
        }
        await cp(
            path.join(paths.build, "lib", "libc++.modules.json"),
            path.join(libraryDestination, "libc++.modules.json"),
            {force: true});
    } else {
        await run("cmake", [
            "--build", paths.build,
            "--target", "runtimes-configure",
            "--parallel", String(jobs),
        ]);
        const runtimeBuild = path.join(paths.build, "runtimes", "runtimes-bins");
        await run("cmake", [
            "--build", runtimeBuild,
            "--target", "install-cxx-modules",
            "--parallel", String(jobs),
        ]);
    }
    for (const required of [
        path.join(paths.staging, "share", "libc++", "v1", "std.cppm"),
        path.join(paths.staging, "share", "libc++", "v1", "std", "meta.inc"),
    ]) {
        if (!(await exists(required))) fail(`libc++ module installation is missing: ${required}`);
    }
}

async function qualifyLanguageServer(
    config, profile, install, ucrt64Root, scratchRoot = null) {
    const clangxx = path.join(
        install, "bin", executableName("clang++"));
    const clangd = path.join(install, "bin", executableName("clangd"));
    const libcxxInclude = path.join(install, "include", "c++", "v1");
    const metaHeader = path.join(libcxxInclude, "meta");
    for (const required of [clangxx, clangd, metaHeader]) {
        if (!(await exists(required))) {
            fail(`Windows language-server qualification is missing: ${required}`);
        }
    }
    const smokeRoot = scratchRoot ?? path.join(install, "move-smoke");
    await mkdir(smokeRoot, {recursive: true});
    const source = path.join(smokeRoot, "reflection.cpp");
    await writeFile(source, reflectionSmoke);
    const compileArguments = [
        clangxx,
        `--target=${profile.clangTarget}`,
        `--sysroot=${ucrt64Root}`,
        "-nostdinc++",
        "-isystem", libcxxInclude,
        "-std=c++26",
        "-freflection",
        "-fannotation-attributes",
        "-fexpansion-statements",
        "-c", source,
    ];
    await run(clangxx, [...compileArguments.slice(1), "-fsyntax-only"]);
    const database = [{
        directory: smokeRoot,
        arguments: compileArguments,
        file: source,
    }];
    await writeFile(
        path.join(smokeRoot, "compile_commands.json"),
        `${JSON.stringify(database, null, 2)}\n`);
    await run(clangd, [
        `--check=${source}`,
        `--compile-commands-dir=${smokeRoot}`,
    ]);
    await qualifyImportedStdModule(
        profile, install, smokeRoot, ucrt64Root);
    return qualificationMarker(config, profile, ucrt64Root);
}

async function qualify(config, profile, install, ucrt64Root, scratchRoot = null) {
    if (profile.qualificationKind === "full-toolchain") {
        return await qualifyFullToolchain(
            config, profile, install, scratchRoot);
    }
    if (profile.qualificationKind === "language-server") {
        return await qualifyLanguageServer(
            config, profile, install, ucrt64Root, scratchRoot);
    }
    fail(`unsupported qualification kind: ${profile.qualificationKind}`);
}

async function adopt(
    config, profile, flags, toolchainRoot, ucrt64Root) {
    if (!flags.has("--accept-prebuilt")) {
        fail(
            "adopt executes binaries from a trusted prebuilt; verify its " +
            "checksum, then pass --accept-prebuilt");
    }
    const paths = pathsFor(config, toolchainRoot);
    const marker = await readQualification(paths.install);
    if (!prebuiltMarker(marker, config, profile)) {
        fail(
            "prebuilt marker does not match the pinned revision, host, " +
            `qualification schema, or profile: ${paths.install}`);
    }
    const identity = configurationIdentity(config, profile, ucrt64Root);
    await acquireLock(paths.lock, identity);
    let lockOwned = true;
    const release = async () => {
        if (lockOwned) {
            lockOwned = false;
            await rm(paths.lock, {recursive: true, force: true});
        }
    };
    try {
        const lockedMarker = await readQualification(paths.install);
        if (!prebuiltMarker(lockedMarker, config, profile)) {
            fail("prebuilt marker changed while acquiring the install lock");
        }
        const scratch = await mkdtemp(path.join(paths.root, "adopt-smoke-"));
        try {
            const adoptedMarker = await qualify(
                config, profile, paths.install, ucrt64Root, scratch);
            throwIfInterrupted();
            await atomicJson(paths.localQualification, adoptedMarker);
        } finally {
            await rm(scratch, {recursive: true, force: true});
        }
        console.log("trusted prebuilt qualified for this host");
        console.log("run configure to select it for development");
    } finally {
        await release();
    }
}

async function install(
    config, profile, flags, values, toolchainRoot, ucrt64Root) {
    if (!flags.has("--accept-cost")) {
        fail("install requires --accept-cost after reviewing help and doctor");
    }
    const paths = pathsFor(config, toolchainRoot);
    const existing = await readEffectiveQualification(paths);
    if (qualifiedMarker(existing, config, profile, ucrt64Root)) {
        console.log("matching qualified installation already exists");
        return;
    }
    if (!(await doctor(
        config, profile, toolchainRoot, ucrt64Root))) {
        fail("doctor reported missing prerequisites, unsupported host, or insufficient disk");
    }
    const python = findPython();
    const jobs = resolveJobs(values);
    const identity = configurationIdentity(config, profile, ucrt64Root);
    console.log(`source: ${paths.source}`);
    console.log(`build: ${paths.build}`);
    console.log(`staging: ${paths.staging}`);
    console.log(`install: ${paths.install}`);
    console.log(`configuration: ${identity}`);
    console.log(`qualification: ${profile.qualificationKind}`);
    console.log(`parallel jobs: ${jobs}`);
    await mkdir(paths.root, {recursive: true});
    await acquireLock(paths.lock, identity);
    let ownsLock = true;
    const release = async () => {
        if (ownsLock) {
            ownsLock = false;
            await rm(paths.lock, {recursive: true, force: true});
        }
    };
    const signal = (name) => {
        interruptedSignal ??= name;
        if (activeChild && !activeChild.killed) {
            activeChild.kill(name);
        }
    };
    process.once("SIGINT", () => signal("SIGINT"));
    process.once("SIGTERM", () => signal("SIGTERM"));
    try {
        const lockedExisting = await readQualification(paths.install);
        if (qualifiedMarker(
            lockedExisting, config, profile, ucrt64Root)) {
            await rm(paths.localQualification, {force: true});
            console.log("matching qualified installation already exists");
            return;
        }
        if (await exists(paths.install)) {
            fail(`unqualified installation exists and was preserved: ${paths.install}`);
        }
        await rm(paths.localQualification, {force: true});
        await ensureSource(config, paths);
        await ensureBuildState(config, profile, paths, ucrt64Root);
        await mkdir(paths.staging, {recursive: true});
        await run("cmake", cmakeArguments(profile, paths, python));
        await run("cmake", [
            "--build", paths.build, "--target",
            ...profile.installTargets,
            "--parallel", String(jobs),
        ]);
        await installLibcxxModules(profile, paths, jobs);
        await stageLibcxxHeaders(profile, paths);
        const stagingMarker = await qualify(
            config, profile, paths.staging, ucrt64Root);
        throwIfInterrupted();
        await atomicJson(
            path.join(paths.staging, "move-qualification.json"),
            stagingMarker);
        throwIfInterrupted();
        await rename(paths.staging, paths.install);
        try {
            const installedMarker = await qualify(
                config, profile, paths.install, ucrt64Root);
            throwIfInterrupted();
            await atomicJson(
                path.join(paths.install, "move-qualification.json"),
                installedMarker);
        } catch (error) {
            const quarantine =
                `${paths.install}.failed-${Date.now()}`;
            await rename(paths.install, quarantine);
            fail(`post-publication qualification failed; preserved at ${quarantine}: ${error.message}`);
        }
        console.log("qualified experimental toolchain installed");
        console.log("run configure to select it for development");
    } finally {
        await release();
    }
}

async function importBuild(
    config, profile, flags, values, toolchainRoot, ucrt64Root) {
    if (!flags.has("--accept-existing-build")) {
        fail(
            "import-build executes an existing compiler build; inspect its " +
            "source and cache, then pass --accept-existing-build");
    }
    for (const name of ["--source", "--build"]) {
        if (!values.has(name)) fail(`import-build requires ${name} PATH`);
    }
    const source = path.resolve(values.get("--source"));
    const build = path.resolve(values.get("--build"));
    const paths = pathsFor(config, toolchainRoot);
    const existing = await readEffectiveQualification(paths);
    if (qualifiedMarker(existing, config, profile, ucrt64Root)) {
        console.log("matching qualified installation already exists");
        return;
    }
    const python = findPython();
    const jobs = resolveJobs(values);
    const identity = configurationIdentity(config, profile, ucrt64Root);
    await verifyExistingBuild(config, profile, source, build);
    console.log(`existing source: ${source}`);
    console.log(`existing build: ${build}`);
    console.log(`staging: ${paths.staging}`);
    console.log(`install: ${paths.install}`);
    console.log(`configuration: ${identity}`);
    await mkdir(paths.root, {recursive: true});
    await acquireLock(paths.lock, identity);
    let ownsLock = true;
    const release = async () => {
        if (ownsLock) {
            ownsLock = false;
            await rm(paths.lock, {recursive: true, force: true});
        }
    };
    try {
        await rm(paths.localQualification, {force: true});
        if (await exists(paths.install)) {
            fail(`unqualified installation exists and was preserved: ${paths.install}`);
        }
        if (await exists(paths.staging)) {
            fail(`existing staging directory was preserved: ${paths.staging}`);
        }
        const externalPaths = {...paths, source, build};
        await mkdir(paths.staging, {recursive: true});
        await run("cmake", cmakeArguments(profile, externalPaths, python));
        await run("cmake", [
            "--build", build, "--target", ...profile.installTargets,
            "--parallel", String(jobs),
        ]);
        await installLibcxxModules(profile, externalPaths, jobs);
        await stageLibcxxHeaders(profile, externalPaths);
        const stagingMarker = await qualify(
            config, profile, paths.staging, ucrt64Root);
        await atomicJson(
            path.join(paths.staging, "move-qualification.json"),
            stagingMarker);
        await rename(paths.staging, paths.install);
        try {
            const installedMarker = await qualify(
                config, profile, paths.install, ucrt64Root);
            await atomicJson(
                path.join(paths.install, "move-qualification.json"),
                installedMarker);
        } catch (error) {
            const quarantine = `${paths.install}.failed-${Date.now()}`;
            await rename(paths.install, quarantine);
            fail(
                "post-publication qualification failed; preserved at " +
                `${quarantine}: ${error.message}`);
        }
        console.log("existing Release build imported and qualified");
        console.log("run configure to select it for development");
    } finally {
        await release();
    }
}

async function configure(
    config, profile, flags, toolchainRoot, ucrt64Root) {
    const paths = pathsFor(config, toolchainRoot);
    const marker = await readEffectiveQualification(paths);
    if (!qualifiedMarker(marker, config, profile, ucrt64Root)) {
        fail("no matching qualified installation; run status or install");
    }
    const binary = (name) => path.join(
        paths.install, "bin", executableName(name));
    const libcxxLibraryDir = profile.qualificationKind === "full-toolchain"
        ? await runtimeLibraryDirectory(paths.install)
        : null;
    if (profile.qualificationKind === "full-toolchain" &&
        libcxxLibraryDir === null) {
        fail("qualified installation is missing its runtime libraries");
    }
    const record = {
        schemaVersion: 2,
        mode: "clang-p2996",
        qualified: true,
        experimental: true,
        host: hostIdentity(),
        qualificationKind: profile.qualificationKind,
        repository: config.repository,
        revision: config.revision,
        configurationIdentity:
            configurationIdentity(config, profile, ucrt64Root),
        configuration: profile.configuration,
        toolchainRoot,
        installDir: paths.install,
        clang: binary("clang"),
        clangxx: binary("clang++"),
        clangd: binary("clangd"),
        libcxxIncludeDir: path.join(paths.install, "include", "c++", "v1"),
        libcxxLibraryDir,
        ucrt64Root,
        clangTarget: profile.clangTarget ?? null,
    };
    if (await exists(selectionPath)) {
        const current = await readJson(selectionPath);
        if (JSON.stringify(current) === JSON.stringify(record)) {
            console.log(`configuration already current: ${selectionPath}`);
            return;
        }
        if (!flags.has("--force")) {
            fail(`configuration differs and was preserved: ${selectionPath}; pass --force to replace this Move-owned local file`);
        }
    }
    await atomicJson(selectionPath, record);
    console.log(`wrote Move-owned local configuration: ${selectionPath}`);
    console.log("GCC remains the compiler; enable only the language server:");
    console.log("  xmake f --mv_reflection_language_server=clang-p2996");
    console.log("native experimental clangd:");
    console.log(`  ${record.clangd} --compile-commands-dir=build/reflection/native`);
    console.log("tracked editor configuration was not changed");
}

async function main() {
    const {command, flags, values} = parseArguments(process.argv.slice(2));
    validateCommandArguments(command, flags, values);
    if (command === "help" || command === "--help" || command === "-h") {
        usage();
        return;
    }
    const config = await readConfiguration();
    const profile = hostProfile(config);
    if (!profile) {
        fail(`clang-p2996 is not configured for host ${hostIdentity()}`);
    }
    const toolchainRoot = resolveToolchainRoot(values);
    const ucrt64Root = resolveUcrt64Root(values);
    if (command === "doctor") {
        if (!(await doctor(
            config, profile, toolchainRoot, ucrt64Root))) {
            process.exitCode = 2;
        }
        return;
    }
    if (command === "status") {
        await status(config, profile, toolchainRoot, ucrt64Root);
        return;
    }
    if (command === "install") {
        await install(
            config, profile, flags, values, toolchainRoot, ucrt64Root);
        return;
    }
    if (command === "import-build") {
        await importBuild(
            config, profile, flags, values, toolchainRoot, ucrt64Root);
        return;
    }
    if (command === "adopt") {
        await adopt(
            config, profile, flags, toolchainRoot, ucrt64Root);
        return;
    }
    if (command === "configure") {
        await configure(
            config, profile, flags, toolchainRoot, ucrt64Root);
        return;
    }
    fail(`unknown command: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
    main().catch((error) => {
        console.error(`error: ${error.message}`);
        process.exitCode = error.exitCode ?? 1;
    });
}
