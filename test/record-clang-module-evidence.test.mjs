import assert from "node:assert/strict";
import test from "node:test";
import {
    addModuleLspEvidence,
    importedNamespaceProbeRevision,
} from "../tools/record-clang-module-evidence.mjs";

const revision = "a".repeat(40);
const evidence = {
    schemaVersion: 1,
    component: "clangTools",
    profile: "windows-x86_64-ucrt64",
    artifact: {file: "clang.zip", bytes: 1, sha256: "b".repeat(64)},
    cases: [
        {id: "archive-reflection-runtime", status: "passed"},
        {id: "archive-import-std-reflection", status: "passed"},
    ],
};
const configuration = {
    components: {clangTools: {source: {revision}}},
    artifacts: [{component: "clangTools", profile: evidence.profile,
        file: evidence.artifact.file, sha256: evidence.artifact.sha256}],
};
const result = {
    probeRevision: importedNamespaceProbeRevision,
    toolchainHost: "win32-x64", toolchainRevision: revision,
    hover: true, definitionLocations: 1, referenceLocations: 3,
    importedPrepareRename: true, importedRenameDocuments: 3,
    prepareRename: true, renameDocuments: 1, semanticTokenWords: 11,
    completionHasImportedMember: true,
    diagnosticCount: 0, diagnostics: [],
};

test("records exact successful clang module LSP evidence", () => {
    const updated = addModuleLspEvidence(evidence, result, configuration);
    const recorded = updated.cases.at(-1);
    assert.equal(recorded.id, "archive-module-lsp");
    assert.equal(recorded.probeRevision, importedNamespaceProbeRevision);
    assert.equal(recorded.result.referenceLocations, 3);
});

test("narrows legacy packaging evidence before adding exact LSP evidence", () => {
    const updated = addModuleLspEvidence({
        ...evidence,
        cases: [
            {id: "archive-reflection-and-modules", status: "passed"},
            {id: "archive-import-std-reflection", status: "passed"},
        ],
    }, result, configuration);
    assert.equal(updated.cases.some(candidate =>
        candidate.id === "archive-reflection-and-modules"), false);
    assert.equal(updated.cases.find(candidate =>
        candidate.id === "archive-reflection-runtime")?.status, "passed");
});

test("rejects diagnostics and wrong toolchain identity", () => {
    assert.throws(() => addModuleLspEvidence(
        evidence, {...result, diagnosticCount: 1}, configuration),
    /did not pass/u);
    assert.throws(() => addModuleLspEvidence(
        evidence, {...result, toolchainRevision: "c".repeat(40)}, configuration),
    /did not pass/u);
});

test("rejects evidence not bound to the source manifest", () => {
    assert.throws(() => addModuleLspEvidence(
        {...evidence, artifact: {...evidence.artifact, sha256: "d".repeat(64)}},
        result, configuration), /does not match/u);
});
