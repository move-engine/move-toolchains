import assert from "node:assert/strict";
import {mkdir, mkdtemp, readFile, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {
    acquireGccBuildLock,
    authorizeGccBuild,
    gccBuildDerivationIdentity,
    gccBuildOperationIds,
    initializeGccBuildState,
    parseGccBuildArguments,
    preflightGccBuild,
    releaseGccBuildLock,
    resolveGccBuildLayout,
    resolveGccExecutorIdentity,
    resolveWindowsDriveType,
    verifyBuildRootContainment,
    writeGccBuildState,
} from "../tools/gcc-build.mjs";

const recipeDigest = "a".repeat(64);
const executorCommit = "b".repeat(40);
const windowsHost = {platform: "win32", architecture: "x64"};

async function fixture(context) {
    const root = await mkdtemp(path.join(tmpdir(), "move-gcc-build-test-"));
    context.after(() => rm(root, {recursive: true, force: true}));
    return root;
}

function request(buildRoot) {
    return {
        acceptCost: true,
        buildRoot,
        jobs: 20,
        profile: "windows-x86_64-ucrt64",
    };
}

function ampleDiskIo(overrides = {}) {
    return {
        access: (...values) => import("node:fs/promises").then((fs) => fs.access(...values)),
        mkdir,
        readFile,
        realpath: (...values) => import("node:fs/promises").then((fs) => fs.realpath(...values)),
        rename: (...values) => import("node:fs/promises").then((fs) => fs.rename(...values)),
        rm,
        statfs: async () => ({bavail: 100n, bsize: 1024n ** 3n}),
        writeFile,
        ...overrides,
    };
}

function exactDependencies(overrides = {}) {
    return {
        host: windowsHost,
        io: ampleDiskIo(),
        resolveDriveType: async () => "Fixed",
        resolveExecutorIdentity: async () => ({
            commit: executorCommit,
            repositoryRoot: "fixture",
        }),
        ...overrides,
    };
}

test("requires literal cost acceptance before filesystem activity", async () => {
    let calls = 0;
    const io = new Proxy({}, {get: () => async () => { calls += 1; }});
    const denied = request("C:\\build");
    denied.acceptCost = false;
    await assert.rejects(preflightGccBuild(
        denied, recipeDigest, {
            host: windowsHost,
            io,
            resolveDriveType: async () => { calls += 1; },
            resolveExecutorIdentity: async () => { calls += 1; },
        }),
    /--accept-cost/);
    assert.equal(calls, 0);
});

test("observes a clean exact executor identity", async () => {
    const outputs = [executorCommit, ""];
    const identity = await resolveGccExecutorIdentity({
        repositoryRoot: "fixture",
        execFile: async () => ({stdout: outputs.shift()}),
    });
    assert.equal(identity.commit, executorCommit);
    await assert.rejects(resolveGccExecutorIdentity({
        repositoryRoot: "fixture",
        execFile: async (_command, argumentsValue) => ({
            stdout: argumentsValue[0] === "rev-parse" ? executorCommit : " M tools/gcc-build.mjs",
        }),
    }), /dirty/);
    await assert.rejects(resolveGccExecutorIdentity({
        repositoryRoot: "fixture",
        execFile: async (_command, argumentsValue) => ({
            stdout: argumentsValue[0] === "rev-parse" ? "not-a-commit" : "",
        }),
    }), /exact Git commit/);
});

test("accepts only a fixed local Windows drive", async () => {
    const type = await resolveWindowsDriveType("M:\\build", {
        systemRoot: "C:\\Windows",
        execFile: async (command, _argumentsValue, options) => {
            assert.equal(command,
                "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
            assert.equal(options.env.MOVE_GCC_BUILD_ROOT, "M:\\build");
            assert.equal(options.env.SystemRoot, "C:\\Windows");
            assert.equal(options.env.PATH, undefined);
            return {stdout: "Fixed\r\n"};
        },
    });
    assert.equal(type, "Fixed");
});

test("parses and validates only the bounded Windows build request", () => {
    const parsed = parseGccBuildArguments([
        "--profile", "windows-x86_64-ucrt64", "--accept-cost",
        "--build-root", "M:\\toolchain-build", "--jobs", "24",
    ]);
    assert.equal(authorizeGccBuild(parsed, windowsHost).jobs, 24);
    assert.throws(() => authorizeGccBuild({...parsed, buildRoot: "relative"}, windowsHost));
    assert.throws(() => authorizeGccBuild({...parsed, buildRoot: "\\\\server\\share"}, windowsHost));
    assert.throws(() => parseGccBuildArguments(["--accept-cost", "--accept-cost"]));
    assert.throws(() => parseGccBuildArguments(["--unknown"]));
});

test("keys the workspace by recipe and executor semantics", () => {
    const first = gccBuildDerivationIdentity(recipeDigest, executorCommit);
    const changedRecipe = gccBuildDerivationIdentity("c".repeat(64), executorCommit);
    const changedExecutor = gccBuildDerivationIdentity(recipeDigest, "d".repeat(40));
    assert.notEqual(first, changedRecipe);
    assert.notEqual(first, changedExecutor);
    const layout = resolveGccBuildLayout(
        path.resolve("build-fixture"), "windows-x86_64-ucrt64", first);
    assert.equal(path.basename(layout.workspace), first);
    assert.ok(layout.install.startsWith(layout.workspace));
    assert.throws(() => resolveGccBuildLayout(
        path.resolve("x".repeat(220)), "windows-x86_64-ucrt64", first),
    /too long/);
});

test("rejects symlink or junction escape beneath the build root", async (context) => {
    const fixtureRoot = await fixture(context);
    const root = path.join(fixtureRoot, "root");
    const outside = path.join(fixtureRoot, "outside");
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, path.join(root, "windows-x86_64-ucrt64"),
        process.platform === "win32" ? "junction" : "dir");
    const layout = resolveGccBuildLayout(
        root, "windows-x86_64-ucrt64", "e".repeat(64));
    await assert.rejects(verifyBuildRootContainment(layout), /symlink or junction/);
});

test("preserves contended locks and releases only matching ownership", {
    skip: process.platform !== "win32",
}, async (context) => {
    const root = await fixture(context);
    const io = ampleDiskIo();
    const preflight = await preflightGccBuild(
        request(root), recipeDigest, exactDependencies({io}));
    const lock = await acquireGccBuildLock(preflight, io);
    await assert.rejects(acquireGccBuildLock(preflight, io), /lock was preserved/);
    const changed = {...lock, nonce: "different"};
    await assert.rejects(releaseGccBuildLock(changed, io), /ownership changed/);
    await releaseGccBuildLock(lock, io);
    await mkdir(preflight.layout.lock);
    await writeFile(path.join(preflight.layout.lock, "owner.json"), "invalid");
    await assert.rejects(acquireGccBuildLock(preflight, io), /unreadable/);
});

test("persists only exact derivation state", {
    skip: process.platform !== "win32",
}, async (context) => {
    const root = await fixture(context);
    const io = ampleDiskIo();
    const preflight = await preflightGccBuild(
        request(root), recipeDigest, exactDependencies({io}));
    const lock = await acquireGccBuildLock(preflight, io);
    try {
        const state = await initializeGccBuildState(preflight, io);
        assert.equal(state.derivationIdentity, preflight.derivationIdentity);
        assert.equal(state.recipeDigest, recipeDigest);
        const bytes = await readFile(preflight.layout.state, "utf8");
        assert.equal(JSON.parse(bytes).status, "prepared");
        const resumable = {
            ...state,
            completedOperations: [{
                evidenceDigest: "1".repeat(64),
                id: gccBuildOperationIds[0],
            }],
            status: "interrupted",
        };
        await writeGccBuildState(preflight, resumable, io);
        assert.equal((await initializeGccBuildState(preflight, io)).status,
            "interrupted");
        const changed = {...resumable, executorCommit: "f".repeat(40)};
        await writeFile(preflight.layout.state, `${JSON.stringify(changed)}\n`);
        await assert.rejects(initializeGccBuildState(preflight, io),
            /disagrees with the exact derivation/);

        for (const mutate of [
            (value) => value.completedOperations[0].id = "arbitrary",
            (value) => value.completedOperations.push(
                structuredClone(value.completedOperations[0])),
            (value) => value.status = "prepared",
            (value) => value.status = "built",
            (value) => value.extra = true,
        ]) {
            const invalid = structuredClone(resumable);
            mutate(invalid);
            await assert.rejects(writeGccBuildState(preflight, invalid, io));
        }
    } finally {
        await releaseGccBuildLock(lock, io);
    }
});

test("rejects insufficient free space before locking", {
    skip: process.platform !== "win32",
}, async (context) => {
    const root = await fixture(context);
    await assert.rejects(preflightGccBuild(
        request(root), recipeDigest, exactDependencies({
            io: ampleDiskIo({
                statfs: async () => ({bavail: 79n, bsize: 1024n ** 3n}),
            }),
        })), /80 GiB/);
});

test("rejects remote and removable drives before filesystem preflight", async () => {
    for (const driveType of ["Network", "Removable"]) {
        let fileCalls = 0;
        const dependencies = exactDependencies({
            io: new Proxy({}, {get: () => async () => { fileCalls += 1; }}),
            resolveDriveType: async () => driveType,
        });
        await assert.rejects(preflightGccBuild(
            request("M:\\build"), recipeDigest, dependencies), /fixed local drive/);
        assert.equal(fileCalls, 0);
    }
});

test("rejects a lexical fixed root that canonicalizes to a network share", async () => {
    let driveCalls = 0;
    let mkdirCalls = 0;
    const driveTypes = ["Fixed", "Network"];
    const io = ampleDiskIo({
        access: async () => {},
        mkdir: async () => { mkdirCalls += 1; },
        realpath: async () => "\\\\server\\share",
    });
    await assert.rejects(preflightGccBuild(
        request("C:\\local-link\\gcc"), recipeDigest, exactDependencies({
            io,
            resolveDriveType: async () => {
                driveCalls += 1;
                return driveTypes.shift();
            },
        })), /canonical GCC build root/);
    assert.equal(driveCalls, 2);
    assert.equal(mkdirCalls, 0);
});
