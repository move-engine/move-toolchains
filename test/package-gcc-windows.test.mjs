import assert from "node:assert/strict";
import test from "node:test";
import {parseArguments} from "../tools/package-gcc-windows.mjs";

test("requires an explicit GCC install root", () => {
    assert.throws(() => parseArguments([]), /install-root/);
    assert.equal(parseArguments(["--help"]).help, true);
});

test("parses the bounded Windows package request", () => {
    const parsed = parseArguments([
        "--install-root", "M:\\gcc install",
        "--source-root", "M:\\gcc source",
        "--output-dir", "F:\\artifacts",
        "--staging-root", "M:\\staging",
        "--force",
    ]);
    assert.equal(parsed.values.get("--install-root"), "M:\\gcc install");
    assert.equal(parsed.values.get("--source-root"), "M:\\gcc source");
    assert.equal(parsed.flags.has("--force"), true);
    assert.throws(() => parseArguments([
        "--install-root", "M:\\gcc", "--source-root", "M:\\source",
        "--publish",
    ]), /unknown argument/);
});
