#!/usr/bin/env node

import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {
    access,
    mkdir,
    readFile,
    stat,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const configurationPath = path.join(repositoryRoot, "toolchains.json");

function fail(message) {
    throw new Error(message);
}

function usage() {
    console.log(`Move toolchain release manager

Usage:
  npm run doctor
  npm run release:verify -- [--artifact-dir PATH] [--output-dir PATH]
  npm run release:publish -- --repository OWNER/REPO [--tag TAG]
      [--artifact-dir PATH] [--output-dir PATH] [--publish]

verify is read-only except for generated release metadata beneath --output-dir.
publish is a dry run unless --publish is supplied. A real publication creates a
draft release, uploads the complete qualified set, and publishes only after all
uploads succeed.`);
}

function parseArguments(argv) {
    const command = argv[0] ?? "help";
    const flags = new Set();
    const values = new Map();
    const flagNames = new Set(["--publish"]);
    const valueNames = new Set([
        "--artifact-dir", "--output-dir", "--repository", "--tag",
    ]);
    for (let index = 1; index < argv.length; ++index) {
        const name = argv[index];
        if (flagNames.has(name)) {
            if (flags.has(name)) fail(`duplicate argument: ${name}`);
            flags.add(name);
            continue;
        }
        if (!valueNames.has(name)) fail(`unknown argument: ${name}`);
        if (values.has(name)) fail(`duplicate argument: ${name}`);
        const value = argv[++index];
        if (!value || value.startsWith("--")) {
            fail(`${name} requires a value`);
        }
        values.set(name, value);
    }
    return {command, flags, values};
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: options.cwd ?? repositoryRoot,
        encoding: "utf8",
        stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
        env: options.env ?? process.env,
    });
    if (result.error) fail(`${command} could not start: ${result.error.message}`);
    if (result.status !== 0) {
        const detail = [result.stdout, result.stderr]
            .filter(Boolean).join("\n").trim();
        fail(`${command} exited with ${result.status}${detail ? `: ${detail}` : ""}`);
    }
    return (result.stdout ?? "").trim();
}

function tryRun(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: options.cwd ?? repositoryRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status !== 0) return null;
    return (result.stdout ?? "").trim();
}

function commandAvailable(command, args = ["--version"]) {
    const result = spawnSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    return !result.error && result.status === 0;
}

async function exists(file) {
    try {
        await access(file);
        return true;
    } catch {
        return false;
    }
}

async function readConfiguration() {
    const configuration = JSON.parse(await readFile(configurationPath, "utf8"));
    if (configuration.schemaVersion !== 1 ||
        !configuration.release ||
        !Array.isArray(configuration.artifacts) ||
        configuration.artifacts.length === 0) {
        fail("unsupported or incomplete toolchains.json schema");
    }
    const ids = new Set();
    const files = new Set();
    for (const artifact of configuration.artifacts) {
        if (!artifact.id || !artifact.file || !artifact.checksumFile ||
            !artifact.archiveRoot || !Array.isArray(artifact.requiredEntries)) {
            fail("artifact entries require id, file, checksumFile, archiveRoot, and requiredEntries");
        }
        if (ids.has(artifact.id)) fail(`duplicate artifact id: ${artifact.id}`);
        if (files.has(artifact.file)) fail(`duplicate artifact file: ${artifact.file}`);
        ids.add(artifact.id);
        files.add(artifact.file);
    }
    return configuration;
}

function resolveDirectories(values, tag) {
    return {
        artifactDirectory: path.resolve(
            values.get("--artifact-dir") ?? path.join(repositoryRoot, ".local", "prebuilt")),
        outputDirectory: path.resolve(
            values.get("--output-dir") ?? path.join(repositoryRoot, ".local", "releases", tag)),
    };
}

async function sha256(file) {
    const hash = createHash("sha256");
    const contents = await readFile(file);
    hash.update(contents);
    return hash.digest("hex");
}

function parseChecksum(text, expectedFile) {
    const match = text.trim().match(/^([0-9a-fA-F]{64})\s+[*]?(.+)$/);
    if (!match) fail(`invalid SHA-256 file for ${expectedFile}`);
    if (path.basename(match[2].trim()) !== expectedFile) {
        fail(`checksum names ${match[2].trim()}, expected ${expectedFile}`);
    }
    return match[1].toLowerCase();
}

