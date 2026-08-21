import {canonicalJson} from "./build-receipt.mjs";
import {importedNamespaceProbeRevision} from "./record-clang-module-evidence.mjs";

function fail(message) {
    throw new Error(message);
}

function validateModuleLspCase(entry, artifact) {
    const resultKeys = [
        "definitionLocations",
        "importedRenameDocuments",
        "referenceLocations",
        "renameDocuments",
        "semanticTokenWords",
    ];
    if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify([
        "id", "probeRevision", "result", "status", "toolchainRevision",
    ]) || entry.probeRevision !== importedNamespaceProbeRevision ||
        entry.toolchainRevision !== artifact.derivation?.sourceRevision ||
        !entry.result ||
        JSON.stringify(Object.keys(entry.result).sort()) !==
            JSON.stringify(resultKeys)) {
        fail(`release evidence for ${artifact.id} has invalid module LSP identity`);
    }
    for (const key of resultKeys) {
        if (!Number.isSafeInteger(entry.result[key]) || entry.result[key] < 1) {
            fail(`release evidence for ${artifact.id} has invalid module LSP result`);
        }
    }
}

export function validateReleaseEvidence(evidence, artifact) {
    if (evidence.schemaVersion !== 1 || evidence.component !== artifact.component ||
        evidence.profile !== artifact.profile ||
        evidence.artifact?.file !== artifact.file ||
        evidence.artifact?.bytes !== artifact.bytes ||
        evidence.artifact?.sha256 !== artifact.sha256 ||
        evidence.receipt?.file !== artifact.receipt.file ||
        evidence.receipt?.sha256 !== artifact.receipt.sha256 ||
        evidence.receipt?.installedTreeDigest !==
            artifact.receipt.installedTreeDigest) {
        fail(`release evidence disagrees with artifact ${artifact.id}`);
    }
    if (!Array.isArray(evidence.cases)) {
        fail(`release evidence for ${artifact.id} has no case results`);
    }
    const cases = new Map();
    for (const entry of evidence.cases) {
        if (!entry || typeof entry.id !== "string" || cases.has(entry.id)) {
            fail(`release evidence for ${artifact.id} has an invalid case set`);
        }
        cases.set(entry.id, entry);
    }
    const required = [
        "archive-checksum",
        "archive-relocation-path-with-spaces",
        "archive-runtime-closure",
    ];
    if (artifact.component === "gcc") {
        required.push("archive-reflection-and-modules");
    } else if (artifact.component === "clangTools") {
        required.push("archive-reflection-runtime", "archive-module-lsp");
    } else {
        fail(`release evidence has unknown component ${artifact.component}`);
    }
    if (artifact.component === "gcc" &&
        artifact.profile === "windows-x86_64-ucrt64") {
        required.push("archive-win64-avx-stack-alignment");
    }
    for (const id of required) {
        if (cases.get(id)?.status !== "passed") {
            fail(`release evidence for ${artifact.id} lacks passing case ${id}`);
        }
    }
    if (artifact.component === "clangTools") {
        validateModuleLspCase(cases.get("archive-module-lsp"), artifact);
    }
    return evidence;
}

export function parseAndValidateReleaseEvidence(text, artifact) {
    const evidence = JSON.parse(text);
    if (canonicalJson(evidence) !== text) {
        fail(`release evidence is not canonical JSON: ${artifact.evidence.file}`);
    }
    return validateReleaseEvidence(evidence, artifact);
}

export function validateReceiptIdentity(receipt, artifact, configuration) {
    const component = configuration.components[artifact.component];
    if (receipt.component !== artifact.component ||
        receipt.componentVersion !== component.version ||
        receipt.packageRevision !== component.packageRevision ||
        receipt.profile !== artifact.profile ||
        receipt.manifestDigest !== artifact.derivation.configurationDigest ||
        receipt.source.revision !== artifact.derivation.sourceRevision ||
        receipt.source.upstreamBaseRevision !==
            artifact.derivation.upstreamBaseRevision ||
        JSON.stringify(receipt.source.patchRevisions) !==
            JSON.stringify(artifact.derivation.patchRevisions) ||
        receipt.installedTree.digest !== artifact.receipt.installedTreeDigest) {
        fail(`embedded receipt disagrees with artifact ${artifact.id}`);
    }
    return receipt;
}
