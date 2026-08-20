import {createHash, randomUUID} from "node:crypto";
import {execFile} from "node:child_process";
import {
    access,
    mkdir,
    readFile,
    realpath,
    rename,
    rm,
    statfs,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import {canonicalJson} from "./build-receipt.mjs";
import {windowsGccOperationIds} from "./gcc-recipe.mjs";

export const gccExecutorSemanticsVersion = 1;
export const minimumGccBuildFreeGiB = 80;
export const gccBuildOperationIds = windowsGccOperationIds;
const maximumWorkspacePathLength = 180;
const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
    throw new Error(message);
}

export function parseGccBuildArguments(argumentsValue) {
    const request = {
        acceptCost: false,
        buildRoot: null,
        jobs: null,
        profile: null,
    };
    const seen = new Set();
    for (let index = 0; index < argumentsValue.length; index += 1) {
        const argument = argumentsValue[index];
        if (argument === "--accept-cost") {
            if (seen.has(argument)) fail(`duplicate argument: ${argument}`);
            seen.add(argument);
            request.acceptCost = true;
            continue;
        }
        if (["--build-root", "--jobs", "--profile"].includes(argument)) {
            if (seen.has(argument)) fail(`duplicate argument: ${argument}`);
            seen.add(argument);
            const value = argumentsValue[++index];
            if (!value) fail(`${argument} requires a value`);
            if (argument === "--build-root") request.buildRoot = value;
            if (argument === "--profile") request.profile = value;
            if (argument === "--jobs") request.jobs = Number(value);
            continue;
        }
        fail(`unknown build argument: ${argument}`);
    }
    return request;
}

export function authorizeGccBuild(request, host = {
    platform: process.platform,
    architecture: process.arch,
}) {
    if (request.acceptCost !== true) {
        fail("GCC build requires the literal --accept-cost flag; no files, downloads, or processes were started");
    }
    if (request.profile !== "windows-x86_64-ucrt64") {
        fail("GCC build currently requires --profile windows-x86_64-ucrt64");
    }
    if (host.platform !== "win32" || host.architecture !== "x64") {
        fail("the Windows UCRT64 GCC recipe requires native win32-x64");
    }
    if (request.jobs === null) {
        request.jobs = 20;
    }
    if (!Number.isSafeInteger(request.jobs) || request.jobs < 1 || request.jobs > 64) {
        fail("--jobs must be an integer from 1 through 64");
    }
    if (typeof request.buildRoot !== "string" || !request.buildRoot.trim()) {
        fail("GCC build requires an explicit local absolute --build-root");
    }
    const pathApi = host.platform === "win32" ? path.win32 : path.posix;
    if (!pathApi.isAbsolute(request.buildRoot) || request.buildRoot.startsWith("\\\\")) {
        fail("--build-root must be a local absolute path");
    }
    return request;
}

export function gccBuildDerivationIdentity(recipeDigest, executorCommit) {
    if (!/^[0-9a-f]{64}$/.test(recipeDigest ?? "") ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(executorCommit ?? "")) {
        fail("GCC build derivation requires exact recipe and executor identities");
    }
    return createHash("sha256").update(canonicalJson({
        executorCommit,
        executorSemanticsVersion: gccExecutorSemanticsVersion,
        recipeDigest,
    })).digest("hex");
}

export async function resolveGccExecutorIdentity(options = {}) {
    const run = options.execFile ?? execFileAsync;
    const root = options.repositoryRoot ?? repositoryRoot;
    const execute = async (argumentsValue) => {
        const result = await run("git", argumentsValue, {
            cwd: root,
            encoding: "utf8",
            maxBuffer: 1024 * 1024,
            windowsHide: true,
        });
        return (typeof result === "string" ? result : result.stdout).trim();
    };
    const commit = await execute(["rev-parse", "HEAD"]);
    const changes = await execute(["status", "--porcelain", "--untracked-files=all"]);
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
        fail("running GCC executor is not at an exact Git commit");
    }
    if (changes) {
        fail(`running GCC executor checkout is dirty and cannot identify exact semantics:\n${changes}`);
    }
    return {commit, repositoryRoot: root};
}

