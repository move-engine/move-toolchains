import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {
    gccBuildPlan,
    loadGccRecipe,
    validateGccRecipe,
    windowsGccOperationIds,
} from "../tools/gcc-recipe.mjs";

const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), "..");
const recipePath = path.join(
    repositoryRoot, "recipes", "gcc", "windows-x86_64-ucrt64.json");

test("loads the exact Windows UCRT64 Move GCC recipe", async () => {
    const loaded = await loadGccRecipe(recipePath);
    assert.match(loaded.digest, /^[0-9a-f]{64}$/);
    assert.equal(loaded.recipe.source.revision,
        "ced2ae7f6670c0371e0464e5aaa888c44ebd012a");
    assert.deepEqual(loaded.recipe.source.patchRevisions, [
        "ced2ae7f6670c0371e0464e5aaa888c44ebd012a",
    ]);
    assert.equal(loaded.recipe.profile.runtime.family, "ucrt");
    assert.equal(loaded.recipe.profile.threadModel, "posix");
    assert.equal(loaded.recipe.profile.exceptionModel, "seh");
    assert.equal(loaded.builderLock.lock.packages.length, 128);
});

test("keeps Move compiler patches separate from selected Windows host patches", async () => {
    const {recipe} = await loadGccRecipe(recipePath);
    assert.equal(recipe.source.patchRevisions.length, 1);
    assert.equal(recipe.profile.patches.length, 8);
    assert.equal(recipe.profile.patches.filter((entry) =>
        entry.sourceDependency === "msys2-gcc-recipes" &&
        entry.path.startsWith("mingw-w64-gcc/") &&
        entry.target === "gcc").length, 7);
    assert.deepEqual(recipe.profile.patches.filter((entry) =>
        entry.sourceDependency === "move-toolchains").map((entry) => entry.path), [
        "patches/gcc/0002-windows-posix-dir-exists-gcc-16.2.patch",
    ]);
    assert.equal(recipe.profile.phases[3].operations[0].expectedTree,
        "01301fbf04e6bd96be2b6bb8b2cecc26a02b2595");
});

test("uses locked MSYS2 dependencies without shipping its bootstrap GCC", async () => {
    const {recipe, builderLock} = await loadGccRecipe(recipePath);
    const payload = new Set(recipe.profile.builder.payloadPackages);
    assert.equal(payload.has("mingw-w64-ucrt-x86_64-gcc"), false);
    assert.equal(payload.has("mingw-w64-ucrt-x86_64-gcc-libs"), false);
    assert.equal(payload.has("mingw-w64-ucrt-x86_64-binutils"), true);
    assert.equal(payload.has("mingw-w64-ucrt-x86_64-crt"), true);
    assert.deepEqual(recipe.profile.builder.bootstrapRuntimePackages, [
        "mingw-w64-ucrt-x86_64-gcc-libs",
    ]);
    assert.deepEqual(recipe.profile.builder.generatedProvides, [
        "mingw-w64-ucrt-x86_64-cc-libs",
    ]);
    assert.ok(recipe.profile.builder.generatedRuntimeFiles.includes(
        "bin/libgcc_s_seh-1.dll"));
    const locked = new Set(builderLock.lock.packages.map((entry) => entry.name));
    assert.ok([...payload].every((name) => locked.has(name)));
});

test("produces a complete read-only normalized derivation plan", async () => {
    const loaded = await loadGccRecipe(recipePath);
    const plan = gccBuildPlan(loaded);
    assert.equal(plan.profile, "windows-x86_64-ucrt64");
    assert.equal(plan.costs.explicitAcceptanceRequired, true);
    assert.equal(plan.source.tree, loaded.recipe.source.tree);
    assert.deepEqual(plan.dependencies, loaded.recipe.dependencies);
    assert.equal(plan.builder.resolvedLock.packages.length, 128);
    assert.equal(plan.builder.resolvedLock.roots.shell, "usr/bin/bash.exe");
    assert.equal(plan.builder.resolvedLock.signaturePolicy.requireEveryPackage, true);
    assert.deepEqual(plan.phases.map((phase) => phase.id), [
        "materialize-builder", "materialize-sources", "populate-sysroot",
        "prepare-gcc", "configure-gcc", "build-gcc", "install-gcc",
    ]);
    assert.deepEqual(plan.phases.flatMap((phase) =>
        phase.operations.map((operation) => operation.id)),
    windowsGccOperationIds);
    assert.equal(plan.roots.source, "@workspace@/source/gcc");
    assert.equal(plan.environmentPolicy.mode, "allowlist-plus-recipe");
});

