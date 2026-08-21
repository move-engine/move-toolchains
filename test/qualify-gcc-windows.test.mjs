import assert from "node:assert/strict";
import test from "node:test";
import {parseArguments} from "../tools/qualify-gcc-windows.mjs";

test("requires every exact Windows GCC qualification input", () => {
    const parsed = parseArguments([
        "--install-root", "M:\\toolchain install",
        "--source-root", "M:\\gcc source",
        "--probe-root", "F:\\src\\nez",
        "--xmake", "C:\\tools\\xmake.exe",
        "--json",
    ]);
    assert.equal(parsed.values.get("--probe-root"), "F:\\src\\nez");
    assert.equal(parsed.flags.has("--json"), true);
});

test("rejects absent, duplicate, and unknown Windows qualification inputs", () => {
    assert.throws(() => parseArguments([]), /--install-root is required/);
    assert.throws(() => parseArguments([
        "--install-root", "M:\\a", "--install-root", "M:\\b",
    ]), /duplicate argument/);
    assert.throws(() => parseArguments(["--unsafe"]), /unknown argument/);
});