export async function resolveWindowsDriveType(buildRoot, options = {}) {
    const run = options.execFile ?? execFileAsync;
    const systemRoot = options.systemRoot ?? process.env.SystemRoot;
    if (typeof systemRoot !== "string" || !path.win32.isAbsolute(systemRoot) ||
        systemRoot.startsWith("\\\\")) {
        fail("a trusted local SystemRoot is required to inspect the GCC build drive");
    }
    const executable = path.win32.join(
        systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const environment = {MOVE_GCC_BUILD_ROOT: buildRoot, SystemRoot: systemRoot};
    for (const name of ["TEMP", "TMP", "WINDIR"]) {
        if (typeof process.env[name] === "string") environment[name] = process.env[name];
    }
    const command = "[System.IO.DriveInfo]::new($env:MOVE_GCC_BUILD_ROOT).DriveType.ToString()";
    const result = await run(executable, [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command,
    ], {
        encoding: "utf8",
        env: environment,
        maxBuffer: 64 * 1024,
        windowsHide: true,
    });
    return (typeof result === "string" ? result : result.stdout).trim();
}

export function resolveGccBuildLayout(buildRoot, profile, derivationIdentity) {
    const root = path.resolve(buildRoot);
    const workspace = path.join(root, profile, derivationIdentity);
    if (workspace.length > maximumWorkspacePathLength) {
        fail(`GCC workspace path is too long (${workspace.length}; maximum ${maximumWorkspacePathLength}): ${workspace}`);
    }
    return {
        root,
        workspace,
        builder: path.join(workspace, "builder"),
        dependencies: path.join(workspace, "dependencies"),
        source: path.join(workspace, "source", "gcc"),
        build: path.join(workspace, "build", "gcc"),
        install: path.join(workspace, "install"),
        lock: path.join(workspace, "build.lock"),
        state: path.join(workspace, "gcc-build-state.json"),
        logs: path.join(workspace, "logs"),
    };
}

async function exists(value, io) {
    try {
        await io.access(value);
        return true;
    } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
    }
}

async function nearestExisting(value, io) {
    let candidate = path.resolve(value);
    while (!(await exists(candidate, io))) {
        const parent = path.dirname(candidate);
        if (parent === candidate) fail(`no existing parent for GCC build root: ${value}`);
        candidate = parent;
    }
    return candidate;
}

function isContained(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) &&
        relative !== ".." && !path.isAbsolute(relative));
}

export async function verifyBuildRootContainment(layout, io = defaultIo) {
    const lexicalRoot = path.resolve(layout.root);
    for (const candidate of Object.values(layout).filter(
        (value) => typeof value === "string" && value !== layout.root)) {
        if (!isContained(lexicalRoot, path.resolve(candidate))) {
            fail(`GCC build path escapes its root: ${candidate}`);
        }
    }
    const existingRoot = await nearestExisting(lexicalRoot, io);
    const canonicalExistingRoot = await io.realpath(existingRoot);
    for (const candidate of [layout.workspace, layout.builder, layout.dependencies,
        layout.source, layout.build, layout.install, layout.lock, layout.state,
        layout.logs]) {
        const existing = await nearestExisting(candidate, io);
        const canonical = await io.realpath(existing);
        if (!isContained(canonicalExistingRoot, canonical)) {
            fail(`GCC build path crosses a symlink or junction outside its root: ${candidate}`);
        }
    }
    return canonicalExistingRoot;
}

export async function preflightGccBuild(request, recipeDigest, dependencies = {}) {
    const io = dependencies.io ?? defaultIo;
    const host = dependencies.host ?? {
        platform: process.platform,
        architecture: process.arch,
    };
    authorizeGccBuild(request, host);
    const driveType = await (dependencies.resolveDriveType ??
        resolveWindowsDriveType)(request.buildRoot);
    if (driveType !== "Fixed") {
        fail(`GCC build root must be on a fixed local drive; observed ${driveType}`);
    }
    const executorIdentity = await (dependencies.resolveExecutorIdentity ??
        resolveGccExecutorIdentity)();
    const executorCommit = executorIdentity?.commit;
    const derivationIdentity = gccBuildDerivationIdentity(
        recipeDigest, executorCommit);
    const layout = resolveGccBuildLayout(
        request.buildRoot, request.profile, derivationIdentity);
    const canonicalRoot = await verifyBuildRootContainment(layout, io);
    const canonicalDriveType = await (dependencies.resolveDriveType ??
        resolveWindowsDriveType)(canonicalRoot);
    if (canonicalDriveType !== "Fixed" || canonicalRoot.startsWith("\\\\")) {
        fail(`canonical GCC build root must be on a fixed local drive; observed ${canonicalDriveType}: ${canonicalRoot}`);
    }
    const existing = await nearestExisting(layout.root, io);
    const free = await io.statfs(existing, {bigint: true});
    const freeGiB = Number((free.bavail * free.bsize) / (1024n ** 3n));
    if (freeGiB < minimumGccBuildFreeGiB) {
        fail(`GCC build requires ${minimumGccBuildFreeGiB} GiB free; ${freeGiB} GiB is available`);
    }
    return {
        derivationIdentity,
        executorCommit,
        executorRepositoryRoot: executorIdentity.repositoryRoot,
        freeGiB,
        layout,
        recipeDigest,
        request,
    };
}

async function createContainedWorkspace(layout, io) {
    await io.mkdir(layout.root, {recursive: true});
    const canonicalRoot = await io.realpath(layout.root);
    const relative = path.relative(layout.root, layout.workspace);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." ||
        path.isAbsolute(relative)) {
        fail(`GCC workspace escapes its root: ${layout.workspace}`);
    }
    let candidate = layout.root;
    for (const part of relative.split(path.sep)) {
        candidate = path.join(candidate, part);
        try {
            await io.mkdir(candidate);
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
        }
        const canonical = await io.realpath(candidate);
        if (!isContained(canonicalRoot, canonical)) {
            fail(`GCC workspace crosses a symlink or junction outside its root: ${candidate}`);
        }
    }
}

