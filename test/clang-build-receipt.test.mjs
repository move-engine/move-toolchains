import assert from "node:assert/strict";
import test from "node:test";
import {validateBuildReceipt} from "../tools/build-receipt.mjs";
import {
    clangReceiptInput,
    clangConfigureArguments,
    clangSourceIdentity,
} from "../tools/clang-build-receipt.mjs";

test("builds a receipt input for each supported clang tools profile", () => {
    for (const profile of ["windows-x86_64-ucrt64",
        "linux-x86_64-glibc2.35", "linux-x86_64-glibc2.38"]) {
        const input = clangReceiptInput({
            profile,
            builderIdentity: "fixture-builder",
            bootstrapVersion: "fixture compiler",
            configuration: {generator: "Ninja", buildType: "Release"},
            installTargets: ["install-clang", "install-clangd"],
            environment: {},
            sourceTree: "f".repeat(40),
        });
        assert.equal(input.source.revision, clangSourceIdentity.revision);
        assert.equal(input.profile, profile);
        assert.doesNotThrow(() => validateBuildReceipt({
            ...input,
            schemaVersion: 1,
            installedTree: {algorithm: "sha256-canonical-json-v1",
                digest: "37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570",
                entries: []},
        }));
    }
});

test("records the exact normalized bootstrap CMake policy", () => {
    const arguments_ = clangConfigureArguments({
        generator: "Ninja", buildType: "Release",
        projects: "clang;clang-tools-extra", runtimes: "libcxx",
        targets: "X86",
    });
    assert.deepEqual(arguments_.slice(0, 8), [
        "cmake", "-S", "@source@/llvm", "-B", "@build@", "-G", "Ninja",
        "-DCMAKE_BUILD_TYPE=Release",
    ]);
    assert.ok(arguments_.includes("-DLLVM_ENABLE_PROJECTS=clang;clang-tools-extra"));
});
