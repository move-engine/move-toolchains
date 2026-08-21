import {createHash} from "node:crypto";
import {
    lstat,
    readFile,
    readdir,
    readlink,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
    canonicalProfileIdentity,
    supportedProfileIds,
} from "./toolchain-set.mjs";

export const buildReceiptFile = "move-build-receipt.json";
export const buildReceiptSchemaVersion = 1;
export const qualificationSchemaVersion = 1;

const sha256Pattern = /^[0-9a-f]{64}$/;
const fullRevisionPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const requiredQualificationCases = Object.freeze({
    gcc: Object.freeze([
        "c11-smoke",
        "cxx-smoke",
        "cxx26-reflection",
        "cxx20-modules",
        "imported-namespace-reflection",
        "gcc-reflect-2",
        "gcc-reflect-3",
        "gcc-reflect-4",
        "staged-prefix-independence",
        "runtime-closure",
    ]),
    clangTools: Object.freeze([
        "clang-version",
        "clangxx-version",
        "clangd-version",
        "reflection-feature",
        "import-std-reflection",
        "compilation-database",
        "resource-headers",
        "staged-prefix-independence",
        "runtime-closure",
    ]),
});
const profileQualificationCases = Object.freeze({
    "gcc:windows-x86_64-ucrt64": Object.freeze([
        "win64-avx-stack-alignment",
    ]),
});

function fail(message) {
    throw new Error(message);
}

function normalizedValue(value, location = "value") {
    if (value === null || typeof value === "string" ||
        typeof value === "boolean") {
        return value;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) fail(`${location} contains a non-finite number`);
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((entry, index) =>
            normalizedValue(entry, `${location}[${index}]`));
    }
    if (!value || typeof value !== "object") {
        fail(`${location} is not JSON serializable`);
    }
    const result = {};
    for (const key of Object.keys(value).sort()) {
        if (value[key] === undefined) fail(`${location}.${key} is undefined`);
        result[key] = normalizedValue(value[key], `${location}.${key}`);
    }
    return result;
}

export function canonicalJson(value) {
    return `${JSON.stringify(normalizedValue(value), null, 2)}\n`;
}

export function sha256Bytes(value) {
    return createHash("sha256").update(value).digest("hex");
}

export function compareUtf8(left, right) {
    return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function portablePath(root, candidate) {
    const relative = path.relative(root, candidate);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)) {
        fail(`tree entry escapes or aliases its root: ${candidate}`);
    }
    return relative.split(path.sep).join("/");
}

function isInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative);
}

function packagedMode(relative, information, kind) {
    if (kind === "directory") return 0o755;
    if (kind === "symlink") return 0o777;
    const executable = (information.mode & 0o111) !== 0 ||
        relative.startsWith("bin/") || /\.(?:exe|dll)$/i.test(relative);
    return executable ? 0o755 : 0o644;
}

async function fileDigest(file) {
    return sha256Bytes(await readFile(file));
}

export async function installedTreeManifest(root, options = {}) {
    const excluded = new Set(options.exclude ?? [buildReceiptFile]);
    const pending = [path.resolve(root)];
    const entries = [];
    while (pending.length) {
        const directory = pending.pop();
        const children = await readdir(directory, {withFileTypes: true});
        children.sort((left, right) => compareUtf8(left.name, right.name));
        for (const child of children) {
            const candidate = path.join(directory, child.name);
            const relative = portablePath(path.resolve(root), candidate);
            if (excluded.has(relative)) continue;
            const information = await lstat(candidate);
            if (information.isSymbolicLink()) {
                const target = await readlink(candidate);
                if (path.isAbsolute(target) || !isInside(
                    path.resolve(root), path.resolve(directory, target))) {
                    fail(`installed-tree symlink escapes its root: ${relative} -> ${target}`);
                }
                entries.push({
                    path: relative,
                    kind: "symlink",
                    mode: packagedMode(relative, information, "symlink"),
                    target,
                });
            } else if (information.isDirectory()) {
                entries.push({
                    path: relative,
                    kind: "directory",
                    mode: packagedMode(relative, information, "directory"),
                });
                pending.push(candidate);
            } else if (information.isFile()) {
                entries.push({
                    path: relative,
                    kind: "file",
                    mode: packagedMode(relative, information, "file"),
                    size: information.size,
                    sha256: await fileDigest(candidate),
                });
            } else {
                fail(`unsupported installed-tree entry: ${relative}`);
            }
        }
    }
    entries.sort((left, right) => compareUtf8(left.path, right.path));
    return {
        algorithm: "sha256-canonical-json-v1",
        digest: sha256Bytes(canonicalJson(entries)),
        entries,
    };
}

