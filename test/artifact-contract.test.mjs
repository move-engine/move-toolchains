import assert from "node:assert/strict";
import test from "node:test";
import {validateReleaseEvidence} from "../tools/artifact-contract.mjs";
import {importedNamespaceProbeRevision} from "../tools/record-clang-module-evidence.mjs";

function fixture(component, cases) {
    const artifact = {
        id: `${component}-fixture`, component,
        profile: "linux-x86_64-glibc2.35", file: `${component}.tar.gz`,
        bytes: 1, sha256: "a".repeat(64),
        receipt: {file: "move-build-receipt.json", sha256: "b".repeat(64),
            installedTreeDigest: "c".repeat(64)},
        derivation: {sourceRevision: "d".repeat(40)},
    };
    const evidence = {
        schemaVersion: 1, component, profile: artifact.profile,
        artifact: {file: artifact.file, bytes: 1, sha256: artifact.sha256},
        receipt: artifact.receipt,
        cases: cases.map(id => ({id, status: "passed"})),
    };
    return {artifact, evidence};
}

const common = ["archive-checksum", "archive-relocation-path-with-spaces",
    "archive-runtime-closure"];

test("requires GCC reflection/modules evidence", () => {
    const {artifact, evidence} = fixture("gcc", common);
    assert.throws(() => validateReleaseEvidence(evidence, artifact),
        /archive-reflection-and-modules/u);
    evidence.cases.push({id: "archive-reflection-and-modules", status: "passed"});
    assert.equal(validateReleaseEvidence(evidence, artifact), evidence);
});

test("requires distinct clang runtime and module-LSP evidence", () => {
    const {artifact, evidence} = fixture("clangTools", [
        ...common, "archive-reflection-runtime", "archive-import-std-reflection",
    ]);
    assert.throws(() => validateReleaseEvidence(evidence, artifact),
        /archive-module-lsp/u);
    evidence.cases.push({
        id: "archive-module-lsp",
        status: "passed",
        probeRevision: importedNamespaceProbeRevision,
        toolchainRevision: artifact.derivation.sourceRevision,
        result: {
            definitionLocations: 1,
            importedRenameDocuments: 1,
            referenceLocations: 1,
            renameDocuments: 1,
            semanticTokenWords: 1,
        },
    });
    assert.equal(validateReleaseEvidence(evidence, artifact), evidence);
});

test("rejects status-only or mismatched clang module evidence", () => {
    const {artifact, evidence} = fixture("clangTools", [
        ...common, "archive-reflection-runtime", "archive-import-std-reflection",
        "archive-module-lsp",
    ]);
    assert.throws(() => validateReleaseEvidence(evidence, artifact),
        /invalid module LSP identity/u);
    const valid = {
        id: "archive-module-lsp", status: "passed",
        probeRevision: importedNamespaceProbeRevision,
        toolchainRevision: artifact.derivation.sourceRevision,
        result: {
            definitionLocations: 1, importedRenameDocuments: 1,
            referenceLocations: 1, renameDocuments: 1, semanticTokenWords: 1,
        },
    };
    evidence.cases[evidence.cases.length - 1] = valid;
    assert.equal(validateReleaseEvidence(evidence, artifact), evidence);
    valid.toolchainRevision = "e".repeat(40);
    assert.throws(() => validateReleaseEvidence(evidence, artifact),
        /invalid module LSP identity/u);
});
