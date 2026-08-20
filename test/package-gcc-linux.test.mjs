import assert from "node:assert/strict";
import test from "node:test";
import {parseArguments} from "../tools/package-gcc-linux.mjs";

test("requires every Linux GCC packaging input", () => {
    assert.throws(() => parseArguments([]), /--install-root is required/);
    const parsed = parseArguments([
        "--install-root", "/install", "--source-root", "/source",
        "--minimum-glibc", "2.35", "--probe-root", "/probe",
        "--xmake", "/xmake", "--force",
    ]);
    assert.equal(parsed.values.get("--minimum-glibc"), "2.35");
    assert.equal(parsed.flags.has("--force"), true);
});

test("rejects unknown and duplicate Linux GCC package arguments", () => {
    assert.throws(() => parseArguments(["--wat"]), /unknown argument/);
    assert.throws(() => parseArguments([
        "--install-root", "/a", "--install-root", "/b",
    ]), /duplicate argument/);
});
