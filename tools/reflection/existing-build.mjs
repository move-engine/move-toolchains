import path from "node:path";

export function parseCmakeCache(contents) {
    const entries = new Map();
    for (const line of contents.split(/\r?\n/u)) {
        if (line === "" || line.startsWith("#") || line.startsWith("//")) {
            continue;
        }
        const match = /^([^:=]+):[^=]*=(.*)$/u.exec(line);
        if (match) entries.set(match[1], match[2]);
    }
    return entries;
}

function samePath(left, right, platform) {
    const pathImplementation = platform === "win32" ? path.win32 : path.posix;
    const normalize = (value) =>
        pathImplementation.resolve(value).replaceAll("\\", "/");
    const actual = normalize(left);
    const expected = normalize(right);
    return platform === "win32"
        ? actual.toLowerCase() === expected.toLowerCase()
        : actual === expected;
}

export function sameRepository(left, right) {
    const canonical = (value) => {
        const githubSsh = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/iu
            .exec(value);
        const githubHttps = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/iu
            .exec(value);
        const githubPath = githubSsh?.[1] ?? githubHttps?.[1];
        return githubPath
            ? `github.com/${githubPath.replace(/\.git$/iu, "").toLowerCase()}`
            : value;
    };
    return canonical(left) === canonical(right);
}

export function existingBuildCacheErrors(
    profile, source, contents, platform = process.platform) {
    const cache = parseCmakeCache(contents);
    const configuration = profile.configuration;
    const expected = new Map([
        ["CMAKE_BUILD_TYPE", configuration.buildType],
        ["CMAKE_GENERATOR", configuration.generator],
        ["LLVM_ENABLE_PROJECTS", configuration.projects],
        ["LLVM_ENABLE_RUNTIMES", configuration.runtimes],
        ["LLVM_TARGETS_TO_BUILD", configuration.targets],
    ]);
    if (configuration.cFlags) {
        expected.set("CMAKE_C_FLAGS", configuration.cFlags);
    }
    if (configuration.cxxFlags) {
        expected.set("CMAKE_CXX_FLAGS", configuration.cxxFlags);
    }
    if (configuration.linkerFlags) {
        expected.set("CMAKE_EXE_LINKER_FLAGS", configuration.linkerFlags);
        expected.set("CMAKE_SHARED_LINKER_FLAGS", configuration.linkerFlags);
        expected.set("CMAKE_MODULE_LINKER_FLAGS", configuration.linkerFlags);
    }
    if (configuration.staticLinkCxxStdlib === true) {
        expected.set("LLVM_STATIC_LINK_CXX_STDLIB", "ON");
    }
    const errors = [];
    for (const [name, value] of expected) {
        if (cache.get(name) !== value) {
            errors.push(
                `${name}: expected ${JSON.stringify(value)}, found ` +
                JSON.stringify(cache.get(name)));
        }
    }
    const cachedSource = cache.get("CMAKE_HOME_DIRECTORY");
    const expectedSource = path.join(source, "llvm");
    if (!cachedSource || !samePath(cachedSource, expectedSource, platform)) {
        errors.push(
            `CMAKE_HOME_DIRECTORY: expected ${JSON.stringify(expectedSource)}, ` +
            `found ${JSON.stringify(cachedSource)}`);
    }
    return errors;
}
