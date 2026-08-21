import assert from "node:assert/strict";
import test from "node:test";
import {
    reflectionConfiguration,
    reflectionConfigurationIdentity,
} from "../tools/reflection/bootstrap.mjs";

const revision = "a".repeat(40);
const hostConfiguration = {"linux-x64": {qualificationKind: "full-toolchain"}};

test("accepts the legacy reflection component shape", () => {
    const config = reflectionConfiguration({
        schemaVersion: 1,
        components: {"clang-p2996": {
            repository: "https://example.invalid/clang.git",
            revision,
            qualificationSchemaVersion: 3,
            hosts: hostConfiguration,
        }},
    });
    assert.equal(config.revision, revision);
});

test("normalizes the schema 2 clang tools source identity", () => {
    const config = reflectionConfiguration({
        schemaVersion: 2,
        components: {clangTools: {
            source: {
                repository: "https://example.invalid/clang.git",
                revision,
            },
            qualificationSchemaVersion: 3,
            hosts: hostConfiguration,
        }},
    });
    assert.equal(config.repository, "https://example.invalid/clang.git");
    assert.equal(config.revision, revision);
});

test("rejects incomplete schema 2 clang tools configuration", () => {
    assert.throws(() => reflectionConfiguration({
        schemaVersion: 2,
        components: {clangTools: {source: {}, hosts: hostConfiguration,
            qualificationSchemaVersion: 3}},
    }), /full lowercase Git commit/u);
});

test("binds Windows qualification to GCC identity rather than its relocated path", () => {
    const config = {repository: "https://example.invalid/clang.git", revision};
    const profile = {qualificationKind: "language-server", gccVersion: "16.2.0",
        gccTarget: "x86_64-w64-mingw32"};
    assert.equal(
        reflectionConfigurationIdentity(config, profile, "C:\\first", "win32-x64"),
        reflectionConfigurationIdentity(config, profile, "M:\\second", "win32-x64"));
    assert.notEqual(
        reflectionConfigurationIdentity(config, profile, "C:\\first", "win32-x64"),
        reflectionConfigurationIdentity(config, {...profile, gccVersion: "16.3.0"},
            "C:\\first", "win32-x64"));
});
