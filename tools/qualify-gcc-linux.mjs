#!/usr/bin/env node

import {spawnSync} from "node:child_process";
import {cp, mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {auditElfTree} from "./elf-compatibility.mjs";
import {detectLinuxLibc} from "./host-compatibility.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const expectedRevision = "ced2ae7f6670c0371e0464e5aaa888c44ebd012a";
const expectedTree = "57f5cc6c172e3e3e08a66c4f1efcf032c84c0b65";
const probeRevision = "06105d7c2cc9fa78c6db10231ace8c6847cadb67";

function fail(message) {
    throw new Error(message);
}

function usage() {
    console.log(`Qualify a staged Linux Move GCC installation

Usage:
  node tools/qualify-gcc-linux.mjs --install-root PATH --source-root PATH
      --minimum-glibc VERSION --probe-root PATH --xmake PATH
      [--scratch-root PATH] [--json]

The staged installation is compiled and executed through ordinary C, C++26
reflection, C++ modules, the focused GCC reflect-2/3/4 regressions, and the
exact Nez imported-namespace probe. Every shipped ELF is also checked against
the declared glibc floor and isolated runtime closure.`);
}

export function parseArguments(argv) {
    const values = new Map();
    const flags = new Set();
    for (let index = 0; index < argv.length; index += 1) {
        const name = argv[index];
        if (["--help", "-h"].includes(name)) return {help: true, flags, values};
        if (name === "--json") {
            if (flags.has(name)) fail(`duplicate argument: ${name}`);
            flags.add(name);
            continue;
        }
        if (!["--install-root", "--source-root", "--minimum-glibc",
            "--probe-root", "--xmake", "--scratch-root"].includes(name)) {
            fail(`unknown argument: ${name}`);
        }
        if (values.has(name)) fail(`duplicate argument: ${name}`);
        const value = argv[++index];
        if (!value || value.startsWith("--")) fail(`${name} requires a value`);
        values.set(name, value);
    }
    for (const required of ["--install-root", "--source-root",
        "--minimum-glibc", "--probe-root", "--xmake"]) {
        if (!values.has(required)) fail(`${required} is required`);
    }
    return {help: false, flags, values};
}

function run(command, argumentsValue, options = {}) {
    const result = spawnSync(command, argumentsValue, {
        cwd: options.cwd,
        encoding: "utf8",
        env: options.env,
        maxBuffer: 128 * 1024 * 1024,
        stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    if (result.error) fail(`${command} could not start: ${result.error.message}`);
    if (result.status !== 0) {
        const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        fail(`${command} exited with ${result.status}${detail ? `: ${detail}` : ""}`);
    }
    return (result.stdout ?? "").trim();
}

async function compilerIdentity(install, environment) {
    const compiler = path.join(install, "bin", "g++");
    const version = run(compiler, ["--version"], {env: environment});
    const fullVersion = run(compiler, ["-dumpfullversion"], {env: environment});
    const target = run(compiler, ["-dumpmachine"], {env: environment});
    if (!version.includes("Move GCC 16.2.0 move.1") ||
        fullVersion !== "16.2.0" || target !== "x86_64-pc-linux-gnu") {
        fail(`unexpected Move GCC identity: ${version.split(/\r?\n/)[0]}, ${target}`);
    }
    return {version: version.split(/\r?\n/)[0], fullVersion, target};
}

async function writeSources(root) {
    await writeFile(path.join(root, "c-smoke.c"),
        "#include <stdio.h>\nint main(void) { puts(\"move-gcc-c\"); return 0; }\n");
    await writeFile(path.join(root, "cxx-smoke.cpp"),
        "#include <string>\n#include <vector>\nint main() { std::vector<std::string> v{\"move\"}; return v[0] == \"move\" ? 0 : 1; }\n");
    await writeFile(path.join(root, "reflection-smoke.cpp"), `#include <meta>
#include <string_view>

struct Record { int Value; };

consteval bool Reflects()
{
    constexpr auto members = std::meta::nonstatic_data_members_of(
        ^^Record, std::meta::access_context::unchecked());
    return members.size() == 1 && members[0] == ^^Record::Value &&
        std::meta::identifier_of(members[0]) == std::string_view("Value");
}

static_assert(Reflects());
int main() { return Reflects() ? 0 : 1; }
`);
    await writeFile(path.join(root, "move.smoke.cppm"), `export module Move.Smoke;
export int MoveSmoke() { return 42; }
`);
    await writeFile(path.join(root, "module-smoke.cpp"), `import Move.Smoke;
int main() { return MoveSmoke() == 42 ? 0 : 1; }
`);
}

function compileAndRun(compiler, argumentsValue, output, environment, cwd) {
    run(compiler, [...argumentsValue, "-o", output], {cwd, env: environment});
    run(output, [], {cwd, env: environment});
}

async function ordinaryCases(install, scratch, environment) {
    await writeSources(scratch);
    const gcc = path.join(install, "bin", "gcc");
    const gxx = path.join(install, "bin", "g++");
    compileAndRun(gcc, ["-std=c11", "c-smoke.c"],
        path.join(scratch, "c-smoke"), environment, scratch);
    compileAndRun(gxx, ["-std=c++26", "cxx-smoke.cpp"],
        path.join(scratch, "cxx-smoke"), environment, scratch);
    compileAndRun(gxx, ["-std=c++26", "-freflection", "reflection-smoke.cpp"],
        path.join(scratch, "reflection-smoke"), environment, scratch);
    run(gxx, ["-std=c++26", "-fmodules", "-x", "c++", "-c",
        "move.smoke.cppm", "-o", "move.smoke.o"], {cwd: scratch, env: environment});
    compileAndRun(gxx, ["-std=c++26", "-fmodules", "module-smoke.cpp",
        "move.smoke.o"], path.join(scratch, "module-smoke"), environment, scratch);
}

async function focusedGccCases(install, source, scratch, environment) {
    const sourceDirectory = path.join(source, "gcc", "testsuite", "g++.dg", "modules");
    const compiler = path.join(install, "bin", "g++");
    for (const group of ["reflect-2", "reflect-3", "reflect-4"]) {
        const destination = path.join(scratch, group);
        await mkdir(destination);
        const names = group === "reflect-2"
            ? ["reflect-2_a.H", "reflect-2_b.C", "reflect-2_c.C"]
            : group === "reflect-3"
                ? ["reflect-3_a.H", "reflect-3_b.C", "reflect-3_c.C"]
                : ["reflect-4_a.C", "reflect-4_b.C"];
        for (const name of names) {
            await cp(path.join(sourceDirectory, name), path.join(destination, name));
        }
        if (group !== "reflect-4") {
            run(compiler, ["-std=c++26", "-fmodules", "-freflection",
                "-fmodule-header", "-x", "c++-header", names[0]],
            {cwd: destination, env: environment});
        }
        const start = group === "reflect-4" ? 0 : 1;
        for (const name of names.slice(start)) {
            run(compiler, ["-std=c++26", "-fmodules", "-freflection",
                "-Wno-global-module", "-c", name],
            {cwd: destination, env: environment});
        }
    }
}

function exactProbe(probeRoot, xmake, install, scratch, environment) {
    const revision = run("git", ["rev-parse", "HEAD"], {
        cwd: probeRoot, env: environment,
    });
    if (revision !== probeRevision) {
        fail(`Nez imported-namespace probe must be exact commit ${probeRevision}`);
    }
    const changes = run("git", ["status", "--porcelain", "--untracked-files=no"], {
        cwd: probeRoot, env: environment,
    });
    if (changes) fail("Nez imported-namespace probe has tracked modifications");
    const config = path.join(scratch, "xmake-config");
    const output = path.join(scratch, "xmake-build");
    const probe = path.join(probeRoot, "tests", "toolchain", "cxx_modules_reflection");
    const probeEnvironment = {
        ...environment,
        XMAKE_CONFIGDIR: config,
        CC: path.join(install, "bin", "gcc"),
        CXX: path.join(install, "bin", "g++"),
    };
    run(xmake, ["f", "-P", probe, "-p", "linux", "-a", "x86_64",
        "-m", "release", "-o", output, "-c", "-y"], {
        cwd: probeRoot, env: probeEnvironment, inherit: true,
    });
    run(xmake, ["-P", probe, "-r", "move_module_probe"], {
        cwd: probeRoot, env: probeEnvironment, inherit: true,
    });
    run(xmake, ["run", "-P", probe, "move_module_probe"], {
        cwd: probeRoot, env: probeEnvironment, inherit: true,
    });
}

export async function qualifyLinuxGcc(options) {
    if (process.platform !== "linux" || process.arch !== "x64") {
        fail("Linux GCC qualification requires native Linux x64");
    }
    const install = path.resolve(options.installRoot);
    const source = path.resolve(options.sourceRoot);
    const probeRoot = path.resolve(options.probeRoot);
    const xmake = path.resolve(options.xmake);
    const libc = detectLinuxLibc();
    if (libc.family !== "glibc" || libc.version !== options.minimumGlibc) {
        fail(`qualification requires glibc ${options.minimumGlibc}; found ${libc.family} ${libc.version}`);
    }
    const sourceRevision = run("git", ["rev-parse", "HEAD"], {cwd: source});
    const sourceTree = run("git", ["write-tree"], {cwd: source});
    if (sourceRevision !== expectedRevision || sourceTree !== expectedTree) {
        fail("GCC qualification source identity disagrees with the pinned release");
    }
    const scratch = options.scratchRoot
        ? path.resolve(options.scratchRoot)
        : await mkdtemp(path.join(tmpdir(), "move gcc qualification with spaces "));
    if (options.scratchRoot) await mkdir(scratch);
    const environment = {
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        HOME: process.env.HOME,
        PATH: `${path.join(install, "bin")}:/usr/bin:/bin`,
        LD_LIBRARY_PATH: [path.join(install, "lib64"), path.join(install, "lib")]
            .join(":"),
    };
    try {
        const identity = await compilerIdentity(install, environment);
        await ordinaryCases(install, scratch, environment);
        await focusedGccCases(install, source, scratch, environment);
        exactProbe(probeRoot, xmake, install, scratch, environment);
        const audit = await auditElfTree(install, options.minimumGlibc);
        return {
            identity,
            elfAudit: audit,
            qualification: {
                schemaVersion: 1,
                cases: [
                    "c11-smoke", "cxx-smoke", "cxx26-reflection",
                    "cxx20-modules", "imported-namespace-reflection",
                    "gcc-reflect-2", "gcc-reflect-3", "gcc-reflect-4",
                    "staged-prefix-independence", "runtime-closure",
                ].map((id) => ({id, required: true, status: "passed"})),
            },
        };
    } finally {
        if (!options.scratchRoot) await rm(scratch, {recursive: true, force: true});
    }
}

async function main() {
    const parsed = parseArguments(process.argv.slice(2));
    if (parsed.help) return usage();
    const result = await qualifyLinuxGcc({
        installRoot: parsed.values.get("--install-root"),
        sourceRoot: parsed.values.get("--source-root"),
        minimumGlibc: parsed.values.get("--minimum-glibc"),
        probeRoot: parsed.values.get("--probe-root"),
        xmake: parsed.values.get("--xmake"),
        scratchRoot: parsed.values.get("--scratch-root"),
    });
    if (parsed.flags.has("--json")) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        console.log(`qualified: ${result.identity.version}`);
        console.log(`ELF files: ${result.elfAudit.elfCount}`);
        console.log(`newest required glibc: ${result.elfAudit.newestRequiredGlibc}`);
    }
}

if (path.resolve(process.argv[1] ?? "") === scriptPath) {
    main().catch((error) => {
        console.error(`error: ${error.message}`);
        process.exitCode = 1;
    });
}
