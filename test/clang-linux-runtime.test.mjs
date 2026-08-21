import assert from "node:assert/strict";
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {
    copyPairedGccRuntimeLibraries,
    pairedGccRuntimeLibraries,
} from "../tools/clang-linux-runtime.mjs";

test("copies the complete paired GCC runtime closure as regular files", async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), "move-clang-runtime-"));
    context.after(() => rm(root, {recursive: true, force: true}));
    const gcc = path.join(root, "gcc");
    const clang = path.join(root, "clang");
    await mkdir(path.join(gcc, "lib64"), {recursive: true});
    for (const name of pairedGccRuntimeLibraries) {
        const target = `${name}.exact`;
        await writeFile(path.join(gcc, "lib64", target), name);
        await symlink(target, path.join(gcc, "lib64", name));
    }
    await copyPairedGccRuntimeLibraries(gcc, clang);
    for (const name of pairedGccRuntimeLibraries) {
        assert.equal(await readFile(path.join(clang, "lib", name), "utf8"), name);
    }
});
