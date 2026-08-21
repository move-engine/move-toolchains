#!/usr/bin/env node

import {readFile} from "node:fs/promises";
import path from "node:path";
import {verifyArtifacts} from "./release.mjs";
import {validateToolchainManifest} from "./toolchain-set.mjs";

function fail(message) {
    throw new Error(message);
}

function arguments_(argv) {
    const values = new Map();
    for (let index = 0; index < argv.length; index += 2) {
        const name = argv[index];
        const value = argv[index + 1];
        if (!["--configuration", "--artifact-dir", "--artifact-id"].includes(name) ||
            !value || values.has(name)) {
            fail("expected exact --configuration, --artifact-dir, and --artifact-id arguments");
        }
        values.set(name, value);
    }
    if (values.size !== 3) fail("receipt verifier arguments are incomplete");
    return values;
}

async function main() {
    if (process.platform !== "linux") {
        fail("cross-host Linux receipt verification requires native Linux");
    }
    const values = arguments_(process.argv.slice(2));
    const configuration = validateToolchainManifest(JSON.parse(await readFile(
        path.resolve(values.get("--configuration")), "utf8")));
    const artifactId = values.get("--artifact-id");
    const artifact = configuration.artifacts.find(
        candidate => candidate.id === artifactId);
    if (!artifact || !artifact.profile.startsWith("linux-")) {
        fail(`artifact is not a declared Linux artifact: ${artifactId}`);
    }
    await verifyArtifacts(
        {...configuration, artifacts: [artifact]},
        path.resolve(values.get("--artifact-dir")));
    console.log(`native Linux receipt verified: ${artifactId}`);
}

main().catch(error => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
});
