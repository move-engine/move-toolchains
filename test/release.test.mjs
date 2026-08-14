import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {verifyArtifacts} from "../tools/release.mjs";

async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), "move-toolchains-test-"));
    const contents = path.join(root, "contents");
    const archiveRoot = "clang-p2996/revision/install";
    const install = path.join(contents, ...archiveRoot.split("/"));
    await mkdir(path.join(install, "bin"), {recursive: true});
    await writeFile(path.join(install, "bin", "clangd.exe"), "fixture\n");
    await writeFile(path.join(install, "move-qualification.json"), "{}\n");
    const archive = path.join(root, "fixture.zip");
    execFileSync("tar", ["-a", "-cf", archive, "-C", contents, "clang-p2996"]);
    const hash = createHash("sha256").update(await readFile(archive)).digest("hex");
    await writeFile(path.join(root, "fixture.zip.sha256"),
        `${hash}  fixture.zip\n`);
    return {root, archiveRoot};
}

test("verifies a complete archive and checksum", async (context) => {
    const {root, archiveRoot} = await fixture();
    context.after(() => rm(root, {recursive: true, force: true}));
    const result = await verifyArtifacts({artifacts: [{
        id: "fixture",
        host: "win32-x64",
        file: "fixture.zip",
        checksumFile: "fixture.zip.sha256",
        archiveRoot,
        requiredEntries: ["bin/clangd.exe", "move-qualification.json"],
    }]}, root);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "fixture");
});

test("rejects a checksum mismatch", async (context) => {
    const {root, archiveRoot} = await fixture();
    context.after(() => rm(root, {recursive: true, force: true}));
    await writeFile(path.join(root, "fixture.zip.sha256"),
        `${"0".repeat(64)}  fixture.zip\n`);
    await assert.rejects(() => verifyArtifacts({artifacts: [{
        id: "fixture",
        host: "win32-x64",
        file: "fixture.zip",
        checksumFile: "fixture.zip.sha256",
        archiveRoot,
        requiredEntries: ["bin/clangd.exe"],
    }]}, root), /SHA-256 mismatch/);
});