function requireObject(value, description) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail(`${description} must be an object`);
    }
    return value;
}

function requireString(value, description) {
    if (typeof value !== "string" || !value.trim()) {
        fail(`${description} must be a nonempty string`);
    }
    return value;
}

function validateRelativePath(value, description) {
    const candidate = requireString(value, description);
    if (candidate.includes("\\") || candidate.startsWith("/") ||
        /^[A-Za-z]:/.test(candidate) || candidate.endsWith("/") ||
        candidate.split("/").some((part) => !part || part === "." || part === "..")) {
        fail(`${description} is not a normalized safe relative path`);
    }
    return candidate;
}

function validateInstalledTree(tree) {
    requireObject(tree, "receipt installed tree");
    if (tree.algorithm !== "sha256-canonical-json-v1" ||
        !sha256Pattern.test(tree.digest ?? "") || !Array.isArray(tree.entries)) {
        fail("receipt installed tree is invalid");
    }
    let previous = null;
    for (const [index, entry] of tree.entries.entries()) {
        requireObject(entry, `installed tree entry ${index}`);
        const entryPath = validateRelativePath(
            entry.path, `installed tree entry ${index} path`);
        if (previous !== null && compareUtf8(previous, entryPath) >= 0) {
            fail("installed tree entries are duplicate or not in UTF-8 byte order");
        }
        previous = entryPath;
        if (entry.kind === "directory") {
            if (entry.mode !== 0o755 || Object.keys(entry).some(
                (key) => !["path", "kind", "mode"].includes(key))) {
                fail(`installed tree directory is invalid: ${entryPath}`);
            }
        } else if (entry.kind === "file") {
            if (![0o644, 0o755].includes(entry.mode) ||
                !Number.isSafeInteger(entry.size) || entry.size < 0 ||
                !sha256Pattern.test(entry.sha256 ?? "") ||
                Object.keys(entry).some((key) =>
                    !["path", "kind", "mode", "size", "sha256"].includes(key))) {
                fail(`installed tree file is invalid: ${entryPath}`);
            }
        } else if (entry.kind === "symlink") {
            if (entry.mode !== 0o777 || typeof entry.target !== "string" ||
                !entry.target || entry.target.includes("\\") ||
                /^[A-Za-z]:/.test(entry.target) || path.posix.isAbsolute(entry.target) ||
                Object.keys(entry).some((key) =>
                    !["path", "kind", "mode", "target"].includes(key))) {
                fail(`installed tree symlink is invalid: ${entryPath}`);
            }
            const resolved = path.posix.normalize(path.posix.join(
                path.posix.dirname(entryPath), entry.target));
            if (resolved === ".." || resolved.startsWith("../")) {
                fail(`installed tree symlink escapes its root: ${entryPath}`);
            }
        } else {
            fail(`installed tree entry has invalid kind: ${entryPath}`);
        }
    }
    if (sha256Bytes(canonicalJson(tree.entries)) !== tree.digest) {
        fail("installed tree digest does not match its entries");
    }
    return tree;
}

