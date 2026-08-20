#!/usr/bin/env node
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {
    mkdir,
    readdir,
    readFile,
    rename,
    stat,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {canonicalJson} from "./build-receipt.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutput = path.join(
    repositoryRoot, "recipes", "builders", "msys2-ucrt64-20260820.json");
const bsdtar = "C:\\msys64\\usr\\bin\\bsdtar.exe";
const sha256Pattern = /^[0-9a-f]{64}$/;
export const msys2BuilderLockSchemaVersion = 1;
export const msys2BuilderLockId = "msys2-ucrt64-20260820";
const requestedPackages = Object.freeze([
    "autoconf-wrapper", "automake-wrapper", "bison", "flex", "git", "libtool",
    "make", "mingw-w64-ucrt-x86_64-gcc", "msys2-keyring", "patch", "tar",
    "texinfo", "xz", "zstd",
]);

function fail(message) {
    throw new Error(message);
}

function parseArguments(argumentsValue) {
    const values = new Map();
    for (let index = 0; index < argumentsValue.length; index += 1) {
        const argument = argumentsValue[index];
        if (["--cache", "--output"].includes(argument)) {
            const value = argumentsValue[++index];
            if (!value) fail(`${argument} requires a value`);
            values.set(argument, value);
        } else if (["--help", "-h"].includes(argument)) {
            values.set("--help", true);
        } else {
            fail(`unknown argument: ${argument}`);
        }
    }
    return values;
}