test("rejects profile, dependency, patch, builder, and payload drift", async () => {
    const {recipe} = await loadGccRecipe(recipePath);
    for (const mutate of [
        (value) => value.profile.targetCpuBaseline = "native",
        (value) => value.profile.runtime = {family: "msvcrt"},
        (value) => value.dependencies = [],
        (value) => value.dependencies[0].revision = "bad",
        (value) => value.profile.patches[0].path = "../escape.patch",
        (value) => value.profile.patches[0].blob = "bad",
        (value) => value.profile.patches[1].sourceDependency = "unknown",
        (value) => value.profile.builder.lock.sha256 = "bad",
        (value) => value.profile.builder.payloadPackages =
            value.profile.builder.payloadPackages.filter(
                (entry) => entry !== "mingw-w64-ucrt-x86_64-binutils"),
        (value) => value.profile.builder.payloadPackages.push(
            "mingw-w64-ucrt-x86_64-gcc"),
        (value) => value.profile.builder.bootstrapRuntimePackages = [],
        (value) => value.profile.builder.generatedProvides = [],
        (value) => value.profile.builder.generatedRuntimeFiles = [],
        (value) => value.profile.builder.shell = "bash",
    ]) {
        const candidate = structuredClone(recipe);
        mutate(candidate);
        assert.throws(() => validateGccRecipe(candidate));
    }
});

test("rejects changed or conflicting configure policy", async () => {
    const {recipe} = await loadGccRecipe(recipePath);
    const argumentsValue = (value) => value.profile.phases[4].operations[0].arguments;
    for (const mutate of [
        (value) => argumentsValue(value).splice(
            argumentsValue(value).indexOf("--with-sysroot=@sysroot@"), 1),
        (value) => argumentsValue(value).push("--enable-threads=win32"),
        (value) => argumentsValue(value).push("--disable-lto"),
        (value) => argumentsValue(value).splice(
            argumentsValue(value).indexOf("--enable-lto"), 1),
        (value) => argumentsValue(value).splice(
            argumentsValue(value).indexOf("--with-boot-ldflags=-static-libstdc++"), 1),
        (value) => argumentsValue(value).splice(
            argumentsValue(value).indexOf("--with-build-sysroot=@sysroot-windows@"), 1),
        (value) => argumentsValue(value).splice(
            argumentsValue(value).indexOf("--with-arch=x86-64"), 1),
    ]) {
        const candidate = structuredClone(recipe);
        mutate(candidate);
        assert.throws(() => validateGccRecipe(candidate));
    }
});

test("rejects phase-order, bootstrap-command, and logical-root drift", async () => {
    const {recipe} = await loadGccRecipe(recipePath);
    for (const mutate of [
        (value) => value.profile.phases.reverse(),
        (value) => value.profile.phases[0].operations[0].id = "different",
        (value) => value.profile.phases[3].operations[0].expectedTree = "bad",
        (value) => value.profile.phases[0].operations[1].verifySignatures = false,
        (value) => value.profile.phases[0].operations[0].fresh = [],
        (value) => value.profile.phases[0].operations[0].exactReuse = [],
        (value) => value.profile.phases[0].operations[0].derivationIdentity = "stale",
        (value) => value.profile.phases[1].operations[0].checkoutEol = "native",
        (value) => value.profile.phases[2].operations[0].stripPrefix = "",
        (value) => value.profile.phases[2].operations[0].collisionPolicy = "overwrite",
        (value) => value.profile.phases[5].operations[0].arguments.pop(),
        (value) => delete value.profile.phases[5].operations[0].interpreter,
        (value) => delete value.profile.phases[5].operations[0].environmentPolicy,
        (value) => delete value.profile.phases[5].operations[0].environment,
        (value) => value.profile.phases[5].operations[0].arguments.splice(
            value.profile.phases[5].operations[0].arguments.indexOf("MAKEINFO=true"),
            1),
        (value) => value.profile.phases[6].operations[0].arguments = ["install-strip"],
        (value) => value.profile.phases[6].operations[0].arguments = ["install"],
        (value) => value.profile.phases[6].operations[2].forbidResolutionFrom = "",
        (value) => value.profile.roots.install = "@workspace@/different",
        (value) => value.profile.environment.gcc_cv_have_tls = "no",
        (value) => value.profile.environmentPolicy.inherit.push("PATH"),
    ]) {
        const candidate = structuredClone(recipe);
        mutate(candidate);
        assert.throws(() => validateGccRecipe(candidate));
    }
});

test("rejects duplicate dependency and payload identities", async () => {
    const {recipe} = await loadGccRecipe(recipePath);
    const duplicateDependency = structuredClone(recipe);
    duplicateDependency.dependencies.push(
        structuredClone(duplicateDependency.dependencies[0]));
    assert.throws(() => validateGccRecipe(duplicateDependency), /duplicate/);

    const duplicatePackage = structuredClone(recipe);
    duplicatePackage.profile.builder.payloadPackages.push(
        duplicatePackage.profile.builder.payloadPackages[0]);
    assert.throws(() => validateGccRecipe(duplicatePackage), /duplicate/);
});