function validateDependencies(dependencies) {
    if (!Array.isArray(dependencies) || dependencies.length === 0) {
        fail("receipt dependencies must be a nonempty array");
    }
    const ids = new Set();
    for (const [index, dependency] of dependencies.entries()) {
        requireObject(dependency, `receipt dependency ${index}`);
        const id = requireString(dependency.id, `receipt dependency ${index} id`);
        if (ids.has(id)) fail(`duplicate receipt dependency: ${id}`);
        ids.add(id);
        requireString(dependency.source, `receipt dependency ${id} source`);
        requireString(dependency.version, `receipt dependency ${id} version`);
        if (dependency.kind === "git") {
            if (!fullRevisionPattern.test(dependency.revision ?? "") ||
                !fullRevisionPattern.test(dependency.tree ?? "")) {
                fail(`receipt dependency ${id} lacks immutable Git identity`);
            }
        } else if (dependency.kind === "archive") {
            validateRelativePath(
                dependency.file, `receipt dependency ${id} file`);
            const checksum = requireObject(
                dependency.checksum, `receipt dependency ${id} checksum`);
            const digestPattern = checksum.algorithm === "sha256"
                ? sha256Pattern
                : checksum.algorithm === "sha512" ? /^[0-9a-f]{128}$/ : null;
            if (!digestPattern?.test(checksum.digest ?? "")) {
                fail(`receipt dependency ${id} lacks immutable archive identity`);
            }
            if (dependency.signature !== undefined) {
                const signature = requireObject(
                    dependency.signature,
                    `receipt dependency ${id} signature`);
                validateRelativePath(
                    signature.file,
                    `receipt dependency ${id} signature file`);
                const signatureChecksum = requireObject(
                    signature.checksum,
                    `receipt dependency ${id} signature checksum`);
                const signaturePattern = signatureChecksum.algorithm === "sha256"
                    ? sha256Pattern
                    : signatureChecksum.algorithm === "sha512"
                        ? /^[0-9a-f]{128}$/
                        : null;
                if (!signaturePattern?.test(signatureChecksum.digest ?? "")) {
                    fail(`receipt dependency ${id} lacks immutable signature identity`);
                }
            }
        } else {
            fail(`receipt dependency ${id} has unsupported kind`);
        }
    }
}

