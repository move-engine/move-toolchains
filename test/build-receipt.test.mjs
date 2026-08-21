import assert from "node:assert/strict";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {
    canonicalJson,
    compareUtf8,
    installedTreeManifest,
    validateBuildReceipt,
    verifyBuildReceipt,
    writeBuildReceipt,
} from "../tools/build-receipt.mjs";

const gccQualificationCases = [
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
];
const clangQualificationCases = [
    "clang-version",
    "clangxx-version",
    "clangd-version",
    "reflection-feature",
    "import-std-reflection",
    "compilation-database",
    "resource-headers",
    "staged-prefix-independence",
    "runtime-closure",
];

async function fixture(context) {
    const root = await mkdtemp(path.join(tmpdir(), "move-receipt-test-"));
    context.after(() => rm(root, {recursive: true, force: true}));
    await mkdir(path.join(root, "bin"));
    await writeFile(path.join(root, "bin", "g++"), "compiler\n");
    await writeFile(path.join(root, "README"), "fixture\n");
    return root;
}

function input() {
    return {
        component: "gcc",
        componentVersion: "16.2.0",
        packageRevision: "move.1",
        manifestDigest: "7".repeat(64),
        profile: "linux-x86_64-glibc2.35",
        schemas: {manifest: 2, qualification: 1, package: 1},
        source: {
            repository: "https://github.com/move-engine/gcc.git",
            revision: "a".repeat(40),
            upstreamBaseRevision: "b".repeat(40),
            patchRevisions: ["c".repeat(40)],
        },
        sourceDateEpoch: 1786088827,
        dependencies: [{
            id: "binutils",
            kind: "archive",
            file: "binutils-fixture.tar.xz",
            source: "https://sourceware.org/git/binutils-gdb.git",
            version: "fixture",
            checksum: {algorithm: "sha256", digest: "e".repeat(64)},
        }],
        build: {
            triples: {build: "x86_64-pc-linux-gnu", host: "x86_64-pc-linux-gnu",
                target: "x86_64-pc-linux-gnu"},
            configure: ["@source@/configure", "--prefix=@install@"],
            bootstrap: {
                identity: "gcc-bootstrap-fixture",
                observedVersion: "gcc fixture",
            },
            buildCommands: [["make", "-j20"]],
            installCommands: [["make", "install"]],
        },
        environment: {
            builderIdentity: "fixture-image@sha256:fixture",
            runtimeIdentity: {family: "glibc", minimumVersion: "2.35"},
            targetCpuBaseline: "x86-64",
            variables: {LANG: "C.UTF-8"},
        },
        qualification: {
            schemaVersion: 1,
            cases: gccQualificationCases.map((id) => ({id, status: "passed"})),
        },
    };
}

test("canonical JSON recursively sorts object keys", () => {
    assert.equal(canonicalJson({z: 1, a: {y: 2, b: 3}}),
        "{\n  \"a\": {\n    \"b\": 3,\n    \"y\": 2\n  },\n  \"z\": 1\n}\n");
});

