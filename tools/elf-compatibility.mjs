#!/usr/bin/env node

import {spawnSync} from "node:child_process";
import {open, readdir, realpath} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {compareVersions} from "./host-compatibility.mjs";

const scriptPath = fileURLToPath(import.meta.url);

function fail(message) {
    throw new Error(message);
}

function run(command, args) {
    const result = spawnSync(command, args, {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) fail(`${command} could not start: ${result.error.message}`);
    if (result.status !== 0) {
        const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        fail(`${command} exited with ${result.status}${detail ? `: ${detail}` : ""}`);
    }
    return result.stdout ?? "";
}

export function requiredGlibcVersions(readelfOutput) {
    return [...readelfOutput.matchAll(/\bGLIBC_(\d+(?:\.\d+)+)\b/g)]
        .map((match) => match[1])
        .filter((value, index, values) => values.indexOf(value) === index)
        .sort(compareVersions);
}

async function isElf(file) {
    const handle = await open(file, "r");
    try {
        const header = Buffer.alloc(4);
        const {bytesRead} = await handle.read(header, 0, header.length, 0);
        return bytesRead === 4 && header.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
    } finally {
        await handle.close();
    }
}

async function collectFiles(root) {
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
    return files.sort();
}

function parseLdd(output) {
    const rows = [];
    for (const line of output.split(/\r?\n/)) {
        const match = line.trim().match(/^(\S+)\s+=>\s+(\S+)/);
        if (match) rows.push({name: match[1], resolved: match[2]});
    }
    return rows;
}

function isInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative);
}

export async function auditElfTree(install, maximumGlibc) {
    if (process.platform !== "linux") fail("ELF qualification requires Linux");
    const canonicalInstall = await realpath(install);
    const results = [];
    for (const file of await collectFiles(canonicalInstall)) {
        if (!(await isElf(file))) continue;
        const versionOutput = run("readelf", ["--version-info", file]);
        const versions = requiredGlibcVersions(versionOutput);
        const newest = versions.at(-1) ?? null;
        if (newest && compareVersions(newest, maximumGlibc) > 0) {
            fail(`${file} requires GLIBC_${newest}, newer than GLIBC_${maximumGlibc}`);
        }
        const dynamic = run("readelf", ["--dynamic", file]);
        const dependencies = [];
        if (/\(NEEDED\)/.test(dynamic)) {
            const linked = run("ldd", [file]);
            if (/=>\s+not found\b/.test(linked)) {
                fail(`${file} has an unresolved shared-library dependency`);
            }
            for (const row of parseLdd(linked)) {
                const isolated = /^(?:libstdc\+\+|libgcc_s|libc\+\+|libc\+\+abi|libunwind)\.so(?:\.|$)/
                    .test(row.name);
                if (isolated) {
                    if (row.resolved === "not" || !path.isAbsolute(row.resolved)) {
                        fail(`${file} did not resolve ${row.name}`);
                    }
                    const resolved = await realpath(row.resolved);
                    if (!isInside(canonicalInstall, resolved)) {
                        fail(`${file} resolved ${row.name} outside the package: ${resolved}`);
                    }
                }
                dependencies.push(row);
            }
        }
        results.push({
            file: path.relative(canonicalInstall, file).split(path.sep).join("/"),
            newestRequiredGlibc: newest,
            dependencies,
        });
    }
    if (results.length === 0) fail(`no ELF files were found beneath ${install}`);
    const newestRequiredGlibc = results
        .map((result) => result.newestRequiredGlibc)
        .filter(Boolean).sort(compareVersions).at(-1) ?? null;
    return {maximumGlibc, newestRequiredGlibc, elfCount: results.length, files: results};
}

const isMain = process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(scriptPath);
if (isMain) {
    const [install, maximumGlibc] = process.argv.slice(2);
    auditElfTree(path.resolve(install), maximumGlibc)
        .then((result) => console.log(JSON.stringify(result, null, 2)))
        .catch((error) => {
            console.error(`error: ${error.message}`);
            process.exitCode = 1;
        });
}