export function validateBuildReceipt(receipt) {
    requireObject(receipt, "build receipt");
    if (receipt.schemaVersion !== buildReceiptSchemaVersion) {
        fail(`unsupported build receipt schema: ${receipt.schemaVersion}`);
    }
    const component = requireString(receipt.component, "receipt component");
    if (!requiredQualificationCases[component]) {
        fail(`receipt has unsupported component: ${component}`);
    }
    requireString(receipt.componentVersion, "receipt component version");
    requireString(receipt.packageRevision, "receipt package revision");
    if (!sha256Pattern.test(receipt.manifestDigest ?? "")) {
        fail("receipt manifest digest is invalid");
    }
    if (!supportedProfileIds.includes(receipt.profile)) {
        fail(`receipt has unsupported profile: ${receipt.profile}`);
    }
    const expectedProfile = canonicalProfileIdentity(receipt.profile);
    const source = requireObject(receipt.source, "receipt source");
    requireString(source.repository, "receipt source repository");
    if (!fullRevisionPattern.test(source.revision ?? "")) {
        fail("receipt source revision must be a full hexadecimal commit");
    }
    if (!fullRevisionPattern.test(source.upstreamBaseRevision ?? "")) {
        fail("receipt upstream base must be a full hexadecimal commit");
    }
    if (!Array.isArray(source.patchRevisions) ||
        source.patchRevisions.some(
            (revision) => !fullRevisionPattern.test(revision ?? "")) ||
        (component === "gcc" && source.patchRevisions.length === 0)) {
        fail("receipt patch revisions must be full hexadecimal commits");
    }
    if (!Number.isSafeInteger(receipt.sourceDateEpoch) ||
        receipt.sourceDateEpoch < 1) {
        fail("receipt sourceDateEpoch must be a positive integer");
    }
    const schemas = requireObject(receipt.schemas, "receipt schemas");
    if (schemas.manifest !== 2 || schemas.qualification !== qualificationSchemaVersion ||
        schemas.package !== 1) {
        fail("receipt schema identities are invalid");
    }
    const build = requireObject(receipt.build, "receipt build");
    const triples = requireObject(build.triples, "receipt build triples");
    for (const [name, expected] of [
        ["build", expectedProfile.buildTriple],
        ["host", expectedProfile.hostTriple],
        ["target", expectedProfile.targetTriple],
    ]) {
        if (triples[name] !== expected) {
            fail(`receipt ${name} triple disagrees with profile ${receipt.profile}`);
        }
    }
    if (!Array.isArray(build.configure) || build.configure.length === 0 ||
        build.configure.some((argument) => typeof argument !== "string")) {
        fail("receipt configure invocation must be a nonempty string array");
    }
    const bootstrap = requireObject(
        build.bootstrap, "receipt bootstrap compiler identity");
    requireString(bootstrap.identity, "receipt bootstrap identity");
    requireString(bootstrap.observedVersion, "receipt bootstrap observed version");
    for (const field of ["buildCommands", "installCommands"]) {
        if (!Array.isArray(build[field]) || build[field].length === 0 ||
            build[field].some((command) => !Array.isArray(command) ||
                command.length === 0 || command.some(
                    (argument) => typeof argument !== "string"))) {
            fail(`receipt ${field} must be a nonempty command matrix`);
        }
    }
    const environment = requireObject(receipt.environment, "receipt environment");
    requireString(environment.builderIdentity, "receipt builder identity");
    const runtimeIdentity = requireObject(
        environment.runtimeIdentity, "receipt runtime identity");
    if (canonicalJson(runtimeIdentity) !== canonicalJson(expectedProfile.runtime)) {
        fail(`receipt runtime identity disagrees with profile ${receipt.profile}`);
    }
    if (environment.targetCpuBaseline !== expectedProfile.targetCpuBaseline) {
        fail(`receipt target CPU baseline disagrees with profile ${receipt.profile}`);
    }
    requireObject(environment.variables, "receipt environment variables");
    validateDependencies(receipt.dependencies);
    const qualification = requireObject(receipt.qualification, "receipt qualification");
    if (qualification.schemaVersion !== qualificationSchemaVersion ||
        !Array.isArray(qualification.cases) || qualification.cases.length === 0) {
        fail("receipt qualification identity is invalid");
    }
    const results = new Map();
    for (const [index, result] of qualification.cases.entries()) {
        requireObject(result, `receipt qualification ${index}`);
        const id = requireString(result.id, `receipt qualification ${index} id`);
        if (results.has(id)) fail(`duplicate receipt qualification: ${id}`);
        results.set(id, result);
        if (!(["passed", "skipped"].includes(result.status))) {
            fail(`receipt qualification ${id} has invalid status`);
        }
        if (result.required !== false && result.status !== "passed") {
            fail(`required qualification did not pass: ${id}`);
        }
    }
    for (const id of [
        ...requiredQualificationCases[component],
        ...(profileQualificationCases[`${component}:${receipt.profile}`] ?? []),
    ]) {
        if (results.get(id)?.status !== "passed") {
            fail(`required qualification is absent or did not pass: ${id}`);
        }
    }
    validateInstalledTree(receipt.installedTree);
    return receipt;
}

export async function writeBuildReceipt(install, input) {
    const installedTree = await installedTreeManifest(install);
    const receipt = validateBuildReceipt({
        ...input,
        schemaVersion: buildReceiptSchemaVersion,
        installedTree,
    });
    const destination = path.join(install, buildReceiptFile);
    await writeFile(destination, canonicalJson(receipt), {flag: "wx"});
    return {receipt, destination, sha256: sha256Bytes(canonicalJson(receipt))};
}

export async function verifyBuildReceipt(install) {
    const receiptPath = path.join(install, buildReceiptFile);
    const receiptText = await readFile(receiptPath, "utf8");
    const receipt = validateBuildReceipt(JSON.parse(receiptText));
    if (canonicalJson(receipt) !== receiptText) {
        fail(`${buildReceiptFile} is not canonical JSON`);
    }
    const actualTree = await installedTreeManifest(install);
    if (actualTree.digest !== receipt.installedTree.digest ||
        canonicalJson(actualTree.entries) !==
            canonicalJson(receipt.installedTree.entries)) {
        fail("installed tree does not match its build receipt");
    }
    return {receipt, sha256: sha256Bytes(receiptText)};
}
