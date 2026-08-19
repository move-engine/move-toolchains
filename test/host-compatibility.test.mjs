import assert from "node:assert/strict";
import test from "node:test";
import {
    detectLinuxLibc,
    selectCompatibleArtifact,
    sourceBuildAlternative,
    unsupportedLinuxMessage,
} from "../tools/host-compatibility.mjs";

const artifacts = [
    {
        id: "clang-p2996-linux-x64-glibc238",
        host: "linux-x86_64-glibc2.38",
        requirements: {minimumGlibc: "2.38"},
    },
    {
        id: "clang-p2996-linux-x64-glibc235",
        host: "linux-x86_64-glibc2.35",
        requirements: {minimumGlibc: "2.35"},
    },
    {id: "clang-p2996-windows-x64", host: "windows-x86_64"},
];

test("detects runtime glibc from the Node process report", () => {
    assert.deepEqual(detectLinuxLibc({
        header: {glibcVersionRuntime: "2.35"},
        sharedObjects: [],
    }), {family: "glibc", version: "2.35"});
});

test("distinguishes musl and unknown libc without ldd parsing", () => {
    assert.deepEqual(detectLinuxLibc({
        header: {}, sharedObjects: ["/lib/ld-musl-x86_64.so.1"],
    }), {family: "musl", version: null});
    assert.deepEqual(detectLinuxLibc({header: {}, sharedObjects: []}),
        {family: "unknown", version: null});
});

test("selects the newest Linux artifact whose glibc floor is compatible", () => {
    assert.equal(selectCompatibleArtifact(
        artifacts, "clangd", "linux-x64",
        {family: "glibc", version: "2.35"})?.id,
    "clang-p2996-linux-x64-glibc235");
    assert.equal(selectCompatibleArtifact(
        artifacts, "clangd", "linux-x64",
        {family: "glibc", version: "2.41"})?.id,
    "clang-p2996-linux-x64-glibc238");
});

test("rejects glibc below every floor, musl, and unknown libc", () => {
    for (const libc of [
        {family: "glibc", version: "2.34"},
        {family: "musl", version: null},
        {family: "unknown", version: null},
    ]) {
        assert.equal(selectCompatibleArtifact(
            artifacts, "clangd", "linux-x64", libc), null);
    }
});

test("retains ordinary host selection outside Linux", () => {
    assert.equal(selectCompatibleArtifact(
        artifacts, "clangd", "win32-x64")?.id,
    "clang-p2996-windows-x64");
});

test("unsupported errors promise no implicit source build", () => {
    const error = sourceBuildAlternative(unsupportedLinuxMessage(
        {family: "glibc", version: "2.34"}));
    assert.match(error, /glibc 2\.34/);
    assert.match(error, /No source build was started/);
    assert.match(error, /80 GiB/);
});
