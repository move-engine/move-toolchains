import assert from "node:assert/strict";
import test from "node:test";
import {
    selectCompatibleToolchainSet,
    validateToolchainManifest,
} from "../tools/toolchain-set.mjs";

function fixture() {
    const components = {
        gcc: {
            version: "16.2.0",
            packageRevision: "move.1",
            source: {
                repository: "https://github.com/move-engine/gcc.git",
                revision: "b".repeat(40),
                upstreamBaseRevision: "c".repeat(40),
                patchRevisions: ["d".repeat(40)],
            },
        },
        clangTools: {
            version: "p2996",
            packageRevision: "move.1",
            source: {
                repository: "https://github.com/move-engine/clang-p2996.git",
                revision: "3".repeat(40),
                upstreamBaseRevision: "3".repeat(40),
                patchRevisions: [],
            },
        },
    };
    const profiles = {
        "windows-x86_64-ucrt64": {
            platform: "windows",
            architecture: "x86_64",
            runtime: {family: "ucrt"},
        },
        "linux-x86_64-glibc2.38": {
            platform: "linux",
            architecture: "x86_64",
            runtime: {family: "glibc", minimumVersion: "2.38"},
        },
        "linux-x86_64-glibc2.35": {
            platform: "linux",
            architecture: "x86_64",
            runtime: {family: "glibc", minimumVersion: "2.35"},
        },
    };
    const artifacts = [];
    const toolchainSets = [];
    for (const profile of Object.keys(profiles)) {
        const suffix = profile.replaceAll(".", "");
        const gcc = `move-gcc-${suffix}`;
        const clangTools = `move-clang-tools-${suffix}`;
        artifacts.push(
            {
                id: gcc,
                component: "gcc",
                profile,
                file: `${gcc}.tar.gz`,
                checksumFile: `${gcc}.tar.gz.sha256`,
                archiveRoot: `gcc/${suffix}`,
                sha256: "a".repeat(64),
                bytes: 1,
                derivation: {
                    sourceRevision: "b".repeat(40),
                    upstreamBaseRevision: "c".repeat(40),
                    patchRevisions: ["d".repeat(40)],
                    configurationDigest: "e".repeat(64),
                },
                receipt: {
                    schemaVersion: 1,
                    file: "move-build-receipt.json",
                    sha256: "f".repeat(64),
                    installedTreeDigest: "1".repeat(64),
                },
            },
            {
                id: clangTools,
                component: "clangTools",
                profile,
                file: `${clangTools}.tar.gz`,
                checksumFile: `${clangTools}.tar.gz.sha256`,
                archiveRoot: `clang-tools/${suffix}`,
                sha256: "2".repeat(64),
                bytes: 1,
                derivation: {
                    sourceRevision: "3".repeat(40),
                    upstreamBaseRevision: "3".repeat(40),
                    patchRevisions: [],
                    configurationDigest: "4".repeat(64),
                },
                receipt: {
                    schemaVersion: 1,
                    file: "move-build-receipt.json",
                    sha256: "5".repeat(64),
                    installedTreeDigest: "6".repeat(64),
                },
            },
        );
        toolchainSets.push({
            id: `move-toolchain-set-${suffix}`,
            profile,
            components: {gcc, clangTools},
        });
    }
    return {schemaVersion: 2, components, profiles, artifacts, toolchainSets};
}

test("accepts three complete exact-profile toolchain sets", () => {
    assert.equal(validateToolchainManifest(fixture()).schemaVersion, 2);
});

test("selects the newest complete compatible glibc set", () => {
    const configuration = fixture();
    assert.equal(selectCompatibleToolchainSet(configuration, "linux-x64", {
        family: "glibc", version: "2.35",
    })?.profile, "linux-x86_64-glibc2.35");
    assert.equal(selectCompatibleToolchainSet(configuration, "linux-x64", {
        family: "glibc", version: "2.41",
    })?.profile, "linux-x86_64-glibc2.38");
});

test("selects the UCRT64 set on native Windows", () => {
    assert.equal(selectCompatibleToolchainSet(
        fixture(), "win32-x64")?.profile, "windows-x86_64-ucrt64");
});

test("rejects partial, cross-profile, and wrong-component sets", () => {
    const missing = fixture();
    delete missing.toolchainSets[0].components.clangTools;
    assert.throws(() => validateToolchainManifest(missing), /nonempty string/);

    const mixed = fixture();
    mixed.toolchainSets[0].components.clangTools =
        mixed.toolchainSets[1].components.clangTools;
    assert.throws(() => validateToolchainManifest(mixed), /mixes/);

    const wrong = fixture();
    wrong.toolchainSets[0].components.gcc =
        wrong.toolchainSets[0].components.clangTools;
    assert.throws(() => validateToolchainManifest(wrong), /maps gcc to clangTools/);
});

