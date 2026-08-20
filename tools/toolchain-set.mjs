import {compareVersions} from "./host-compatibility.mjs";

export const supportedProfileIds = Object.freeze([
    "windows-x86_64-ucrt64",
    "linux-x86_64-glibc2.38",
    "linux-x86_64-glibc2.35",
]);

const componentNames = Object.freeze(["gcc", "clangTools"]);
const dottedVersionPattern = /^\d+(?:\.\d+)*$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const fullRevisionPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const canonicalProfiles = Object.freeze({
    "windows-x86_64-ucrt64": Object.freeze({
        platform: "windows",
        architecture: "x86_64",
        runtime: Object.freeze({family: "ucrt"}),
        buildTriple: "x86_64-w64-mingw32",
        hostTriple: "x86_64-w64-mingw32",
        targetTriple: "x86_64-w64-mingw32",
        targetCpuBaseline: "x86-64",
    }),
    "linux-x86_64-glibc2.38": Object.freeze({
        platform: "linux",
        architecture: "x86_64",
        runtime: Object.freeze({family: "glibc", minimumVersion: "2.38"}),
        buildTriple: "x86_64-pc-linux-gnu",
        hostTriple: "x86_64-pc-linux-gnu",
        targetTriple: "x86_64-pc-linux-gnu",
        targetCpuBaseline: "x86-64",
    }),
    "linux-x86_64-glibc2.35": Object.freeze({
        platform: "linux",
        architecture: "x86_64",
        runtime: Object.freeze({family: "glibc", minimumVersion: "2.35"}),
        buildTriple: "x86_64-pc-linux-gnu",
        hostTriple: "x86_64-pc-linux-gnu",
        targetTriple: "x86_64-pc-linux-gnu",
        targetCpuBaseline: "x86-64",
    }),
});

export function canonicalProfileIdentity(id) {
    const profile = canonicalProfiles[id];
    if (!profile) fail(`unsupported profile: ${id}`);
    return profile;
}

function fail(message) {
    throw new Error(message);
}

function requireObject(value, description) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail(`${description} must be an object`);
    }
    return value;
}

function requireString(value, description) {
    if (typeof value !== "string" || !value.trim()) {
        fail(`${description} must be a nonempty string`);
    }
    return value;
}

function validateProfile(id, profile) {
    requireObject(profile, `profile ${id}`);
    if (!supportedProfileIds.includes(id)) fail(`unsupported profile: ${id}`);
    const expected = canonicalProfiles[id];
    const runtime = requireObject(profile.runtime, `profile ${id} runtime`);
    if (profile.platform !== expected.platform ||
        profile.architecture !== expected.architecture ||
        runtime.family !== expected.runtime.family ||
        runtime.minimumVersion !== expected.runtime.minimumVersion) {
        fail(`profile ${id} does not match its canonical runtime identity`);
    }
}

function validateComponent(id, component) {
    requireObject(component, `component ${id}`);
    requireString(component.version, `component ${id} version`);
    requireString(component.packageRevision, `component ${id} package revision`);
    const source = requireObject(component.source, `component ${id} source`);
    requireString(source.repository, `component ${id} source repository`);
    for (const field of ["revision", "upstreamBaseRevision"]) {
        if (!fullRevisionPattern.test(source[field] ?? "")) {
            fail(`component ${id} has invalid source ${field}`);
        }
    }
    if (!Array.isArray(source.patchRevisions) ||
        source.patchRevisions.some(
            (revision) => !fullRevisionPattern.test(revision ?? "")) ||
        (id === "gcc" && source.patchRevisions.length === 0)) {
        fail(`component ${id} has an invalid ordered patch stack`);
    }
}

function safeArchivePath(value, description, allowPath = false) {
    const candidate = requireString(value, description).replaceAll("\\", "/");
    if (candidate.startsWith("/") || /^[A-Za-z]:\//.test(candidate) ||
        candidate.split("/").includes("..") ||
        (!allowPath && candidate.includes("/"))) {
        fail(`${description} is not a safe relative archive path`);
    }
    return candidate;
}

function validateResolvedArtifact(artifact, id) {
    const file = safeArchivePath(artifact.file, `artifact ${id} file`);
    if (!(/\.(?:zip|tar\.gz)$/.test(file))) {
        fail(`artifact ${id} has an unsupported archive extension`);
    }
    if (safeArchivePath(
        artifact.checksumFile, `artifact ${id} checksum file`) !== `${file}.sha256`) {
        fail(`artifact ${id} checksum file does not match its archive`);
    }
    safeArchivePath(artifact.archiveRoot, `artifact ${id} archive root`, true);
    if (!sha256Pattern.test(artifact.sha256 ?? "") ||
        !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1) {
        fail(`artifact ${id} has invalid archive identity`);
    }
    const derivation = requireObject(
        artifact.derivation, `artifact ${id} derivation`);
    for (const field of ["sourceRevision", "upstreamBaseRevision"]) {
        if (!fullRevisionPattern.test(derivation[field] ?? "")) {
            fail(`artifact ${id} has invalid ${field}`);
        }
    }
    if (!Array.isArray(derivation.patchRevisions) ||
        derivation.patchRevisions.some(
            (revision) => !fullRevisionPattern.test(revision ?? "")) ||
        !sha256Pattern.test(derivation.configurationDigest ?? "")) {
        fail(`artifact ${id} has invalid derivation identity`);
    }
    const receipt = requireObject(artifact.receipt, `artifact ${id} receipt`);
    if (receipt.schemaVersion !== 1 || receipt.file !== "move-build-receipt.json" ||
        !sha256Pattern.test(receipt.sha256 ?? "") ||
        !sha256Pattern.test(receipt.installedTreeDigest ?? "")) {
        fail(`artifact ${id} has invalid receipt identity`);
    }
    return file;
}

