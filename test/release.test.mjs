import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdtemp, mkdir, readFile, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {
    immutableReleasesEnabled,
    releaseAssetErrors,
    resolveReleaseTag,
    verifyArtifacts,
} from "../tools/release.mjs";
import {canonicalJson, writeBuildReceipt} from "../tools/build-receipt.mjs";

const qualificationCases = [
    "c11-smoke", "cxx-smoke", "cxx26-reflection", "cxx20-modules",
    "imported-namespace-reflection", "gcc-reflect-2", "gcc-reflect-3",
    "gcc-reflect-4", "staged-prefix-independence", "runtime-closure",
];

test("requires the requested tag to match the source manifest", () => {
    const configuration = {release: {tag: "toolchains-2026.08.8"}};
    assert.equal(resolveReleaseTag(configuration), "toolchains-2026.08.8");
    assert.equal(resolveReleaseTag(
        configuration, "toolchains-2026.08.8"), "toolchains-2026.08.8");
    assert.throws(() => resolveReleaseTag(
        configuration, "toolchains-2026.08.6"), /does not match/u);
});

test("requires an explicit enabled immutable-release response", () => {
    assert.equal(immutableReleasesEnabled('{"enabled":true}'), true);
    assert.equal(immutableReleasesEnabled('{"enabled":false}'), false);
    assert.equal(immutableReleasesEnabled("not json"), false);
});

test("requires every remote release asset to be uploaded and digested", () => {
    const expected = [{name: "toolchain.zip", size: 42, sha256: "abc"}];
    assert.deepEqual(releaseAssetErrors(expected, [{
        name: "toolchain.zip",
        size: 42,
        state: "uploaded",
        digest: "sha256:abc",
    }]), []);
    const errors = releaseAssetErrors(expected, [{
        name: "toolchain.zip",
        size: 42,
        state: "starter",
        digest: null,
    }]);
    assert.match(errors.join("\n"), /expected uploaded state/u);
    assert.match(errors.join("\n"), /found no digest/u);
});

async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), "move-toolchains-test-"));
    const contents = path.join(root, "contents");
    const archiveRoot = "clang-p2996/revision/install";
    const install = path.join(contents, ...archiveRoot.split("/"));
    await mkdir(path.join(install, "bin"), {recursive: true});
    await writeFile(path.join(install, "bin", "g++"), "fixture\n");
    const receipt = await writeBuildReceipt(install, {
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
            id: "fixture", kind: "archive", file: "fixture.tar.xz",
            source: "https://example.invalid/fixture", version: "1",
            checksum: {algorithm: "sha256", digest: "e".repeat(64)},
        }],
        build: {
            triples: {build: "x86_64-pc-linux-gnu", host: "x86_64-pc-linux-gnu",
                target: "x86_64-pc-linux-gnu"},
            configure: ["configure", "--prefix=@install@"],
            bootstrap: {identity: "fixture", observedVersion: "fixture"},
            buildCommands: [["make"]], installCommands: [["make", "install"]],
        },
        environment: {
            builderIdentity: "fixture", targetCpuBaseline: "x86-64",
            runtimeIdentity: {family: "glibc", minimumVersion: "2.35"},
            variables: {},
        },
        qualification: {schemaVersion: 1,
            cases: qualificationCases.map((id) => ({id, status: "passed"}))},
    });
    const file = process.platform === "win32" ? "fixture.zip" : "fixture.tar.gz";
    const archive = path.join(root, file);
    const tarArguments = process.platform === "win32"
        ? ["-a", "-cf", archive, "-C", contents, "clang-p2996"]
        : ["-czf", archive, "-C", contents, "clang-p2996"];
    execFileSync("tar", tarArguments);
    const hash = createHash("sha256").update(await readFile(archive)).digest("hex");
    await writeFile(path.join(root, `${file}.sha256`), `${hash}  ${file}\n`);
    const bytes = (await stat(archive)).size;
    const artifact = {
        id: "fixture", component: "gcc", profile: "linux-x86_64-glibc2.35",
        file, checksumFile: `${file}.sha256`, archiveRoot,
        sha256: hash, bytes,
        derivation: {
            sourceRevision: "a".repeat(40),
            upstreamBaseRevision: "b".repeat(40),
            patchRevisions: ["c".repeat(40)],
            configurationDigest: "7".repeat(64),
        },
        receipt: {schemaVersion: 1, file: "move-build-receipt.json",
            sha256: receipt.sha256,
            installedTreeDigest: receipt.receipt.installedTree.digest},
    };
    const evidenceText = canonicalJson({
        schemaVersion: 1, component: artifact.component, profile: artifact.profile,
        artifact: {file, bytes: artifact.bytes, sha256: hash},
        receipt: artifact.receipt,
        cases: ["archive-checksum", "archive-relocation-path-with-spaces",
            "archive-runtime-closure", "archive-reflection-and-modules"]
            .map((id) => ({id, status: "passed"})),
    });
    await writeFile(path.join(root, `${file}.evidence.json`), evidenceText);
    artifact.evidence = {schemaVersion: 1, file: `${file}.evidence.json`,
        sha256: createHash("sha256").update(evidenceText).digest("hex")};
    const configuration = {components: {gcc: {
        version: "16.2.0", packageRevision: "move.1",
    }}, artifacts: [artifact]};
    return {root, archiveRoot, file, artifact, configuration};
}

test("verifies a complete archive and checksum", async (context) => {
    const {root, configuration} = await fixture();
    context.after(() => rm(root, {recursive: true, force: true}));
    const result = await verifyArtifacts(configuration, root);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "fixture");
});

test("rejects a checksum mismatch", async (context) => {
    const {root, file, configuration} = await fixture();
    context.after(() => rm(root, {recursive: true, force: true}));
    await writeFile(path.join(root, `${file}.sha256`),
        `${"0".repeat(64)}  ${file}\n`);
    await assert.rejects(() => verifyArtifacts(configuration, root),
        /SHA-256 mismatch/);
});
