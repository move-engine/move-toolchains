#!/usr/bin/env node
import path from "node:path";
import {fileURLToPath} from "node:url";
import {canonicalJson} from "./build-receipt.mjs";
import {gccBuildPlan, loadGccRecipe} from "./gcc-recipe.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
    console.log(`Usage:
  npm run gcc -- plan --profile windows-x86_64-ucrt64 [--json]

The plan command is read-only. Build, qualify, and package commands are added
only with explicit cost acceptance; this command never downloads or builds.`);
}

function fail(message) {
    throw new Error(message);
}

function parseArguments(argumentsValue) {
    const values = new Map();
    let command = null;
    for (let index = 0; index < argumentsValue.length; index += 1) {
        const argument = argumentsValue[index];
        if (!command && !argument.startsWith("-")) {
            command = argument;
        } else if (argument === "--json") {
            values.set(argument, true);
        } else if (argument === "--profile") {
            const value = argumentsValue[++index];
            if (!value) fail("--profile requires a value");
            values.set(argument, value);
        } else if (["--help", "-h"].includes(argument)) {
            values.set("--help", true);
        } else {
            fail(`unknown argument: ${argument}`);
        }
    }
    return {command, values};
}

export async function main(argumentsValue = process.argv.slice(2)) {
    const {command, values} = parseArguments(argumentsValue);
    if (values.has("--help") || !command) {
        usage();
        return;
    }
    if (command !== "plan") fail(`unsupported GCC command: ${command}`);
    const profile = values.get("--profile");
    if (!profile) fail("plan requires --profile");
    const recipePath = path.join(repositoryRoot, "recipes", "gcc", `${profile}.json`);
    const plan = gccBuildPlan(await loadGccRecipe(recipePath));
    if (values.has("--json")) {
        process.stdout.write(canonicalJson(plan));
        return;
    }
    console.log(`Move GCC build plan`);
    console.log(`  profile: ${plan.profile}`);
    console.log(`  source: ${plan.source.repository}@${plan.source.revision}`);
    console.log(`  Move patches: ${plan.source.patchRevisions.join(", ")}`);
    console.log(`  builder: ${plan.builder.kind}`);
    console.log(`  target: ${plan.triples.target}; CPU: ${plan.targetCpuBaseline}`);
    console.log(`  recipe SHA-256: ${plan.recipeDigest}`);
    console.log(`  estimated free space: ${plan.costs.buildGiB} GiB`);
    console.log(`  no download or build was started`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(`error: ${error.message}`);
        process.exitCode = 1;
    });
}