function packageInformation(bytes, file) {
    const values = new Map();
    for (const line of bytes.split(/\r?\n/)) {
        const match = /^([a-z]+) = (.+)$/.exec(line);
        if (match) {
            const entries = values.get(match[1]) ?? [];
            entries.push(match[2]);
            values.set(match[1], entries);
        }
    }
    for (const field of ["pkgname", "pkgver", "arch"]) {
        if (values.get(field)?.length !== 1) {
            fail(`${file} lacks one exact ${field} in .PKGINFO`);
        }
    }
    const sorted = (field) => [...(values.get(field) ?? [])].sort((left, right) =>
        Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
    return {
        architecture: values.get("arch")[0],
        dependencies: sorted("depend"),
        name: values.get("pkgname")[0],
        provides: sorted("provides"),
        version: values.get("pkgver")[0],
    };
}

async function sha256File(file) {
    const hash = createHash("sha256");
    hash.update(await readFile(file));
    return hash.digest("hex");
}

function packageRepository(name) {
    return name.startsWith("mingw-w64-ucrt-x86_64-") ? "ucrt64" : "msys";
}

function packageBaseUrl(repository) {
    return repository === "ucrt64"
        ? "https://repo.msys2.org/mingw/ucrt64"
        : "https://repo.msys2.org/msys/x86_64";
}

function expectedDownloadUrl(repository, file) {
    return `${packageBaseUrl(repository)}/${file}`;
}

export async function createBuilderLock(cache) {
    const entries = await readdir(cache, {withFileTypes: true});
    const archives = entries.filter((entry) =>
        entry.isFile() && entry.name.endsWith(".pkg.tar.zst"));
    if (archives.length === 0) fail(`no MSYS2 package archives found in ${cache}`);
    const packages = [];
    for (const archive of archives) {
        const archivePath = path.join(cache, archive.name);
        const signatureFile = `${archive.name}.sig`;
        const signaturePath = path.join(cache, signatureFile);
        const information = packageInformation(execFileSync(
            bsdtar, ["-xOf", archivePath, ".PKGINFO"], {encoding: "utf8"}), archive.name);
        const repository = packageRepository(information.name);
        const baseUrl = packageBaseUrl(repository);
        const [archiveStat, signatureStat] = await Promise.all([
            stat(archivePath),
            stat(signaturePath),
        ]);
        packages.push({
            architecture: information.architecture,
            bytes: archiveStat.size,
            dependencies: information.dependencies,
            file: archive.name,
            name: information.name,
            provides: information.provides,
            repository,
            sha256: await sha256File(archivePath),
            signature: {
                bytes: signatureStat.size,
                file: signatureFile,
                sha256: await sha256File(signaturePath),
                url: `${baseUrl}/${signatureFile}`,
            },
            url: `${baseUrl}/${archive.name}`,
            version: information.version,
        });
    }
    packages.sort((left, right) => Buffer.compare(
        Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8")));
    return validateBuilderLock({
        base: {
            bytes: 52898952,
            file: "msys2-base-x86_64-20260611.sfx.exe",
            sha256: "c105946e64e08f099ac0e4647461ce762b95333ad211777666476a9a41451d65",
            url: "https://github.com/msys2/msys2-installer/releases/download/2026-06-11/msys2-base-x86_64-20260611.sfx.exe",
        },
        id: msys2BuilderLockId,
        packages,
        requestedPackages,
        roots: {shell: "usr/bin/bash.exe", ucrt64: "ucrt64"},
        schemaVersion: msys2BuilderLockSchemaVersion,
        signaturePolicy: {
            keyring: "base-plus-locked-msys2-keyring",
            requireEveryPackage: true,
        },
    });
}

function safeFile(value, description) {
    if (typeof value !== "string" || !value || value.includes("/") ||
        value.includes("\\") || value === "." || value === "..") {
        fail(`${description} is not a safe filename`);
    }
}

function validateDownload(value, description) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail(`${description} must be an object`);
    }
    safeFile(value.file, `${description} file`);
    if (!Number.isSafeInteger(value.bytes) || value.bytes < 1 ||
        !sha256Pattern.test(value.sha256 ?? "") ||
        !/^https:\/\//.test(value.url ?? "")) {
        fail(`${description} lacks exact download identity`);
    }
}

function parsePackageIdentity(value) {
    const match = /^([A-Za-z0-9@._+:-]+)(?:(<=|>=|=|<|>)([^/\\]+))?$/.exec(value);
    if (!match || match[3]?.includes("..") ||
        (match[3] && !/^[A-Za-z0-9._+~:-]+$/.test(match[3]))) return null;
    return {name: match[1], operator: match[2] ?? null, version: match[3] ?? null};
}

function validatePackageIdentityList(values, description) {
    if (!Array.isArray(values)) fail(`${description} must be an array`);
    let previous = null;
    for (const value of values) {
        if (typeof value !== "string" || !parsePackageIdentity(value)) {
            fail(`${description} contains an invalid package identity`);
        }
        if (previous !== null && Buffer.compare(
            Buffer.from(previous, "utf8"), Buffer.from(value, "utf8")) >= 0) {
            fail(`${description} is duplicate or not in UTF-8 byte order`);
        }
        previous = value;
    }
}

function versionTokens(value) {
    const epochMatch = /^(\d+):(.*)$/.exec(value);
    const epoch = epochMatch ? Number(epochMatch[1]) : 0;
    const remainder = epochMatch ? epochMatch[2] : value;
    const releaseSeparator = remainder.lastIndexOf("-");
    return {
        epoch,
        release: releaseSeparator < 0 ? null : remainder.slice(releaseSeparator + 1),
        tokens: (releaseSeparator < 0 ? remainder : remainder.slice(0, releaseSeparator))
            .match(/~|[0-9]+|[A-Za-z]+/g) ?? [],
    };
}

function compareTokenLists(leftTokens, rightTokens) {
    const count = Math.max(leftTokens.length, rightTokens.length);
    for (let index = 0; index < count; index += 1) {
        const leftToken = leftTokens[index];
        const rightToken = rightTokens[index];
        if (leftToken === "~" || rightToken === "~") {
            if (leftToken === rightToken) continue;
            return leftToken === "~" ? -1 : 1;
        }
        if (leftToken === undefined) {
            if (rightToken === undefined) return 0;
            return /^\d+$/.test(rightToken) ? -1 : 1;
        }
        if (rightToken === undefined) return /^\d+$/.test(leftToken) ? 1 : -1;
        const leftNumeric = /^\d+$/.test(leftToken);
        const rightNumeric = /^\d+$/.test(rightToken);
        if (leftNumeric && rightNumeric) {
            const normalizedLeft = leftToken.replace(/^0+/, "") || "0";
            const normalizedRight = rightToken.replace(/^0+/, "") || "0";
            if (normalizedLeft.length !== normalizedRight.length) {
                return normalizedLeft.length < normalizedRight.length ? -1 : 1;
            }
            if (normalizedLeft !== normalizedRight) {
                return normalizedLeft < normalizedRight ? -1 : 1;
            }
        } else if (leftNumeric !== rightNumeric) {
            return leftNumeric ? 1 : -1;
        } else if (leftToken !== rightToken) {
            return leftToken < rightToken ? -1 : 1;
        }
    }
    return 0;
}

export function comparePacmanVersions(left, right) {
    const leftValue = versionTokens(left);
    const rightValue = versionTokens(right);
    if (leftValue.epoch !== rightValue.epoch) {
        return leftValue.epoch < rightValue.epoch ? -1 : 1;
    }
    const main = compareTokenLists(leftValue.tokens, rightValue.tokens);
    if (main !== 0 || leftValue.release === null || rightValue.release === null) {
        return main;
    }
    return compareTokenLists(
        leftValue.release.match(/~|[0-9]+|[A-Za-z]+/g) ?? [],
        rightValue.release.match(/~|[0-9]+|[A-Za-z]+/g) ?? []);
}

function satisfiesRequirement(identity, requirement) {
    if (identity.name !== requirement.name) return false;
    if (!requirement.operator) return true;
    if (!identity.version) return false;
    const comparison = comparePacmanVersions(identity.version, requirement.version);
    return requirement.operator === "=" ? comparison === 0
        : requirement.operator === ">=" ? comparison >= 0
        : requirement.operator === "<=" ? comparison <= 0
        : requirement.operator === ">" ? comparison > 0
        : comparison < 0;
}

export function validateBuilderLock(lock) {
    if (!lock || typeof lock !== "object" || Array.isArray(lock) ||
        lock.schemaVersion !== msys2BuilderLockSchemaVersion ||
        lock.id !== msys2BuilderLockId) {
        fail("unsupported MSYS2 builder lock");
    }
    validateDownload(lock.base, "MSYS2 base installer");
    if (lock.base.file !== "msys2-base-x86_64-20260611.sfx.exe" ||
        lock.base.url !==
            "https://github.com/msys2/msys2-installer/releases/download/2026-06-11/msys2-base-x86_64-20260611.sfx.exe") {
        fail("MSYS2 base installer does not match the pinned builder image");
    }
    if (lock.roots?.shell !== "usr/bin/bash.exe" || lock.roots?.ucrt64 !== "ucrt64" ||
        lock.signaturePolicy?.keyring !== "base-plus-locked-msys2-keyring" ||
        lock.signaturePolicy?.requireEveryPackage !== true ||
        !Array.isArray(lock.packages) || lock.packages.length !== 128) {
        fail("MSYS2 builder lock roots or packages are invalid");
    }
    validatePackageIdentityList(lock.requestedPackages, "MSYS2 requested packages");
    if (canonicalJson(lock.requestedPackages) !== canonicalJson(requestedPackages)) {
        fail("MSYS2 builder transaction roots are incomplete or changed");
    }
    const names = new Set();
    const files = new Set();
    let previous = null;
    for (const item of lock.packages) {
        validateDownload(item, `MSYS2 package ${item?.name ?? "unknown"}`);
        validateDownload(item.signature, `MSYS2 package ${item?.name ?? "unknown"} signature`);
        if (typeof item.name !== "string" || !item.name ||
            typeof item.version !== "string" ||
            !/^[A-Za-z0-9._+~:-]+$/.test(item.version) ||
            !["any", "x86_64"].includes(item.architecture) ||
            !["msys", "ucrt64"].includes(item.repository) ||
            item.signature.file !== `${item.file}.sig` ||
            item.url !== expectedDownloadUrl(item.repository, item.file) ||
            item.signature.url !== expectedDownloadUrl(
                item.repository, item.signature.file)) {
            fail("MSYS2 package identity is invalid");
        }
        validatePackageIdentityList(
            item.dependencies, `MSYS2 package ${item.name} dependencies`);
        validatePackageIdentityList(
            item.provides, `MSYS2 package ${item.name} provides`);
        if (previous !== null && Buffer.compare(
            Buffer.from(previous, "utf8"), Buffer.from(item.name, "utf8")) >= 0) {
            fail("MSYS2 packages are duplicate or not in UTF-8 byte order");
        }
        previous = item.name;
        if (names.has(item.name) || files.has(item.file) || files.has(item.signature.file)) {
            fail("MSYS2 builder lock contains duplicate identities");
        }
        names.add(item.name);
        files.add(item.file);
        files.add(item.signature.file);
    }
    for (const required of [
        "bash", "git", "make", "patch", "tar", "xz", "zstd", "msys2-keyring",
        "autoconf-wrapper", "autoconf2.72", "automake-wrapper", "automake1.17",
        "bison", "flex", "libtool", "texinfo", "diffutils",
        "mingw-w64-ucrt-x86_64-gcc", "mingw-w64-ucrt-x86_64-binutils",
    ]) {
        if (!names.has(required)) fail(`MSYS2 builder package is absent: ${required}`);
    }
    const providers = new Map();
    for (const item of lock.packages) {
        const identities = [
            {name: item.name, operator: "=", version: item.version, direct: true},
            ...item.provides.map((value) => ({
                ...parsePackageIdentity(value), direct: false,
            })),
        ];
        for (const identity of identities) {
            const entries = providers.get(identity.name) ?? [];
            entries.push({identity, package: item});
            providers.set(identity.name, entries);
        }
    }
    const resolveDependency = (dependency, dependent) => {
        const requirement = parsePackageIdentity(dependency);
        const candidates = (providers.get(requirement.name) ?? []).filter((entry) =>
            satisfiesRequirement(entry.identity, requirement));
        candidates.sort((left, right) => {
            if (left.identity.direct !== right.identity.direct) {
                return left.identity.direct ? -1 : 1;
            }
            return Buffer.compare(
                Buffer.from(left.package.name, "utf8"),
                Buffer.from(right.package.name, "utf8"));
        });
        if (candidates.length === 0) {
            fail(`MSYS2 builder dependency is unresolved: ${dependent} -> ${dependency}`);
        }
        return candidates[0].package;
    };
    const packagesByName = new Map(lock.packages.map((item) => [item.name, item]));
    const reachable = new Set();
    const pending = lock.requestedPackages.map((name) => packagesByName.get(name));
    while (pending.length > 0) {
        const item = pending.pop();
        if (!item || reachable.has(item.name)) continue;
        reachable.add(item.name);
        for (const dependency of item.dependencies) {
            pending.push(resolveDependency(dependency, item.name));
        }
    }
    if (reachable.size !== lock.packages.length) {
        const extras = lock.packages.filter((item) => !reachable.has(item.name))
            .map((item) => item.name);
        fail(`MSYS2 builder lock contains packages outside the resolved transaction: ${extras.join(", ")}`);
    }
    return lock;
}

export async function loadBuilderLock(lockPath) {
    const bytes = await readFile(lockPath, "utf8");
    const lock = validateBuilderLock(JSON.parse(bytes));
    if (canonicalJson(lock) !== bytes) {
        fail(`MSYS2 builder lock is not canonical JSON: ${lockPath}`);
    }
    return {
        lock,
        path: path.resolve(lockPath),
        digest: createHash("sha256").update(bytes).digest("hex"),
    };
}

async function main(argumentsValue = process.argv.slice(2)) {
    const values = parseArguments(argumentsValue);
    if (values.has("--help")) {
        console.log("Usage: node tools/msys2-builder-lock.mjs --cache PATH [--output PATH]");
        return;
    }
    const cache = values.get("--cache");
    if (!cache) fail("--cache is required");
    const output = path.resolve(values.get("--output") ?? defaultOutput);
    const lock = await createBuilderLock(path.resolve(cache));
    await mkdir(path.dirname(output), {recursive: true});
    const temporary = `${output}.tmp-${process.pid}`;
    await writeFile(temporary, canonicalJson(lock), {flag: "wx"});
    await rename(temporary, output);
    console.log(`wrote ${output} with ${lock.packages.length} exact packages`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(`error: ${error.message}`);
        process.exitCode = 1;
    });
}