async function atomicJson(file, value, io) {
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
    try {
        await io.writeFile(temporary, canonicalJson(value), {flag: "wx"});
        await io.rename(temporary, file);
    } finally {
        await io.rm(temporary, {force: true});
    }
}

function validateBuildState(state, preflight, sourceBytes = null) {
    const keys = [
        "completedOperations", "derivationIdentity", "executorCommit",
        "executorSemanticsVersion", "recipeDigest", "schemaVersion", "status",
    ];
    if (!state || typeof state !== "object" || Array.isArray(state) ||
        canonicalJson(Object.keys(state).sort()) !== canonicalJson(keys) ||
        state.schemaVersion !== 1 ||
        state.derivationIdentity !== preflight.derivationIdentity ||
        state.executorCommit !== preflight.executorCommit ||
        state.executorSemanticsVersion !== gccExecutorSemanticsVersion ||
        state.recipeDigest !== preflight.recipeDigest ||
        !Array.isArray(state.completedOperations) ||
        !["prepared", "running", "failed", "interrupted", "built"].includes(
            state.status)) {
        fail(`GCC build state disagrees with the exact derivation: ${preflight.layout.state}`);
    }
    for (const [index, completed] of state.completedOperations.entries()) {
        if (!completed || typeof completed !== "object" || Array.isArray(completed) ||
            canonicalJson(Object.keys(completed).sort()) !==
                canonicalJson(["evidenceDigest", "id"]) ||
            completed.id !== gccBuildOperationIds[index] ||
            !/^[0-9a-f]{64}$/.test(completed.evidenceDigest ?? "")) {
            fail(`GCC build state has an invalid operation prefix: ${preflight.layout.state}`);
        }
    }
    const count = state.completedOperations.length;
    if (count > gccBuildOperationIds.length ||
        (state.status === "prepared" && count !== 0) ||
        (state.status === "built" && count !== gccBuildOperationIds.length) ||
        (["running", "failed", "interrupted"].includes(state.status) &&
            count === gccBuildOperationIds.length)) {
        fail(`GCC build state status disagrees with its operation prefix: ${preflight.layout.state}`);
    }
    if (sourceBytes !== null && canonicalJson(state) !== sourceBytes) {
        fail(`GCC build state is not canonical JSON: ${preflight.layout.state}`);
    }
    return state;
}

export async function acquireGccBuildLock(preflight, io = defaultIo) {
    await createContainedWorkspace(preflight.layout, io);
    await verifyBuildRootContainment(preflight.layout, io);
    const nonce = randomUUID();
    try {
        await io.mkdir(preflight.layout.lock);
    } catch (error) {
        if (error.code !== "EEXIST") throw error;
        let owner;
        try {
            owner = JSON.parse(await io.readFile(
                path.join(preflight.layout.lock, "owner.json"), "utf8"));
        } catch {
            fail(`an unreadable GCC build lock was preserved: ${preflight.layout.lock}`);
        }
        fail(`a GCC build lock was preserved for pid ${owner.pid ?? "unknown"}: ${preflight.layout.lock}`);
    }
    const owner = {
        derivationIdentity: preflight.derivationIdentity,
        host: `${process.platform}-${process.arch}`,
        nonce,
        pid: process.pid,
        processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        schemaVersion: 1,
    };
    try {
        await atomicJson(path.join(preflight.layout.lock, "owner.json"), owner, io);
    } catch (error) {
        await io.rm(preflight.layout.lock, {recursive: true, force: true});
        throw error;
    }
    return {file: preflight.layout.lock, nonce, owner};
}

export async function releaseGccBuildLock(lock, io = defaultIo) {
    const ownerPath = path.join(lock.file, "owner.json");
    const owner = JSON.parse(await io.readFile(ownerPath, "utf8"));
    if (owner.nonce !== lock.nonce) {
        fail(`GCC build lock ownership changed and was preserved: ${lock.file}`);
    }
    await io.rm(lock.file, {recursive: true});
}

export async function initializeGccBuildState(preflight, io = defaultIo) {
    const expected = {
        completedOperations: [],
        derivationIdentity: preflight.derivationIdentity,
        executorCommit: preflight.executorCommit,
        executorSemanticsVersion: gccExecutorSemanticsVersion,
        recipeDigest: preflight.recipeDigest,
        schemaVersion: 1,
        status: "prepared",
    };
    if (await exists(preflight.layout.state, io)) {
        const bytes = await io.readFile(preflight.layout.state, "utf8");
        return validateBuildState(JSON.parse(bytes), preflight, bytes);
    }
    await atomicJson(preflight.layout.state, expected, io);
    return expected;
}

export async function writeGccBuildState(preflight, state, io = defaultIo) {
    validateBuildState(state, preflight);
    await atomicJson(preflight.layout.state, state, io);
    return state;
}

const defaultIo = {
    access,
    mkdir,
    readFile,
    realpath,
    rename,
    rm,
    statfs,
    writeFile,
};
