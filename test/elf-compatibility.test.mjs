import assert from "node:assert/strict";
import test from "node:test";
import {
    elfToolMaxBuffer,
    isIsolatedElfDependency,
    parseLdd,
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

test("requires GCC atomic runtime dependencies to resolve inside the package", () => {
    assert.equal(isIsolatedElfDependency("libatomic.so.1"), true);
    assert.equal(isIsolatedElfDependency("libc.so.6"), false);
});

test("allows readelf output larger than Node's default child-process buffer", () => {
    assert.ok(elfToolMaxBuffer > 1024 * 1024);
    const largeOutput = `${"x".repeat(2 * 1024 * 1024)} GLIBC_2.35`;
    assert.deepEqual(requiredGlibcVersions(largeOutput), ["2.35"]);
});

test("preserves relocated library paths containing spaces from ldd", () => {
    assert.deepEqual(parseLdd(`
      libc++abi.so.1 => /tmp/relocated package/lib/libc++abi.so.1 (0x1234)
      libunwind.so.1 => not found
      /lib64/ld-linux-x86-64.so.2 (0x5678)
    `), [
        {
            name: "libc++abi.so.1",
            resolved: "/tmp/relocated package/lib/libc++abi.so.1",
        },
        {name: "libunwind.so.1", resolved: "not found"},
    ]);
});
