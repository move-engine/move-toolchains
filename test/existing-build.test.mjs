import assert from "node:assert/strict";
import test from "node:test";
import {
    existingBuildCacheErrors,
    parseCmakeCache,
    sameRepository,
} from "../tools/reflection/existing-build.mjs";

const profile = {configuration: {
    buildType: "Release",
    generator: "Ninja",
    projects: "clang;clang-tools-extra",
    runtimes: "libcxx",
    targets: "X86",
}};

test("parses typed CMake cache entries", () => {
    const cache = parseCmakeCache(`
// comment
CMAKE_BUILD_TYPE:STRING=Release
CMAKE_GENERATOR:INTERNAL=Ninja
`);
    assert.equal(cache.get("CMAKE_BUILD_TYPE"), "Release");
    assert.equal(cache.get("CMAKE_GENERATOR"), "Ninja");
});

test("recognizes SSH and HTTPS spellings of one public GitHub repository", () => {
    assert.equal(sameRepository(
        "git@github.com:move-engine/clang-p2996.git",
        "https://github.com/move-engine/clang-p2996.git"), true);
    assert.equal(sameRepository(
        "git@github.com:move-engine/clang-p2996.git",
        "https://github.com/bloomberg/clang-p2996.git"), false);
});

test("accepts an exact Windows Release cache", () => {
    const contents = `
CMAKE_BUILD_TYPE:STRING=Release
CMAKE_GENERATOR:INTERNAL=Ninja
CMAKE_HOME_DIRECTORY:INTERNAL=M:/src/fork/source/llvm
LLVM_ENABLE_PROJECTS:STRING=clang;clang-tools-extra
LLVM_ENABLE_RUNTIMES:STRING=libcxx
LLVM_TARGETS_TO_BUILD:STRING=X86
`;
    assert.deepEqual(existingBuildCacheErrors(
        profile, "m:\\src\\fork\\source", contents, "win32"), []);
});

test("rejects stale, debug, or differently configured builds", () => {
    const contents = `
CMAKE_BUILD_TYPE:STRING=Debug
CMAKE_GENERATOR:INTERNAL=Ninja
CMAKE_HOME_DIRECTORY:INTERNAL=/old/source/llvm
LLVM_ENABLE_PROJECTS:STRING=clang
LLVM_ENABLE_RUNTIMES:STRING=libcxx
LLVM_TARGETS_TO_BUILD:STRING=X86
`;
    const errors = existingBuildCacheErrors(
        profile, "/new/source", contents, "linux");
    assert.match(errors.join("\n"), /CMAKE_BUILD_TYPE/u);
    assert.match(errors.join("\n"), /CMAKE_HOME_DIRECTORY/u);
    assert.match(errors.join("\n"), /LLVM_ENABLE_PROJECTS/u);
});
