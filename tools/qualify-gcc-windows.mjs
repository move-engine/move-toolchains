#!/usr/bin/env node

import {spawnSync} from "node:child_process";
import {cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const expectedRevision = "ced2ae7f6670c0371e0464e5aaa888c44ebd012a";
const expectedTree = "72b9079edba262c4555fd5eb514d7726c3d15500";
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

function fail(message) { throw new Error(message); }

function usage() {
    console.log(`Qualify a staged native Windows Move GCC installation

Usage:
  node tools/qualify-gcc-windows.mjs --install-root PATH --source-root PATH
      --probe-root PATH --xmake PATH [--scratch-root PATH] [--json]

The installation is exercised through ordinary C, C++26 reflection, C++
modules, the focused GCC reflect-2/3/4 regressions, the exact Nez imported-
namespace probe, the Win64 PR54412 alignment regressions, and an isolated PE
runtime-closure audit.`);
}

export function parseArguments(argv) {
    const values = new Map();
    const flags = new Set();
    for (let index = 0; index < argv.length; ++index) {
        const name = argv[index];
        if (["--help", "-h"].includes(name)) return {help: true, values, flags};
        if (name === "--json") {
            if (flags.has(name)) fail(`duplicate argument: ${name}`);
            flags.add(name);
            continue;
        }
        if (!["--install-root", "--source-root", "--probe-root", "--xmake",
            "--scratch-root"].includes(name)) fail(`unknown argument: ${name}`);
        if (values.has(name)) fail(`duplicate argument: ${name}`);
        const value = argv[++index];
        if (!value || value.startsWith("--")) fail(`${name} requires a value`);
        values.set(name, value);
    }
    for (const required of ["--install-root", "--source-root", "--probe-root",
        "--xmake"]) {
        if (!values.has(required)) fail(`${required} is required`);
    }
    return {help: false, values, flags};
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

function importedDlls(objdump, file, environment) {
    return [...run(objdump, ["-p", file], {env: environment})
        .matchAll(/DLL Name:\s*([^\r\n]+)/g)]
        .map((match) => match[1].trim().toLowerCase());
}

export async function auditWindowsPeTree(install, environment) {
    const binaryDirectory = path.join(install, "bin");
    const objdump = path.join(binaryDirectory, "objdump.exe");
    const available = new Set((await readdir(binaryDirectory))
        .filter((name) => name.toLowerCase().endsWith(".dll"))
        .map((name) => name.toLowerCase()));
    const graph = {};
    for (const file of (await recursiveFiles(install)).filter((candidate) =>
        [".dll", ".exe"].includes(path.extname(candidate).toLowerCase()))) {
        const relative = path.relative(install, file).replaceAll("\\", "/");
        const imports = importedDlls(objdump, file, environment);
        for (const dependency of imports) {
            if (available.has(dependency) || systemDlls.has(dependency) ||
                dependency.startsWith("api-ms-win-") ||
                dependency.startsWith("ext-ms-win-")) continue;
            fail(`${relative} has unresolved non-system import ${dependency}`);
        }
        graph[relative] = imports;
    }
    for (const required of ["libatomic-1.dll", "libgcc_s_seh-1.dll",
        "libgomp-1.dll", "libstdc++-6.dll"]) {
        if (!available.has(required)) fail(`required GCC runtime is absent: ${required}`);
    }
    return graph;
}

async function compilerIdentity(install, environment) {
    const compiler = path.join(install, "bin", "g++.exe");
    const version = run(compiler, ["--version"], {env: environment});
    const fullVersion = run(compiler, ["-dumpfullversion"], {env: environment});
    const target = run(compiler, ["-dumpmachine"], {env: environment});
    if (!version.includes("Move GCC 16.2.0 move.2") ||
        fullVersion !== "16.2.0" || target !== "x86_64-w64-mingw32") {
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
consteval bool Reflects() {
    auto members = std::meta::nonstatic_data_members_of(
        ^^Record, std::meta::access_context::unchecked());
    return members.size() == 1 && members[0] == ^^Record::Value &&
        std::meta::identifier_of(members[0]) == std::string_view("Value");
}
static_assert(Reflects());
int main() { return Reflects() ? 0 : 1; }
`);
    await writeFile(path.join(root, "move.smoke.cppm"),
        "export module Move.Smoke;\nexport int MoveSmoke() { return 42; }\n");
    await writeFile(path.join(root, "module-smoke.cpp"),
        "import Move.Smoke;\nint main() { return MoveSmoke() == 42 ? 0 : 1; }\n");
}

function compileAndRun(compiler, argumentsValue, output, environment, cwd) {
    run(compiler, [...argumentsValue, "-o", output], {cwd, env: environment});
    run(output, [], {cwd, env: environment});
}

async function ordinaryCases(install, scratch, environment) {
    await writeSources(scratch);
    const gcc = path.join(install, "bin", "gcc.exe");
    const gxx = path.join(install, "bin", "g++.exe");
    compileAndRun(gcc, ["-std=c11", "c-smoke.c"],
        path.join(scratch, "c-smoke.exe"), environment, scratch);
    compileAndRun(gxx, ["-std=c++26", "cxx-smoke.cpp"],
        path.join(scratch, "cxx-smoke.exe"), environment, scratch);
    compileAndRun(gxx, ["-std=c++26", "-freflection", "reflection-smoke.cpp"],
        path.join(scratch, "reflection-smoke.exe"), environment, scratch);
    run(gxx, ["-std=c++26", "-fmodules", "-x", "c++", "-c",
        "move.smoke.cppm", "-o", "move.smoke.o"], {cwd: scratch, env: environment});
    compileAndRun(gxx, ["-std=c++26", "-fmodules", "module-smoke.cpp",
        "move.smoke.o"], path.join(scratch, "module-smoke.exe"), environment, scratch);
}

async function focusedGccCases(install, source, scratch, environment) {
    const sourceDirectory = path.join(source, "gcc", "testsuite", "g++.dg", "modules");
    const compiler = path.join(install, "bin", "g++.exe");
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
        for (const name of names.slice(group === "reflect-4" ? 0 : 1)) {
            run(compiler, ["-std=c++26", "-fmodules", "-freflection",
                "-Wno-global-module", "-c", name],
            {cwd: destination, env: environment});
        }
    }
}

function exactProbe(probeRoot, xmake, install, scratch, environment) {
    const revision = run("git", ["rev-parse", "HEAD"], {cwd: probeRoot});
    if (revision !== probeRevision) {
        fail(`Nez imported-namespace probe must be exact commit ${probeRevision}`);
    }
    if (run("git", ["status", "--porcelain", "--untracked-files=no"],
        {cwd: probeRoot})) {
        fail("Nez imported-namespace probe has tracked modifications");
    }
    const probe = path.join(probeRoot, "tests", "toolchain", "cxx_modules_reflection");
    const probeEnvironment = {
        ...environment,
        XMAKE_CONFIGDIR: path.join(scratch, "xmake-config"),
        CC: path.join(install, "bin", "gcc.exe"),
        CXX: path.join(install, "bin", "g++.exe"),
    };
    run(xmake, ["f", "-P", probe, "-p", "mingw", "-a", "x86_64",
        "--mingw=" + install, "-m", "release", "-o",
        path.join(scratch, "xmake-build"), "-c", "-y"], {
        cwd: probeRoot, env: probeEnvironment, inherit: true,
    });
    run(xmake, ["-P", probe, "-r", "move_module_probe"], {
        cwd: probeRoot, env: probeEnvironment, inherit: true,
    });
    run(xmake, ["run", "-P", probe, "move_module_probe"], {
        cwd: probeRoot, env: probeEnvironment, inherit: true,
    });
}

async function win64AlignmentCases(install, source, scratch, environment) {
    const compiler = path.join(install, "bin", "g++.exe");
    const tests = path.join(source, "gcc", "testsuite", "g++.target", "i386");
    const anonymous = ["pr54412-anonymous-temp.C", "pr54412-anonymous-temp-2.C"];
    for (const name of anonymous) {
        const assembly = path.join(scratch, `${name}.s`);
        run(compiler, ["-O2", "-mavx2", "-masm=intel", "-std=gnu++17",
            "-fno-omit-frame-pointer", ...(name.endsWith("-2.C")
                ? ["-fno-strict-aliasing"] : []), "-S", path.join(tests, name),
            "-o", assembly], {cwd: scratch, env: environment});
        const text = await readFile(assembly, "utf8");
        if (/vmovdqa\s+YMMWORD PTR -\d+\[rbp\]/i.test(text) ||
            /lea\s+r8,\s*63\[rsp\][\s\S]{0,160}and\s+r8,\s*-32[\s\S]{0,240}vmovdqa\s+YMMWORD PTR \[r8\],\s*ymm0/i.test(text)) {
            fail(`${name} contains the unsafe PR54412 aligned-store sequence`);
        }
    }
    compileAndRun(compiler, ["-O2", "-mavx2", "-std=gnu++17",
        "-fno-omit-frame-pointer", path.join(tests, "pr54412-overaligned-byref.C")],
    path.join(scratch, "pr54412-overaligned-byref.exe"), environment, scratch);
}

export async function qualifyWindowsGcc(options) {
    if (process.platform !== "win32" || process.arch !== "x64") {
        fail("Windows GCC qualification requires native Windows x64");
    }
    const install = path.resolve(options.installRoot);
    const source = path.resolve(options.sourceRoot);
    const probeRoot = path.resolve(options.probeRoot);
    const xmake = path.resolve(options.xmake);
    if (run("git", ["rev-parse", "HEAD"], {cwd: source}) !== expectedRevision ||
        run("git", ["write-tree"], {cwd: source}) !== expectedTree) {
        fail("GCC qualification source identity disagrees with the pinned prepared tree");
    }
    const scratch = options.scratchRoot
        ? path.resolve(options.scratchRoot)
        : await mkdtemp(path.join(tmpdir(), "move gcc qualification with spaces "));
    if (options.scratchRoot) await mkdir(scratch);
    const environment = {
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        PATH: `${path.join(install, "bin")};${process.env.SystemRoot}\\System32`,
    };
    try {
        const identity = await compilerIdentity(install, environment);
        await ordinaryCases(install, scratch, environment);
        await focusedGccCases(install, source, scratch, environment);
        exactProbe(probeRoot, xmake, install, scratch, environment);
        await win64AlignmentCases(install, source, scratch, environment);
        const peImports = await auditWindowsPeTree(install, environment);
        return {
            identity,
            peImports,
            qualification: {
                schemaVersion: 1,
                cases: [
                    "c11-smoke", "cxx-smoke", "cxx26-reflection",
                    "cxx20-modules", "imported-namespace-reflection",
                    "gcc-reflect-2", "gcc-reflect-3", "gcc-reflect-4",
                    "staged-prefix-independence", "runtime-closure",
                    "win64-avx-stack-alignment",
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
    const result = await qualifyWindowsGcc({
        installRoot: parsed.values.get("--install-root"),
        sourceRoot: parsed.values.get("--source-root"),
        probeRoot: parsed.values.get("--probe-root"),
        xmake: parsed.values.get("--xmake"),
        scratchRoot: parsed.values.get("--scratch-root"),
    });
    if (parsed.flags.has("--json")) console.log(JSON.stringify(result, null, 2));
    else console.log(`qualified: ${result.identity.version}`);
}

if (path.resolve(process.argv[1] ?? "") === scriptPath) {
    main().catch((error) => {
        console.error(`error: ${error.message}`);
        process.exitCode = 1;
    });
}
