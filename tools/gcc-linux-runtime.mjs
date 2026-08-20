import {spawnSync} from "node:child_process";
import {copyFile, mkdir, open, readdir, realpath} from "node:fs/promises";
import path from "node:path";
import {parseLdd} from "./elf-compatibility.mjs";

const glibcRuntime = /^(?:ld-linux-x86-64|libc|libm|libdl|libpthread|librt|libutil|libresolv|libanl|libnss_[^.]+)\.so(?:\.|$)/;

function fail(message) { throw new Error(message); }

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        encoding: "utf8",
        env: options.env ?? process.env,
        maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) fail(`${command} could not start: ${result.error.message}`);
    if (result.status !== 0) {
        const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        fail(`${command} exited with ${result.status}${detail ? `: ${detail}` : ""}`);
    }
    return result.stdout ?? "";
}

function inside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative);
}

async function isElf(file) {
    const handle = await open(file, "r");
    try {
        const header = Buffer.alloc(4);
        const {bytesRead} = await handle.read(header, 0, 4, 0);
        return bytesRead === 4 && header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    } finally {
        await handle.close();
    }
}

async function elfFiles(root) {
    const result = [];
    const pending = [root];
    while (pending.length) {
        const directory = pending.pop();
        for (const entry of await readdir(directory, {withFileTypes: true})) {
            const candidate = path.join(directory, entry.name);
            if (entry.isDirectory()) pending.push(candidate);
            else if (entry.isFile() && await isElf(candidate)) result.push(candidate);
        }
    }
    return result.sort();
}

export function relativeRuntimeSearchPath(install, file) {
    const relative = path.relative(path.dirname(file), path.join(install, "lib64"))
        .split(path.sep).join("/");
    return relative === "" ? "$ORIGIN" : `$ORIGIN/${relative}`;
}

export function requiresBundling(name) {
    return !glibcRuntime.test(name);
}

export async function normalizeLinuxGccRuntime(install) {
    const canonicalInstall = await realpath(install);
    const libraryDirectory = path.join(canonicalInstall, "lib64");
    await mkdir(libraryDirectory, {recursive: true});
    const files = await elfFiles(canonicalInstall);
    const copied = new Map();
    const environment = {...process.env, LD_LIBRARY_PATH: libraryDirectory};

    const pending = [...files];
    const inspected = new Set();
    while (pending.length > 0) {
        const file = pending.shift();
        const canonicalFile = await realpath(file);
        if (inspected.has(canonicalFile)) continue;
        inspected.add(canonicalFile);
        const dynamic = run("readelf", ["--dynamic", canonicalFile]);
        if (!/\(NEEDED\)/.test(dynamic)) continue;
        const rows = parseLdd(run("ldd", [canonicalFile], {env: environment}));
        for (const row of rows) {
            if (!requiresBundling(row.name) || row.resolved === "not" ||
                !path.isAbsolute(row.resolved)) continue;
            const resolved = await realpath(row.resolved);
            if (inside(canonicalInstall, resolved)) continue;
            const destination = path.join(libraryDirectory, row.name);
            if (!copied.has(row.name)) {
                await copyFile(resolved, destination);
                copied.set(row.name, resolved);
                pending.push(destination);
            } else if (copied.get(row.name) !== resolved) {
                fail(`runtime ${row.name} resolved inconsistently`);
            }
        }
    }

    const normalizedFiles = await elfFiles(canonicalInstall);
    const dependencyGraph = {};
    for (const file of normalizedFiles) {
        const dynamic = run("readelf", ["--dynamic", file]);
        if (!/\(NEEDED\)/.test(dynamic)) continue;
        const expected = relativeRuntimeSearchPath(canonicalInstall, file);
        run("patchelf", ["--set-rpath", expected, file]);
        if (run("patchelf", ["--print-rpath", file]).trim() !== expected) {
            fail(`failed to set relative RUNPATH on ${file}`);
        }
        const rows = parseLdd(run("ldd", [file]));
        const relativeFile = path.relative(canonicalInstall, file)
            .split(path.sep).join("/");
        dependencyGraph[relativeFile] = [];
        for (const row of rows) {
            if (row.resolved === "not" || !path.isAbsolute(row.resolved)) {
                fail(`${relativeFile} has unresolved dependency ${row.name}`);
            }
            const resolved = await realpath(row.resolved);
            const packaged = inside(canonicalInstall, resolved);
            if (requiresBundling(row.name) && !packaged) {
                fail(`${relativeFile} resolves ${row.name} outside the package`);
            }
            dependencyGraph[relativeFile].push({
                name: row.name,
                resolution: packaged
                    ? path.relative(canonicalInstall, resolved).split(path.sep).join("/")
                    : "platform",
            });
        }
    }
    return {
        copied: Object.fromEntries([...copied].sort()),
        dependencyGraph,
        elfCount: normalizedFiles.length,
    };
}