test("orders payload paths by UTF-8 bytes instead of the process locale", () => {
    const values = ["z", "Z", "ä", "å", "a-", "a_"];
    const actual = [...values].sort(compareUtf8);
    const expected = [...values].sort((left, right) =>
        Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
    assert.deepEqual(actual, expected);
});

test("writes and verifies a receipt bound to the installed tree", async (context) => {
    const root = await fixture(context);
    const before = await installedTreeManifest(root);
    const written = await writeBuildReceipt(root, input());
    assert.equal(written.receipt.installedTree.digest, before.digest);
    assert.match(written.sha256, /^[0-9a-f]{64}$/);
    const verified = await verifyBuildReceipt(root);
    assert.equal(verified.sha256, written.sha256);
});

test("detects installed-file mutation after receipt generation", async (context) => {
    const root = await fixture(context);
    await writeBuildReceipt(root, input());
    await writeFile(path.join(root, "README"), "changed\n");
    await assert.rejects(() => verifyBuildReceipt(root), /does not match/);
});

test("refuses to overwrite an existing receipt", async (context) => {
    const root = await fixture(context);
    await writeBuildReceipt(root, input());
    await assert.rejects(() => writeBuildReceipt(root, input()), /EEXIST/);
});

test("rejects a required qualification that did not pass", async (context) => {
    const root = await fixture(context);
    const failed = input();
    failed.qualification.cases[0].status = "skipped";
    await assert.rejects(() => writeBuildReceipt(root, failed),
        /required qualification did not pass/);
});

test("requires complete reproducibility and qualification identity", async (context) => {
    const root = await fixture(context);
    const written = await writeBuildReceipt(root, input());
    for (const mutate of [
        (receipt) => delete receipt.environment.builderIdentity,
        (receipt) => receipt.dependencies = [],
        (receipt) => delete receipt.build.bootstrap.observedVersion,
        (receipt) => receipt.qualification.cases.pop(),
    ]) {
        const receipt = structuredClone(written.receipt);
        mutate(receipt);
        assert.throws(() => validateBuildReceipt(receipt));
    }
});

test("accepts exact archive and Git dependency identities", async (context) => {
    const root = await fixture(context);
    const candidate = input();
    candidate.dependencies.push({
        id: "mingw-w64",
        kind: "git",
        source: "https://github.com/mingw-w64/mingw-w64.git",
        version: "14.0.0",
        revision: "a".repeat(40),
        tree: "b".repeat(40),
    });
    await writeBuildReceipt(root, candidate);
});

test("rejects mutable or malformed dependency identities", async (context) => {
    const root = await fixture(context);
    const written = await writeBuildReceipt(root, input());
    for (const mutate of [
        (receipt) => delete receipt.dependencies[0].checksum,
        (receipt) => delete receipt.dependencies[0].file,
        (receipt) => receipt.dependencies[0].file = "../escape.tar.xz",
        (receipt) => receipt.dependencies[0].checksum.algorithm = "md5",
        (receipt) => receipt.dependencies[0].kind = "directory",
    ]) {
        const receipt = structuredClone(written.receipt);
        mutate(receipt);
        assert.throws(() => validateBuildReceipt(receipt));
    }
});

test("validates optional archive signature identity", async (context) => {
    const root = await fixture(context);
    const candidate = input();
    candidate.dependencies[0].signature = {
        file: "binutils-fixture.tar.xz.sig",
        checksum: {algorithm: "sha256", digest: "f".repeat(64)},
    };
    const written = await writeBuildReceipt(root, candidate);
    for (const mutate of [
        (receipt) => receipt.dependencies[0].signature.file = "../escape.sig",
        (receipt) => receipt.dependencies[0].signature.checksum.algorithm = "md5",
    ]) {
        const receipt = structuredClone(written.receipt);
        mutate(receipt);
        assert.throws(() => validateBuildReceipt(receipt));
    }
});

test("binds runtime, triples, and CPU baseline to the exact profile", async (context) => {
    const root = await fixture(context);
    const written = await writeBuildReceipt(root, input());
    for (const mutate of [
        (receipt) => receipt.environment.runtimeIdentity.minimumVersion = "2.38",
        (receipt) => receipt.build.triples.target = "x86_64-w64-mingw32",
        (receipt) => receipt.environment.targetCpuBaseline = "native",
    ]) {
        const receipt = structuredClone(written.receipt);
        mutate(receipt);
        assert.throws(() => validateBuildReceipt(receipt), /disagrees with profile/);
    }
});

test("requires the Win64 AVX stack-alignment regression for Windows GCC", async (context) => {
    const root = await fixture(context);
    const candidate = input();
    candidate.profile = "windows-x86_64-ucrt64";
    candidate.build.triples = {
        build: "x86_64-w64-mingw32",
        host: "x86_64-w64-mingw32",
        target: "x86_64-w64-mingw32",
    };
    candidate.environment.runtimeIdentity = {family: "ucrt"};
    candidate.qualification.cases.push({
        id: "win64-avx-stack-alignment",
        status: "passed",
    });
    const written = await writeBuildReceipt(root, candidate);
    const missing = structuredClone(written.receipt);
    missing.qualification.cases = missing.qualification.cases.filter(
        (entry) => entry.id !== "win64-avx-stack-alignment");
    assert.throws(() => validateBuildReceipt(missing),
        /win64-avx-stack-alignment/);

    const clangRoot = await fixture(context);
    const clangCandidate = structuredClone(candidate);
    clangCandidate.component = "clangTools";
    clangCandidate.componentVersion = "p2996-7220baff";
    clangCandidate.qualification.cases = clangQualificationCases.map(
        (id) => ({id, status: "passed"}));
    await writeBuildReceipt(clangRoot, clangCandidate);
});

test("rejects nonstandard full Git object-id lengths", async (context) => {
    const root = await fixture(context);
    const written = await writeBuildReceipt(root, input());
    for (const length of [41, 63]) {
        const receipt = structuredClone(written.receipt);
        receipt.source.revision = "a".repeat(length);
        assert.throws(() => validateBuildReceipt(receipt), /full hexadecimal commit/);
    }
});

test("validates receipt tree entries and their internal digest", async (context) => {
    const root = await fixture(context);
    const written = await writeBuildReceipt(root, input());

    const tamperedDigest = structuredClone(written.receipt);
    tamperedDigest.installedTree.entries[0].mode = 0o700;
    assert.throws(() => validateBuildReceipt(tamperedDigest),
        /is invalid|digest does not match/);

    const unsafe = structuredClone(written.receipt);
    unsafe.installedTree.entries[0].path = "../escape";
    assert.throws(() => validateBuildReceipt(unsafe), /safe relative path/);

    const duplicate = structuredClone(written.receipt);
    duplicate.installedTree.entries.splice(
        1, 0, structuredClone(duplicate.installedTree.entries[0]));
    duplicate.installedTree.digest = "0".repeat(64);
    assert.throws(() => validateBuildReceipt(duplicate), /duplicate or not/);
});