export function validateToolchainManifest(configuration) {
    requireObject(configuration, "toolchain manifest");
    if (configuration.schemaVersion !== 2) {
        fail(`unsupported toolchain manifest schema: ${configuration.schemaVersion}`);
    }
    const profiles = requireObject(configuration.profiles, "profiles");
    for (const id of supportedProfileIds) {
        if (!profiles[id]) fail(`required profile is absent: ${id}`);
    }
    for (const [id, profile] of Object.entries(profiles)) {
        validateProfile(id, profile);
    }
    const components = requireObject(configuration.components, "components");
    for (const component of componentNames) {
        if (!components[component]) fail(`required component is absent: ${component}`);
        validateComponent(component, components[component]);
    }
    for (const component of Object.keys(components)) {
        if (!componentNames.includes(component)) {
            fail(`unsupported component declaration: ${component}`);
        }
    }

    if (!Array.isArray(configuration.artifacts)) fail("artifacts must be an array");
    const artifacts = new Map();
    const files = new Set();
    const artifactSlots = new Set();
    for (const artifact of configuration.artifacts) {
        requireObject(artifact, "artifact");
        const id = requireString(artifact.id, "artifact id");
        if (artifacts.has(id)) fail(`duplicate artifact id: ${id}`);
        const component = requireString(
            artifact.component, `artifact ${id} component`);
        if (!componentNames.includes(component)) {
            fail(`artifact ${id} has an unsupported component: ${component}`);
        }
        const profile = requireString(artifact.profile, `artifact ${id} profile`);
        if (!profiles[profile]) fail(`artifact ${id} references unknown profile ${profile}`);
        const slot = `${profile}:${component}`;
        if (artifactSlots.has(slot)) fail(`duplicate artifact slot: ${slot}`);
        artifactSlots.add(slot);
        const file = validateResolvedArtifact(artifact, id);
        const source = components[component].source;
        const derivation = artifact.derivation;
        if (derivation.sourceRevision !== source.revision ||
            derivation.upstreamBaseRevision !== source.upstreamBaseRevision ||
            JSON.stringify(derivation.patchRevisions) !==
                JSON.stringify(source.patchRevisions)) {
            fail(`artifact ${id} disagrees with the shared ${component} source identity`);
        }
        if (files.has(file)) fail(`duplicate artifact file: ${file}`);
        files.add(file);
        artifacts.set(id, artifact);
    }
    for (const profile of supportedProfileIds) {
        for (const component of componentNames) {
            if (!artifactSlots.has(`${profile}:${component}`)) {
                fail(`required artifact is absent: ${profile}:${component}`);
            }
        }
    }

    if (!Array.isArray(configuration.toolchainSets)) {
        fail("toolchainSets must be an array");
    }
    const sets = new Set();
    const profileSets = new Set();
    for (const toolchainSet of configuration.toolchainSets) {
        requireObject(toolchainSet, "toolchain set");
        const id = requireString(toolchainSet.id, "toolchain set id");
        if (sets.has(id)) fail(`duplicate toolchain set id: ${id}`);
        sets.add(id);
        const profile = requireString(
            toolchainSet.profile, `toolchain set ${id} profile`);
        if (!profiles[profile]) {
            fail(`toolchain set ${id} references unknown profile ${profile}`);
        }
        if (profileSets.has(profile)) {
            fail(`multiple toolchain sets declare profile ${profile}`);
        }
        profileSets.add(profile);
        const components = requireObject(
            toolchainSet.components, `toolchain set ${id} components`);
        for (const component of componentNames) {
            const artifactId = requireString(
                components[component], `toolchain set ${id} ${component}`);
            const artifact = artifacts.get(artifactId);
            if (!artifact) {
                fail(`toolchain set ${id} references unknown artifact ${artifactId}`);
            }
            if (artifact.component !== component) {
                fail(`toolchain set ${id} maps ${component} to ${artifact.component}`);
            }
            if (artifact.profile !== profile) {
                fail(`toolchain set ${id} mixes ${artifact.profile} into ${profile}`);
            }
        }
    }
    for (const profile of supportedProfileIds) {
        if (!profileSets.has(profile)) {
            fail(`required toolchain set is absent: ${profile}`);
        }
    }
    return configuration;
}

function compatibleWithRuntime(profile, host, libc) {
    if (host === "win32-x64") {
        return profile.platform === "windows" &&
            profile.architecture === "x86_64" && profile.runtime.family === "ucrt";
    }
    if (host !== "linux-x64" || libc?.family !== "glibc" ||
        !dottedVersionPattern.test(libc.version ?? "")) {
        return false;
    }
    return profile.platform === "linux" && profile.architecture === "x86_64" &&
        profile.runtime.family === "glibc" && compareVersions(
            profile.runtime.minimumVersion, libc.version) <= 0;
}

export function selectCompatibleToolchainSet(
    configuration, host, libc = null) {
    validateToolchainManifest(configuration);
    return configuration.toolchainSets
        .filter((toolchainSet) => compatibleWithRuntime(
            configuration.profiles[toolchainSet.profile], host, libc))
        .sort((left, right) => {
            if (host !== "linux-x64") return left.id.localeCompare(right.id);
            const leftFloor = configuration.profiles[left.profile]
                .runtime.minimumVersion;
            const rightFloor = configuration.profiles[right.profile]
                .runtime.minimumVersion;
            return compareVersions(rightFloor, leftFloor) ||
                left.id.localeCompare(right.id);
        })[0] ?? null;
}
