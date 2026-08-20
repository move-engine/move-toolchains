import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {
    relativeRuntimeSearchPath,
    requiresBundling,
} from "../tools/gcc-linux-runtime.mjs";

test("computes relocatable GCC runtime search paths", () => {
    const install = path.resolve("/opt/move/gcc/install");
    assert.equal(relativeRuntimeSearchPath(
        install, path.join(install, "lib64", "libstdc++.so.6")), "$ORIGIN");
    assert.equal(relativeRuntimeSearchPath(
        install, path.join(install, "bin", "g++")), "$ORIGIN/../lib64");
    assert.equal(relativeRuntimeSearchPath(install, path.join(
        install, "libexec", "gcc", "x86_64-pc-linux-gnu", "16.2.0", "cc1plus")),
    "$ORIGIN/../../../../lib64");
});

test("bundles compiler runtimes but leaves the glibc platform ABI external", () => {
    for (const name of ["libgcc_s.so.1", "libstdc++.so.6", "libgmp.so.10",
        "libmpfr.so.6", "libmpc.so.3", "libisl.so.23", "libz.so.1"]) {
        assert.equal(requiresBundling(name), true, name);
    }
    assert.equal(requiresBundling("libc.so.6"), false);
    assert.equal(requiresBundling("libm.so.6"), false);
    assert.equal(requiresBundling("libdl.so.2"), false);
    assert.equal(requiresBundling("libpthread.so.0"), false);
    assert.equal(requiresBundling("ld-linux-x86-64.so.2"), false);
    assert.equal(requiresBundling("libnss_files.so.2"), false);
    assert.equal(requiresBundling("libcrypt.so.1"), true);
});