function normalizeArchiveEntry(entry) {
    return entry.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function inspectArchive(file) {
    const listing = file.toLowerCase().endsWith(".zip") && process.platform !== "win32"
        ? run("unzip", ["-Z1", file])
        : run("tar", ["-tf", file]);
    const entries = listing.split(/\r?\n/)
        .map(normalizeArchiveEntry).filter(Boolean);
    for (const entry of entries) {
        if (entry.startsWith("/") || /^[A-Za-z]:\//.test(entry) ||
            entry.split("/").includes("..")) {
            fail(`unsafe archive entry in ${path.basename(file)}: ${entry}`);
        }
    }
    return new Set(entries);
}

export async function verifyArtifacts(configuration, artifactDirectory) {
    const verified = [];
    for (const artifact of configuration.artifacts) {
        const archive = path.join(artifactDirectory, artifact.file);
        const checksumFile = path.join(artifactDirectory, artifact.checksumFile);
        if (!(await exists(archive))) fail(`required artifact is missing: ${archive}`);
        if (!(await exists(checksumFile))) fail(`required checksum is missing: ${checksumFile}`);
        const expected = parseChecksum(await readFile(checksumFile, "utf8"), artifact.file);
        const actual = await sha256(archive);
        if (actual !== expected) {
            fail(`SHA-256 mismatch for ${artifact.file}: expected ${expected}, got ${actual}`);
        }
        const entries = inspectArchive(archive);
        for (const required of artifact.requiredEntries) {
            const full = normalizeArchiveEntry(`${artifact.archiveRoot}/${required}`);
            if (!entries.has(full)) {
                fail(`${artifact.file} is missing required entry ${full}`);
            }
        }
        const information = await stat(archive);
        verified.push({
            id: artifact.id,
            host: artifact.host,
            file: artifact.file,
            checksumFile: artifact.checksumFile,
            sha256: actual,
            bytes: information.size,
            requirements: artifact.requirements ?? {},
        });
    }
    return verified;
}

async function writeReleaseMetadata(configuration, verified, outputDirectory, tag) {
    await mkdir(outputDirectory, {recursive: true});
    const manifest = {
        schemaVersion: 1,
        tag,
        generatedAt: new Date().toISOString(),
        source: {
            repositoryCommit: tryRun("git", ["rev-parse", "HEAD"]),
            components: configuration.components,
        },
        artifacts: verified,
    };
    const manifestPath = path.join(outputDirectory, "release-manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const manifestHash = await sha256(manifestPath);
    const manifestChecksumPath = `${manifestPath}.sha256`;
    await writeFile(manifestChecksumPath,
        `${manifestHash}  ${path.basename(manifestPath)}\n`);
    const notesPath = path.join(outputDirectory, "release-notes.md");
    const lines = [
        `# ${configuration.release.title}`,
        "",
        configuration.release.notes,
        "",
        "## Assets",
        "",
        ...verified.map((artifact) =>
            `- \`${artifact.file}\` — ${artifact.host}, SHA-256 \`${artifact.sha256}\``),
        "",
        "Verify the downloaded archive against its adjacent `.sha256` file before extraction.",
        "",
    ];
    await writeFile(notesPath, lines.join("\n"));
    return {manifestPath, manifestChecksumPath, notesPath};
}

async function verify(configuration, values) {
    const tag = values.get("--tag") ?? configuration.release.tag;
    const {artifactDirectory, outputDirectory} = resolveDirectories(values, tag);
    const verified = await verifyArtifacts(configuration, artifactDirectory);
    const metadata = await writeReleaseMetadata(
        configuration, verified, outputDirectory, tag);
    console.log(`verified ${verified.length} release artifacts`);
    for (const artifact of verified) {
        console.log(`  ${artifact.file} (${artifact.bytes} bytes)`);
    }
    console.log(`release manifest: ${metadata.manifestPath}`);
    return {tag, artifactDirectory, outputDirectory, verified, metadata};
}

function assertCleanRepository() {
    if (!tryRun("git", ["rev-parse", "--verify", "HEAD"])) {
        fail("refusing to publish before the repository has an initial commit");
    }
    const status = run("git", ["status", "--porcelain"]);
    if (status) fail("refusing to publish from a dirty repository");
}

function assertValidRepositoryName(repository) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
        fail("--repository must be OWNER/REPO");
    }
}

