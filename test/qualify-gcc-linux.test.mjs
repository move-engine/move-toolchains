import assert from "node:assert/strict";
import test from "node:test";
import {
    parseArguments,
    validateQualificationRuntime,
} from "../tools/qualify-gcc-linux.mjs";

test("requires every exact Linux GCC qualification input", () => {
    const parsed = parseArguments([
        "--install-root", "/toolchain/install",
        "--source-root", "/toolchain/source",
        "--minimum-glibc", "2.35",
        "--probe-root", "/src/nez",
        "--xmake", "/tools/xmake",
        "--json",
    ]);
    assert.equal(parsed.values.get("--minimum-glibc"), "2.35");
    assert.equal(parsed.flags.has("--json"), true);
});

test("rejects absent, duplicate, and unknown qualification inputs", () => {
    assert.throws(() => parseArguments([]), /--install-root is required/);
    assert.throws(() => parseArguments([
        "--install-root", "/a", "--install-root", "/b",
    ]), /duplicate argument/);
    assert.throws(() => parseArguments(["--unsafe"]), /unknown argument/);
});

test("qualifies the declared glibc floor and newer compatible runtimes", () => {
    assert.doesNotThrow(() => validateQualificationRuntime(
        {family: "glibc", version: "2.35"}, "2.35"));
    assert.doesNotThrow(() => validateQualificationRuntime(
        {family: "glibc", version: "2.38"}, "2.35"));
    assert.throws(() => validateQualificationRuntime(
        {family: "glibc", version: "2.34"}, "2.35"), /2.35 or newer/);
    assert.throws(() => validateQualificationRuntime(
        {family: "musl", version: null}, "2.35"), /musl/);
});
