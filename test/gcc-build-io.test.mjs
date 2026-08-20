import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {
    downloadExactHttpsAsset,
    mergeArchiveManifests,
    validateArchiveManifest,
} from "../tools/gcc-build-io.mjs";

async function fixture(context) {
    const root = await mkdtemp(path.join(tmpdir(), "move-gcc-io-test-"));
    context.after(() => rm(root, {recursive: true, force: true}));
    return root;
}

function asset(bytes, url = "https://example.test/archive") {
    return {
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        url,
    };
}

function response(bytes, options = {}) {
    return new Response(bytes, {
        headers: options.headers ?? {"content-length": String(bytes.length)},
        status: options.status ?? 200,
    });
}

test("streams an exact HTTPS download through an atomic cache entry", async (context) => {
    const root = await fixture(context);
    const bytes = Buffer.from("locked payload");
    const destination = path.join(root, "cache", "archive");
    const urls = [];
    const result = await downloadExactHttpsAsset(asset(bytes), destination, {
        fetch: async (url) => {
            urls.push(url.href);
            if (urls.length === 1) {
                return response(Buffer.alloc(0), {
                    headers: {location: "https://cdn.example.test/archive"},
                    status: 302,
                });
            }
            return response(bytes);
        },
    });
    assert.equal(result.reused, false);
    assert.deepEqual(urls, [
        "https://example.test/archive",
        "https://cdn.example.test/archive",
    ]);
    assert.deepEqual(await readFile(destination), bytes);
    const reused = await downloadExactHttpsAsset(asset(bytes), destination, {
        fetch: async () => { throw new Error("cache should prevent fetch"); },
    });
    assert.equal(reused.reused, true);
});

test("publishes one exact cache entry under concurrent downloaders", async (context) => {
    const root = await fixture(context);
    const bytes = Buffer.from("concurrent locked payload");
    const destination = path.join(root, "archive");
    const [left, right] = await Promise.all([
        downloadExactHttpsAsset(asset(bytes), destination, {
            fetch: async () => response(bytes),
        }),
        downloadExactHttpsAsset(asset(bytes), destination, {
            fetch: async () => response(bytes),
        }),
    ]);
    assert.deepEqual([left.reused, right.reused].sort(), [false, true]);
    assert.deepEqual(await readFile(destination), bytes);
    assert.deepEqual(await readdir(root), ["archive"]);
});

test("removes a private partial download after stream failure", async (context) => {
    const root = await fixture(context);
    const bytes = Buffer.from("partial payload");
    const body = {
        async *[Symbol.asyncIterator]() {
            yield bytes.subarray(0, 4);
            throw new Error("injected cancellation");
        },
    };
    await assert.rejects(downloadExactHttpsAsset(asset(bytes),
        path.join(root, "archive"), {
            fetch: async () => ({
                body,
                headers: new Headers(),
                ok: true,
                status: 200,
            }),
        }), /injected cancellation/);
    assert.deepEqual(await readdir(root), []);
});

test("honors AbortSignal before and during local download work", async (context) => {
    const root = await fixture(context);
    const bytes = Buffer.from("abortable payload");
    const alreadyAborted = new AbortController();
    alreadyAborted.abort(new Error("already aborted"));
    await assert.rejects(downloadExactHttpsAsset(asset(bytes),
        path.join(root, "never-created"), {
            fetch: async () => { throw new Error("must not fetch"); },
            signal: alreadyAborted.signal,
        }), /already aborted/);

    const midStream = new AbortController();
    const body = {
        async *[Symbol.asyncIterator]() {
            yield bytes.subarray(0, 4);
            midStream.abort(new Error("mid-stream abort"));
            yield bytes.subarray(4);
        },
    };
    await assert.rejects(downloadExactHttpsAsset(asset(bytes),
        path.join(root, "mid-stream"), {
            fetch: async () => ({
                body,
                headers: new Headers(),
                ok: true,
                status: 200,
            }),
            signal: midStream.signal,
        }), /mid-stream abort/);
    assert.deepEqual(await readdir(root), []);
});