export function immutableReleasesEnabled(response) {
    try {
        return JSON.parse(response).enabled === true;
    } catch {
        return false;
    }
}

function assertImmutableReleases(repository) {
    const status = spawnSync("gh", [
        "api", "-H", "X-GitHub-Api-Version: 2026-03-10",
        `repos/${repository}/immutable-releases`,
    ], {
        cwd: repositoryRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (status.error || status.status !== 0 ||
        !immutableReleasesEnabled(status.stdout ?? "")) {
        fail(
            `immutable releases are not enabled for ${repository}; enable ` +
            "release immutability before publishing");
    }
}

export function releaseAssetErrors(expectedAssets, remoteAssets) {
    const actual = new Map(remoteAssets.map((asset) => [asset.name, asset]));
    const errors = [];
    for (const expected of expectedAssets) {
        const remote = actual.get(expected.name);
        if (!remote) {
            errors.push(`missing remote asset: ${expected.name}`);
            continue;
        }
        if (remote.state !== "uploaded") {
            errors.push(
                `${expected.name}: expected uploaded state, found ${remote.state}`);
        }
        if (remote.size !== expected.size) {
            errors.push(
                `${expected.name}: expected ${expected.size} bytes, ` +
                `found ${remote.size}`);
        }
        if (remote.digest !== `sha256:${expected.sha256}`) {
            errors.push(
                `${expected.name}: expected sha256:${expected.sha256}, ` +
                `found ${remote.digest ?? "no digest"}`);
        }
    }
    for (const remote of remoteAssets) {
        if (!expectedAssets.some((expected) => expected.name === remote.name)) {
            errors.push(`unexpected remote asset: ${remote.name}`);
        }
    }
    return errors;
}

async function describeAssets(assetPaths) {
    return await Promise.all(assetPaths.map(async (file) => ({
        file,
        name: path.basename(file),
        size: (await stat(file)).size,
        sha256: await sha256(file),
    })));
}

function uploadAsset(repository, tag, token, asset) {
    run("gh", [
        "release", "upload", tag, asset.file, "--repo", repository,
    ], {
        inherit: true,
        env: {...process.env, GH_TOKEN: token},
    });
}

async function remoteAssets(repository, releaseId) {
    return JSON.parse(run("gh", [
        "api", `repos/${repository}/releases/${releaseId}/assets`,
    ]));
}

async function waitForVerifiedAssets(repository, releaseId, expected) {
    for (let attempt = 0; attempt < 60; ++attempt) {
        const actual = await remoteAssets(repository, releaseId);
        const errors = releaseAssetErrors(expected, actual);
        if (errors.length === 0) return actual;
        if (errors.some((error) =>
            error.startsWith("missing remote asset:") ||
            error.startsWith("unexpected remote asset:") ||
            /expected \d+ bytes/u.test(error))) {
            fail(`remote release asset mismatch:\n${errors.join("\n")}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const errors = releaseAssetErrors(
        expected, await remoteAssets(repository, releaseId));
    fail(`remote release assets did not finish qualification:\n${errors.join("\n")}`);
}

async function publish(configuration, flags, values) {
    const repository = values.get("--repository");
    if (!repository) fail("publish requires --repository OWNER/REPO");
    assertValidRepositoryName(repository);
    const release = await verify(configuration, values);
    const assetPaths = [];
    for (const artifact of release.verified) {
        assetPaths.push(path.join(release.artifactDirectory, artifact.file));
        assetPaths.push(path.join(release.artifactDirectory, artifact.checksumFile));
    }
    assetPaths.push(release.metadata.manifestPath);
    assetPaths.push(release.metadata.manifestChecksumPath);

    console.log(`release target: ${repository} ${release.tag}`);
    console.log("assets:");
    for (const asset of assetPaths) console.log(`  ${asset}`);
    if (!flags.has("--publish")) {
        console.log("dry run only; pass --publish to mutate GitHub");
        return;
    }

    if (!commandAvailable("gh", ["--version"])) fail("GitHub CLI is unavailable");
    run("gh", ["auth", "status"], {inherit: true});
    assertImmutableReleases(repository);
    assertCleanRepository();
    const targetCommit = run("git", ["rev-parse", "HEAD"]);
    const existing = JSON.parse(run("gh", [
        "api", `repos/${repository}/releases?per_page=100`,
    ])).find((candidate) => candidate.tag_name === release.tag);
    if (existing && (existing.draft !== true ||
        existing.immutable === true ||
        existing.target_commitish !== targetCommit)) {
        fail(`release already exists: ${repository} ${release.tag}`);
    }

    const releaseRecord = existing ?? JSON.parse(run("gh", [
        "api", "--method", "POST", `repos/${repository}/releases`,
        "-f", `tag_name=${release.tag}`,
        "-f", `target_commitish=${targetCommit}`,
        "-f", `name=${configuration.release.title}`,
        "-f", `body=${await readFile(release.metadata.notesPath, "utf8")}`,
        "-F", "draft=true",
    ]));
    try {
        const token = run("gh", ["auth", "token"]);
        const expectedAssets = await describeAssets(assetPaths);
        const presentAssets = await remoteAssets(repository, releaseRecord.id);
        const expectedByName = new Map(
            expectedAssets.map((asset) => [asset.name, asset]));
        for (const present of presentAssets) {
            const expected = expectedByName.get(present.name);
            if (!expected) {
                fail(`recoverable draft has unexpected asset: ${present.name}`);
            }
            const errors = releaseAssetErrors([expected], [present]);
            if (errors.length !== 0) {
                fail(
                    `recoverable draft has an invalid existing asset:\n` +
                    errors.join("\n"));
            }
        }
        const presentNames = new Set(presentAssets.map((asset) => asset.name));
        for (const asset of expectedAssets) {
            if (presentNames.has(asset.name)) continue;
            console.log(`uploading ${asset.name} (${asset.size} bytes)`);
            uploadAsset(repository, release.tag, token, asset);
        }
        await waitForVerifiedAssets(
            repository, releaseRecord.id, expectedAssets);
        const published = JSON.parse(run("gh", [
            "api", "--method", "PATCH",
            `repos/${repository}/releases/${releaseRecord.id}`,
            "-F", "draft=false",
        ]));
        if (published.draft !== false || published.immutable !== true) {
            fail("GitHub did not publish the release as immutable");
        }
    } catch (error) {
        fail(`assets were uploaded to a recoverable draft, but publication failed: ${error.message}`);
    }
    console.log(`published ${repository} ${release.tag}`);
}

function doctor() {
    const checks = [
        ["Node.js 20+", Number(process.versions.node.split(".")[0]) >= 20,
            process.version],
        ["git", commandAvailable("git"), "required for source identity"],
        ["tar", commandAvailable("tar", ["--version"]), "required to inspect archives"],
        ["gh", commandAvailable("gh", ["--version"]), "required only for publication"],
    ];
    let ready = true;
    for (const [name, available, detail] of checks) {
        console.log(`${available ? "ready" : "missing"}: ${name} (${detail})`);
        if (!available && name !== "gh") ready = false;
    }
    if (!ready) process.exitCode = 2;
}

async function main() {
    const {command, flags, values} = parseArguments(process.argv.slice(2));
    if (["help", "--help", "-h"].includes(command)) {
        usage();
        return;
    }
    const configuration = await readConfiguration();
    if (command === "doctor") {
        doctor();
        return;
    }
    if (command === "verify") {
        if (flags.size) fail("verify does not accept flags");
        await verify(configuration, values);
        return;
    }
    if (command === "publish") {
        await publish(configuration, flags, values);
        return;
    }
    fail(`unknown command: ${command}`);
}

const isMain = process.argv[1] &&
    path.resolve(process.argv[1]) === path.resolve(scriptPath);
if (isMain) {
    main().catch((error) => {
        console.error(`error: ${error.message}`);
        process.exitCode = 1;
    });
}
