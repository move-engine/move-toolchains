import assert from "node:assert/strict";
import test from "node:test";
import {renameWithRetry} from "../tools/filesystem.mjs";

test("retries transient Windows rename failures", async () => {
    let calls = 0;
    const waits = [];
    await renameWithRetry("source", "destination", {
        renameOperation: async () => {
            ++calls;
            if (calls < 3) throw Object.assign(new Error("busy"), {code: "EPERM"});
        },
        wait: async (milliseconds) => waits.push(milliseconds),
    });
    assert.equal(calls, 3);
    assert.deepEqual(waits, [50, 100]);
});

test("does not retry permanent rename failures", async () => {
    let calls = 0;
    await assert.rejects(renameWithRetry("source", "destination", {
        renameOperation: async () => {
            ++calls;
            throw Object.assign(new Error("missing"), {code: "ENOENT"});
        },
        wait: async () => assert.fail("permanent errors must not wait"),
    }), {code: "ENOENT"});
    assert.equal(calls, 1);
});