test("rejects downgrade, truncation, overflow, and digest mismatch", async (context) => {
    const root = await fixture(context);
    const bytes = Buffer.from("expected");
    const cases = [
        async () => response(Buffer.alloc(0), {
            headers: {location: "http://example.test/archive"}, status: 302,
        }),
        async () => response(bytes.subarray(0, 2), {headers: {}}),
        async () => response(Buffer.concat([bytes, Buffer.from("extra")]), {headers: {}}),
        async () => response(Buffer.from("different"), {headers: {}}),
    ];
    for (const [index, fetchOperation] of cases.entries()) {
        const destination = path.join(root, `archive-${index}`);
        await assert.rejects(downloadExactHttpsAsset(
            asset(bytes), destination, {fetch: fetchOperation}));
        await assert.rejects(readFile(destination), /ENOENT/);
    }
    await assert.rejects(downloadExactHttpsAsset(asset(bytes),
        path.join(root, "oversize"), {
            fetch: async () => { throw new Error("must fail before fetch"); },
            maximumBytes: bytes.length - 1,
        }), /size ceiling/);
});

test("does not trust a same-name cache entry with wrong bytes", async (context) => {
    const root = await fixture(context);
    const destination = path.join(root, "archive");
    const bytes = Buffer.from("correct");
    await writeFile(destination, "wrong!!");
    await assert.rejects(downloadExactHttpsAsset(asset(bytes), destination, {
        fetch: async () => response(bytes),
    }));
    assert.equal(await readFile(destination, "utf8"), "wrong!!");
    await assert.rejects(downloadExactHttpsAsset(asset(bytes),
        path.join(root, "symlink-cache"), {
            fetch: async () => { throw new Error("must not fetch"); },
            io: {
                lstat: async () => ({isFile: () => false}),
            },
        }), /preserved/);
});

const file = (name, digest = "a".repeat(64)) => ({
    mode: 0o644, path: name, sha256: digest, type: "file",
});

test("rejects hostile archive paths, links, devices, and case collisions", () => {
    for (const manifest of [
        [file("../escape")],
        [file("C:/escape")],
        [file("dir/file:stream")],
        [file("dir/CON.txt")],
        [file("dir/COM\u00b9.txt")],
        [file("dir/LPT\u00b2")],
        [file("dir/trailing.")],
        [file("Dir/File"), file("dir/file")],
        [{mode: 0o644, path: "device", type: "device"}],
        [{linkTarget: "../../escape", mode: 0o777, path: "dir/link", type: "symlink"}],
        [{linkTarget: "../COM\u00b3.txt", mode: 0o777,
            path: "dir/link", type: "symlink"}],
        [{linkTarget: "../escape", mode: 0o777, path: "link", type: "hardlink"}],
        [file("bin"), file("bin/tool.exe")],
        [{linkTarget: "lib", mode: 0o777, path: "bin", type: "symlink"},
            file("bin/tool.exe")],
        [{...file("extra"), ignoredMetadata: true}],
        [{mode: 0o755, path: "dir", sha256: "a".repeat(64), type: "directory"}],
        [{linkTarget: "target", mode: 0o777, path: "link",
            sha256: "a".repeat(64), type: "symlink"}],
    ]) assert.throws(() => validateArchiveManifest(manifest));
    assert.doesNotThrow(() => validateArchiveManifest([
        {linkTarget: "../lib/library.dll", mode: 0o777,
            path: "bin/library.dll", type: "symlink"},
        {mode: 0o755, path: "lib/library.dll", sha256: "a".repeat(64), type: "file"},
    ]));
    const input = [file("immutable/input")];
    const validated = validateArchiveManifest(input);
    assert.notEqual(validated[0], input[0]);
});

test("allows only identical package payload collisions", () => {
    const common = file("bin/common.dll");
    assert.equal(mergeArchiveManifests([
        [file("include/a.h"), common],
        [structuredClone(common), file("include/b.h")],
    ]).length, 3);
    assert.throws(() => mergeArchiveManifests([
        [common], [file("bin/common.dll", "b".repeat(64))],
    ]), /not identical/);
    assert.throws(() => mergeArchiveManifests([
        [file("Bin/tool.exe")], [file("bin/other.exe")],
    ]), /case-fold collision/);
    assert.throws(() => mergeArchiveManifests([
        [{linkTarget: "lib", mode: 0o777, path: "bin", type: "symlink"}],
        [file("bin/tool.exe")],
    ]), /non-directory parent/);
});
