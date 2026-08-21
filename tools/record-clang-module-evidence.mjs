import {randomUUID} from "node:crypto";
import {readFile, rename, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {canonicalJson} from "./build-receipt.mjs";

export const importedNamespaceProbeRevision =
    "06105d7c2cc9fa78c6db10231ace8c6847cadb67";

function fail(message) {
    throw new Error(message);
}

function positiveInteger(value, name) {
    if (!Number.isSafeInteger(value) || value < 1) {
        fail(`clang module LSP probe has invalid ${name}`);
    }
    return value;
}

export function moduleLspCase(result, expectedRevision, expectedHost) {
    if (!result || typeof result !== "object" ||
        result.toolchainRevision !== expectedRevision ||
        result.toolchainHost !== expectedHost || result.hover !== true ||
        result.importedPrepareRename !== true || result.prepareRename !== true ||
        result.completionHasRecord !== true ||
        result.completionHasWeightedValue !== true ||
        result.diagnosticCount !== 0 ||
        !Array.isArray(result.diagnostics) || result.diagnostics.length !== 0) {
        fail("clang module LSP probe did not pass the exact toolchain contract");
    }
    return {
        id: "archive-module-lsp",
        status: "passed",
        probeRevision: importedNamespaceProbeRevision,
        toolchainRevision: expectedRevision,
        result: {
            definitionLocations: positiveInteger(
                result.definitionLocations, "definitionLocations"),
            importedRenameDocuments: positiveInteger(
                result.importedRenameDocuments, "importedRenameDocuments"),
            referenceLocations: positiveInteger(
                result.referenceLocations, "referenceLocations"),
            renameDocuments: positiveInteger(
                result.renameDocuments, "renameDocuments"),
            semanticTokenWords: positiveInteger(
                result.semanticTokenWords, "semanticTokenWords"),
        },
    };
}

export function addModuleLspEvidence(evidence, result, configuration) {
    if (evidence?.schemaVersion !== 1 || evidence.component !== "clangTools") {
        fail("module LSP evidence can only update clangTools release evidence");
    }
    const component = configuration?.components?.clangTools;
    const artifact = configuration?.artifacts?.find(candidate =>
        candidate.component === "clangTools" &&
        candidate.profile === evidence.profile &&
        candidate.file === evidence.artifact?.file);
    if (!component || !artifact || artifact.sha256 !== evidence.artifact.sha256) {
        fail("clang release evidence does not match toolchains.json");
    }
    const expectedHost = evidence.profile === "windows-x86_64-ucrt64"
        ? "win32-x64" : "linux-x64";
    const entry = moduleLspCase(
        result, component.source.revision, expectedHost);
    if (!evidence.cases.some(candidate =>
        candidate.id === "archive-reflection-runtime" ||
        candidate.id === "archive-reflection-and-modules")) {
        fail("clang release evidence lacks its packaged reflection runtime case");
    }
    const cases = evidence.cases.filter(candidate =>
        candidate.id !== "archive-module-lsp" &&
        candidate.id !== "archive-reflection-and-modules");
    if (!cases.some(candidate => candidate.id === "archive-reflection-runtime")) {
        cases.push({id: "archive-reflection-runtime", status: "passed"});
    }
    cases.push(entry);
    return {...evidence, cases};
}

async function atomicReplace(file, contents) {
    const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
    const backup = `${file}.bak-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, contents, {flag: "wx"});
    try {
        await rename(file, backup);
        try {
            await rename(temporary, file);
        } catch (error) {
            await rename(backup, file);
            throw error;
        }
        await rm(backup, {force: true});
    } finally {
        await rm(temporary, {force: true});
    }
}

async function main(argv) {
    const argument = name => {
        const index = argv.indexOf(name);
        if (index < 0 || !argv[index + 1]) fail(`missing ${name}`);
        return path.resolve(argv[index + 1]);
    };
    const evidenceFile = argument("--evidence");
    const probeOutput = argument("--probe-output");
    const configurationFile = argument("--configuration");
    const evidence = JSON.parse(await readFile(evidenceFile, "utf8"));
    const result = JSON.parse(await readFile(probeOutput, "utf8"));
    const configuration = JSON.parse(await readFile(configurationFile, "utf8"));
    const updated = addModuleLspEvidence(evidence, result, configuration);
    await atomicReplace(evidenceFile, canonicalJson(updated));
    console.log(`recorded module LSP evidence: ${evidenceFile}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    main(process.argv.slice(2)).catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
