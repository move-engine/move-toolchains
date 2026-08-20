import assert from "node:assert/strict";
import test from "node:test";
import {parseArguments} from "../tools/qualify-gcc-linux.mjs";

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
