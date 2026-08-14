import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
    hostEnvironmentSuffix,
    parseDotEnv,
    resolveSettings,
} from "../tools/config.mjs";

test("parses simple quoted and exported dotenv assignments", () => {
    assert.deepEqual(parseDotEnv(`
# comment
MOVE_TOOLCHAINS_LOCAL_ROOT="M:\\src"
export MOVE_GCC_ROOT='/opt/gcc/current'
`), {
        MOVE_TOOLCHAINS_LOCAL_ROOT: "M:\\src",
        MOVE_GCC_ROOT: "/opt/gcc/current",
    });
});

test("host environment root overrides saved and global roots", () => {
    const configuration = {schemaVersion: 1, hosts: {
        "win32-x64": {localRoot: "C:\\saved", clangRoot: "C:\\clang"},
    }};
    const settings = resolveSettings(configuration, {
        MOVE_TOOLCHAINS_LOCAL_ROOT: "C:\\global",
        MOVE_TOOLCHAINS_WIN32_X64_ROOT: "M:\\host",
    }, "win32-x64");
    assert.equal(settings.localRoot, path.resolve("M:\\host"));
    assert.equal(settings.clangRoot, path.resolve("C:\\clang"));
});

test("host names map to stable environment suffixes", () => {
    assert.equal(hostEnvironmentSuffix("linux-x64"), "LINUX_X64");
});
