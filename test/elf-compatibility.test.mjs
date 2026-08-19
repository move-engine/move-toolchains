import assert from "node:assert/strict";
import test from "node:test";
import {
    elfToolMaxBuffer,
    requiredGlibcVersions,
} from "../tools/elf-compatibility.mjs";

test("extracts, deduplicates, and sorts required GLIBC versions", () => {
    assert.deepEqual(requiredGlibcVersions(`
      0x00 0x069691b4  GLIBC_2.34
      0x01 0x09691a75  GLIBC_2.2.5
      Name: GLIBC_2.34
      Name: GLIBCXX_3.4.30
      Name: GLIBC_2.35
    `), ["2.2.5", "2.34", "2.35"]);
});

test("allows readelf output larger than Node's default child-process buffer", () => {
    assert.ok(elfToolMaxBuffer > 1024 * 1024);
    const largeOutput = `${"x".repeat(2 * 1024 * 1024)} GLIBC_2.35`;
    assert.deepEqual(requiredGlibcVersions(largeOutput), ["2.35"]);
});
