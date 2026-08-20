import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {
    comparePacmanVersions,
    loadBuilderLock,
    msys2BuilderLockId,
    validateBuilderLock,
} from "../tools/msys2-builder-lock.mjs";

const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = path.join(
    repositoryRoot, "recipes", "builders", "msys2-ucrt64-20260820.json");

test("matches the pacman version semantics used by this exact transaction", () => {
    assert.equal(comparePacmanVersions("1.26-1", "1.26"), 0);
    assert.equal(comparePacmanVersions("6.3.0-2", "5.0"), 1);
    assert.equal(comparePacmanVersions("1~20260214-1", "1"), -1);
    assert.equal(comparePacmanVersions("1.0a", "1.0"), -1);
    assert.equal(comparePacmanVersions("1.0rc1", "1.0"), -1);
    assert.equal(comparePacmanVersions("1.0.1", "1.0"), 1);
    assert.equal(comparePacmanVersions("2:1.0-1", "1:99.0-9"), 1);
});

test("loads the canonical immutable MSYS2 UCRT64 builder closure", async () => {
    const loaded = await loadBuilderLock(lockPath);
    assert.equal(loaded.lock.id, msys2BuilderLockId);
    assert.equal(loaded.lock.packages.length, 128);
    assert.deepEqual(loaded.lock.requestedPackages, [
        "autoconf-wrapper", "automake-wrapper", "bison", "flex", "git", "libtool",
        "make", "mingw-w64-ucrt-x86_64-gcc", "msys2-keyring", "patch", "tar",
        "texinfo", "xz", "zstd",
    ]);
    assert.equal(loaded.digest,
        "5fc7598db13a922377d2662d1918fc7e32d3234ec00f577cd091fca3ca05656e");
    assert.ok(loaded.lock.packages.some((entry) =>
        entry.name === "mingw-w64-ucrt-x86_64-gcc" &&
        entry.version === "16.2.0-3"));
    assert.ok(loaded.lock.packages.some((entry) =>
        entry.name === "mingw-w64-ucrt-x86_64-gcc-libs" &&
        entry.provides.includes("mingw-w64-ucrt-x86_64-cc-libs")));
});

test("rejects mutable, incomplete, and relocated builder inputs", async () => {
    const {lock} = await loadBuilderLock(lockPath);
    for (const mutate of [
        (value) => value.base.url = "https://example.invalid/base.exe",
        (value) => value.signaturePolicy.requireEveryPackage = false,
        (value) => value.packages.pop(),
        (value) => value.packages[0].sha256 = "bad",
        (value) => value.packages[0].file = "../escape.pkg.tar.zst",
        (value) => value.packages[0].url = "https://example.invalid/package",
        (value) => value.packages[0].signature.url =
            "https://example.invalid/package.sig",
        (value) => value.packages[0].dependencies = ["missing-package"],
        (value) => value.packages[0].provides = ["../escape"],
        (value) => value.requestedPackages.pop(),
    ]) {
        const candidate = structuredClone(lock);
        mutate(candidate);
        assert.throws(() => validateBuilderLock(candidate));
    }
});

test("rejects version-incompatible providers and unrelated locked packages", async () => {
    const {lock} = await loadBuilderLock(lockPath);
    const wrongVersion = structuredClone(lock);
    wrongVersion.packages.find((entry) => entry.name === "gmp").version = "4.0.0";
    assert.throws(() => validateBuilderLock(wrongVersion), /gmp>=5\.0/);

    const unrelated = structuredClone(lock);
    const detached = unrelated.packages.find((entry) => entry.name === "nano");
    detached.dependencies = [];
    unrelated.packages.forEach((entry) => {
        entry.dependencies = entry.dependencies.filter(
            (dependency) => !dependency.startsWith("nano"));
    });
    assert.throws(() => validateBuilderLock(unrelated), /outside the resolved transaction/);
});

test("rejects duplicate package and archive identities", async () => {
    const {lock} = await loadBuilderLock(lockPath);
    const duplicateName = structuredClone(lock);
    duplicateName.packages[1].name = duplicateName.packages[0].name;
    duplicateName.packages.sort((left, right) => Buffer.compare(
        Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8")));
    assert.throws(() => validateBuilderLock(duplicateName), /duplicate/);

    const duplicateFile = structuredClone(lock);
    duplicateFile.packages[1].file = duplicateFile.packages[0].file;
    duplicateFile.packages[1].url = duplicateFile.packages[0].url;
    duplicateFile.packages[1].signature.file = `${duplicateFile.packages[1].file}.sig`;
    duplicateFile.packages[1].signature.url = `${duplicateFile.packages[1].url}.sig`;
    assert.throws(() => validateBuilderLock(duplicateFile), /duplicate/);
});
