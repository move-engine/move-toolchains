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
    const file = process.platform === "win32" ? "fixture.zip" : "fixture.tar.gz";
    const archive = path.join(root, file);
    const tarArguments = process.platform === "win32"
        ? ["-a", "-cf", archive, "-C", contents, "clang-p2996"]
        : ["-czf", archive, "-C", contents, "clang-p2996"];
    execFileSync("tar", tarArguments);
    const hash = createHash("sha256").update(await readFile(archive)).digest("hex");
    await writeFile(path.join(root, `${file}.sha256`), `${hash}  ${file}\n`);
    return {root, archiveRoot, file};
}

test("verifies a complete archive and checksum", async (context) => {
    const {root, archiveRoot, file} = await fixture();
    context.after(() => rm(root, {recursive: true, force: true}));
    const result = await verifyArtifacts({artifacts: [{
        id: "fixture",
        host: "win32-x64",
        file,
        checksumFile: `${file}.sha256`,
        archiveRoot,
        requiredEntries: ["bin/clangd.exe", "move-qualification.json"],
    }]}, root);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "fixture");
});

test("rejects a checksum mismatch", async (context) => {
    const {root, archiveRoot, file} = await fixture();
    context.after(() => rm(root, {recursive: true, force: true}));
    await writeFile(path.join(root, `${file}.sha256`),
        `${"0".repeat(64)}  ${file}\n`);
    await assert.rejects(() => verifyArtifacts({artifacts: [{
        id: "fixture",
        host: "win32-x64",
        file,
        checksumFile: `${file}.sha256`,
        archiveRoot,
        requiredEntries: ["bin/clangd.exe"],
    }]}, root), /SHA-256 mismatch/);
});
