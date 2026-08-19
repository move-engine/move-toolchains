import process from "node:process";

const versionPattern = /^\d+(?:\.\d+)*$/;

export function compareVersions(left, right) {
    if (!versionPattern.test(left ?? "") || !versionPattern.test(right ?? "")) {
        throw new Error(`invalid dotted version comparison: ${left} and ${right}`);
    }
    const a = left.split(".").map(Number);
    const b = right.split(".").map(Number);
    for (let index = 0; index < Math.max(a.length, b.length); ++index) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);
        if (difference !== 0) return difference;
    }
    return 0;
}

export function detectLinuxLibc(report = process.report?.getReport?.()) {
    const runtime = report?.header?.glibcVersionRuntime;
    if (versionPattern.test(runtime ?? "")) {
        return {family: "glibc", version: runtime};
    }
    const sharedObjects = Array.isArray(report?.sharedObjects)
        ? report.sharedObjects : [];
    if (sharedObjects.some((entry) => /(?:^|[/\\])(?:ld-)?musl[^/\\]*\.so/i.test(entry))) {
        return {family: "musl", version: null};
    }
    return {family: "unknown", version: null};
}

function componentPrefix(component) {
    if (component === "clangd") return "clang-p2996-";
    if (component === "gcc") return "gcc-";
    throw new Error(`unsupported toolchain component: ${component}`);
}

function artifactMatchesNonLinuxHost(artifact, host) {
    if (host === "win32-x64") return artifact.host.startsWith("windows-x86_64");
    if (host === "darwin-x64") return artifact.host.startsWith("macos-x86_64");
    if (host === "darwin-arm64") return artifact.host.startsWith("macos-arm64");
    return false;
}

export function selectCompatibleArtifact(artifacts, component, host, libc = null) {
    const prefix = componentPrefix(component);
    const componentArtifacts = (artifacts ?? []).filter(
        (artifact) => artifact.id?.startsWith(prefix));
    if (host !== "linux-x64") {
        return componentArtifacts.find(
            (artifact) => artifactMatchesNonLinuxHost(artifact, host)) ?? null;
    }
    if (libc?.family !== "glibc" || !versionPattern.test(libc.version ?? "")) {
        return null;
    }
    return componentArtifacts
        .filter((artifact) => artifact.host?.startsWith("linux-x86_64"))
        .filter((artifact) => versionPattern.test(
            artifact.requirements?.minimumGlibc ?? ""))
        .filter((artifact) => compareVersions(
            artifact.requirements.minimumGlibc, libc.version) <= 0)
        .sort((left, right) => {
            const floorOrder = compareVersions(
                right.requirements.minimumGlibc,
                left.requirements.minimumGlibc);
            return floorOrder || left.id.localeCompare(right.id);
        })[0] ?? null;
}

export function unsupportedLinuxMessage(libc, component = "clangd") {
    if (libc?.family === "musl") {
        return `no ${component} prebuilt is available for musl Linux`;
    }
    if (libc?.family !== "glibc" || !libc.version) {
        return `Linux libc could not be identified; ${component} prebuilt selection is unsupported`;
    }
    return `no ${component} prebuilt supports glibc ${libc.version}`;
}

export function sourceBuildAlternative(message) {
    return `${message}. No source build was started. To build the pinned ` +
        "toolchain explicitly, provide at least 80 GiB of free space and run " +
        "`npm start -- build clangd --jobs N`.";
}