test("binds each profile id to its canonical platform and runtime floor", () => {
    for (const mutate of [
        (value) => value.profiles["linux-x86_64-glibc2.38"]
            .runtime.minimumVersion = "2.35",
        (value) => value.profiles["linux-x86_64-glibc2.35"]
            .runtime.minimumVersion = "2.38",
        (value) => value.profiles["windows-x86_64-ucrt64"].platform = "linux",
    ]) {
        const configuration = fixture();
        mutate(configuration);
        assert.throws(() => validateToolchainManifest(configuration),
            /canonical runtime identity/);
    }
});

test("requires all six artifacts and all three complete sets", () => {
    const noSets = fixture();
    noSets.toolchainSets = [];
    assert.throws(() => validateToolchainManifest(noSets), /set is absent/);

    const missingSet = fixture();
    missingSet.toolchainSets.pop();
    assert.throws(() => validateToolchainManifest(missingSet), /set is absent/);

    const missingArtifact = fixture();
    missingArtifact.artifacts.pop();
    assert.throws(() => validateToolchainManifest(missingArtifact),
        /artifact is absent/);

    const orphan = fixture();
    orphan.artifacts.push({...orphan.artifacts[0], id: "orphan"});
    assert.throws(() => validateToolchainManifest(orphan), /duplicate artifact slot/);
});

test("requires archive, derivation, and receipt identities", () => {
    const cases = [
        ["archive", (artifact) => artifact.sha256 = "bad"],
        ["sourceRevision", (artifact) => artifact.derivation.sourceRevision = "bad"],
        ["derivation", (artifact) => artifact.derivation.configurationDigest = "bad"],
        ["receipt", (artifact) => artifact.receipt.installedTreeDigest = "bad"],
        ["safe relative", (artifact) => artifact.file = "../escape.tar.gz"],
    ];
    for (const [message, mutate] of cases) {
        const configuration = fixture();
        mutate(configuration.artifacts[0]);
        assert.throws(() => validateToolchainManifest(configuration),
            new RegExp(message));
    }
});

test("requires one shared source identity for every component profile", () => {
    const divergentGcc = fixture();
    divergentGcc.artifacts.find((artifact) =>
        artifact.component === "gcc").derivation.sourceRevision = "9".repeat(40);
    assert.throws(() => validateToolchainManifest(divergentGcc),
        /shared gcc source identity/);

    const divergentClang = fixture();
    divergentClang.artifacts.find((artifact) =>
        artifact.component === "clangTools").derivation.patchRevisions =
            ["8".repeat(40)];
    assert.throws(() => validateToolchainManifest(divergentClang),
        /shared clangTools source identity/);

    const unpatchedGcc = fixture();
    unpatchedGcc.components.gcc.source.patchRevisions = [];
    for (const artifact of unpatchedGcc.artifacts.filter(
        (candidate) => candidate.component === "gcc")) {
        artifact.derivation.patchRevisions = [];
    }
    assert.throws(() => validateToolchainManifest(unpatchedGcc),
        /ordered patch stack/);
});

test("rejects nonstandard Git object-id lengths", () => {
    for (const length of [41, 63]) {
        const component = fixture();
        component.components.gcc.source.revision = "b".repeat(length);
        assert.throws(() => validateToolchainManifest(component),
            /invalid source revision/);

        const artifact = fixture();
        artifact.artifacts[0].derivation.sourceRevision = "b".repeat(length);
        assert.throws(() => validateToolchainManifest(artifact),
            /invalid sourceRevision/);
    }
});

test("rejects musl, unknown libc, and hosts below every floor", () => {
    const configuration = fixture();
    for (const libc of [
        {family: "musl", version: null},
        {family: "unknown", version: null},
        {family: "glibc", version: "2.34"},
    ]) {
        assert.equal(selectCompatibleToolchainSet(
            configuration, "linux-x64", libc), null);
    }
});

test("honors exact glibc floor boundaries", () => {
    const configuration = fixture();
    assert.equal(selectCompatibleToolchainSet(configuration, "linux-x64", {
        family: "glibc", version: "2.37",
    })?.profile, "linux-x86_64-glibc2.35");
    assert.equal(selectCompatibleToolchainSet(configuration, "linux-x64", {
        family: "glibc", version: "2.38",
    })?.profile, "linux-x86_64-glibc2.38");
});
