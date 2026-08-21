import assert from "node:assert/strict";
import test from "node:test";
import {validateReleaseEvidence} from "../tools/artifact-contract.mjs";

function fixture(component, cases) {
    const artifact = {
        id: `${component}-fixture`, component,
        profile: "linux-x86_64-glibc2.35", file: `${component}.tar.gz`,
        bytes: 1, sha256: "a".repeat(64),
        receipt: {file: "move-build-receipt.json", sha256: "b".repeat(64),
            installedTreeDigest: "c".repeat(64)},
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
        ...common, "archive-reflection-runtime",
    ]);
    assert.throws(() => validateReleaseEvidence(evidence, artifact),
        /archive-module-lsp/u);
    evidence.cases.push({id: "archive-module-lsp", status: "passed"});
    assert.equal(validateReleaseEvidence(evidence, artifact), evidence);
});
