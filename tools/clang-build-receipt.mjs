import {canonicalJson, sha256Bytes} from "./build-receipt.mjs";
import {canonicalProfileIdentity} from "./toolchain-set.mjs";

export const clangToolsVersion = "p2996-0ac75f2f";
export const clangToolsPackageRevision = "move.1";
export const clangSourceDateEpoch = 1787196636;
export const clangSourceIdentity = Object.freeze({
    repository: "https://github.com/move-engine/clang-p2996.git",
    revision: "0ac75f2f9a8648feaa404e6b68513ce7d4121ece",
    upstreamBaseRevision: "7220baffd57ea5b0f8cf59bee494dd5b7cc2b748",
    patchRevisions: Object.freeze([
        "0ac75f2f9a8648feaa404e6b68513ce7d4121ece",
    ]),
});

export function clangQualificationCases() {
    return [
        "clang-version",
        "clangxx-version",
        "clangd-version",
        "reflection-feature",
        "nez-compilation-database",
        "resource-headers",
        "staged-prefix-independence",
        "runtime-closure",
    ].map((id) => ({id, status: "passed"}));
}

export function clangConfigureArguments(configuration) {
    const result = [
        "cmake", "-S", "@source@/llvm", "-B", "@build@", "-G",
        configuration.generator,
        `-DCMAKE_BUILD_TYPE=${configuration.buildType}`,
        "-DCMAKE_INSTALL_PREFIX=@install@",
        `-DLLVM_ENABLE_PROJECTS=${configuration.projects}`,
        `-DLLVM_ENABLE_RUNTIMES=${configuration.runtimes}`,
        `-DLLVM_TARGETS_TO_BUILD=${configuration.targets}`,
        "-DCLANG_DEFAULT_CXX_STDLIB=libc++",
        "-DLLVM_INCLUDE_TESTS=OFF",
        "-DLLVM_INCLUDE_BENCHMARKS=OFF",
        "-DLLVM_INCLUDE_EXAMPLES=OFF",
        "-DLLVM_ENABLE_ZLIB=OFF",
        "-DLLVM_ENABLE_ZSTD=OFF",
        "-DLLVM_ENABLE_LIBXML2=OFF",
        "-DLLVM_ENABLE_CURL=OFF",
    ];
    if (configuration.cFlags) {
        result.push(`-DCMAKE_C_FLAGS=${configuration.cFlags}`);
    }
    if (configuration.cxxFlags) {
        result.push(`-DCMAKE_CXX_FLAGS=${configuration.cxxFlags}`);
    }
    if (configuration.linkerFlags) {
        for (const kind of ["EXE", "SHARED", "MODULE"]) {
            result.push(`-DCMAKE_${kind}_LINKER_FLAGS=${configuration.linkerFlags}`);
        }
    }
    if (configuration.staticLinkCxxStdlib === true) {
        result.push("-DLLVM_STATIC_LINK_CXX_STDLIB=ON");
    }
    return result;
}

export function clangReceiptInput(options) {
    const profile = canonicalProfileIdentity(options.profile);
    const derivation = {
        profile: options.profile,
        source: clangSourceIdentity,
        sourceDateEpoch: clangSourceDateEpoch,
        buildEnvironment: options.builderIdentity,
        configuration: options.configuration,
        installTargets: options.installTargets,
    };
    return {
        component: "clangTools",
        componentVersion: clangToolsVersion,
        packageRevision: clangToolsPackageRevision,
        manifestDigest: sha256Bytes(canonicalJson(derivation)),
        profile: options.profile,
        source: {...clangSourceIdentity,
            patchRevisions: [...clangSourceIdentity.patchRevisions]},
        sourceDateEpoch: clangSourceDateEpoch,
        schemas: {manifest: 2, qualification: 1, package: 1},
        build: {
            triples: {
                build: profile.buildTriple,
                host: profile.hostTriple,
                target: profile.targetTriple,
            },
            configure: clangConfigureArguments(options.configuration),
            bootstrap: {
                identity: options.builderIdentity,
                observedVersion: options.bootstrapVersion,
            },
            buildCommands: [["cmake", "--build", "@build@", "--parallel"]],
            installCommands: [["cmake", "--build", "@build@", "--target",
                ...options.installTargets]],
        },
        environment: {
            builderIdentity: options.builderIdentity,
            runtimeIdentity: {...profile.runtime},
            targetCpuBaseline: profile.targetCpuBaseline,
            variables: {...options.environment},
        },
        dependencies: [{
            id: "clang-p2996-source",
            kind: "git",
            source: clangSourceIdentity.repository,
            version: clangSourceIdentity.revision.slice(0, 8),
            revision: clangSourceIdentity.revision,
            tree: options.sourceTree,
        }],
        qualification: {
            schemaVersion: 1,
            cases: clangQualificationCases(),
        },
    };
}
