import {readFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {canonicalJson, sha256Bytes} from "./build-receipt.mjs";
import {loadBuilderLock} from "./msys2-builder-lock.mjs";
import {canonicalProfileIdentity} from "./toolchain-set.mjs";

export const gccRecipeSchemaVersion = 1;
export const windowsGccOperationIds = Object.freeze([
    "materialize-builder.initialize-logical-roots",
    "materialize-builder.materialize-msys2-builder",
    "materialize-sources.gcc",
    "materialize-sources.msys2-gcc-recipes",
    "populate-sysroot.extract-locked-packages",
    "prepare-gcc.apply-exact-patch-set",
    "prepare-gcc.autoreconf",
    "configure-gcc.configure",
    "build-gcc.profiledbootstrap",
    "install-gcc.install",
    "install-gcc.normalize-portable-prefix",
    "install-gcc.verify-final-runtime-closure",
]);

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fullRevisionPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const windowsPhaseIds = Object.freeze([
    "materialize-builder", "materialize-sources", "populate-sysroot",
    "prepare-gcc", "configure-gcc", "build-gcc", "install-gcc",
]);
const windowsPhaseShape = Object.freeze({
    "materialize-builder": Object.freeze({
        cwd: "@build-root@", kinds: Object.freeze([
            "initialize-logical-roots", "materialize-msys2-builder",
        ]),
    }),
    "materialize-sources": Object.freeze({
        cwd: "@workspace@", kinds: Object.freeze(["materialize-git", "materialize-git"]),
    }),
    "populate-sysroot": Object.freeze({
        cwd: "@workspace@", kinds: Object.freeze(["extract-locked-packages"]),
    }),
    "prepare-gcc": Object.freeze({
        cwd: "@source@", kinds: Object.freeze(["apply-exact-patch-set", "autoreconf"]),
    }),
    "configure-gcc": Object.freeze({
        cwd: "@build@/gcc", kinds: Object.freeze(["configure"]),
    }),
    "build-gcc": Object.freeze({
        cwd: "@build@/gcc", kinds: Object.freeze(["make"]),
    }),
    "install-gcc": Object.freeze({
        cwd: "@build@/gcc", kinds: Object.freeze([
            "make", "normalize-portable-prefix", "verify-final-runtime-closure",
        ]),
    }),
});
const requiredWindowsGccArguments = Object.freeze([
    "--prefix=@install@", "--build=x86_64-w64-mingw32",
    "--host=x86_64-w64-mingw32", "--target=x86_64-w64-mingw32",
    "--with-sysroot=@sysroot@", "--with-build-sysroot=@sysroot-windows@",
    "--with-local-prefix=/local", "--with-native-system-header-dir=/include",
    "--libexecdir=@install@/lib", "--enable-bootstrap",
    "--enable-checking=release", "--with-arch=x86-64", "--with-tune=generic",
    "--enable-languages=c,c++,lto", "--enable-lto", "--enable-shared",
    "--enable-static", "--enable-libatomic", "--enable-threads=posix",
    "--enable-tls", "--enable-graphite", "--enable-libstdcxx-backtrace=yes",
    "--enable-libstdcxx-filesystem-ts", "--enable-libstdcxx-time",
    "--disable-libstdcxx-pch", "--enable-libgomp", "--disable-libssp",
    "--disable-multilib", "--disable-rpath", "--disable-win32-registry",
    "--disable-nls", "--disable-werror", "--disable-symvers", "--with-gnu-as",
    "--with-gnu-ld", "--with-libstdcxx-zoneinfo=yes",
    "--with-boot-ldflags=-static-libstdc++",
    "--with-stage1-ldflags=-static-libstdc++",
]);
const requiredWindowsPayloadPackages = Object.freeze([
    "mingw-w64-ucrt-x86_64-binutils",
    "mingw-w64-ucrt-x86_64-crt",
    "mingw-w64-ucrt-x86_64-gettext-runtime",
    "mingw-w64-ucrt-x86_64-gmp",
    "mingw-w64-ucrt-x86_64-headers",
    "mingw-w64-ucrt-x86_64-isl",
    "mingw-w64-ucrt-x86_64-libiconv",
    "mingw-w64-ucrt-x86_64-libwinpthread",
    "mingw-w64-ucrt-x86_64-mpc",
    "mingw-w64-ucrt-x86_64-mpfr",
    "mingw-w64-ucrt-x86_64-tzdata",
    "mingw-w64-ucrt-x86_64-windows-default-manifest",
    "mingw-w64-ucrt-x86_64-winpthreads",
    "mingw-w64-ucrt-x86_64-zlib",
    "mingw-w64-ucrt-x86_64-zstd",
]);
const requiredWindowsBootstrapRuntimePackages = Object.freeze([
    "mingw-w64-ucrt-x86_64-gcc-libs",
]);
const requiredWindowsGeneratedProvides = Object.freeze([
    "mingw-w64-ucrt-x86_64-cc-libs",
]);
const requiredWindowsGeneratedRuntimeFiles = Object.freeze([
    "bin/libatomic-1.dll", "bin/libgcc_s_seh-1.dll", "bin/libgomp-1.dll",
    "bin/libstdc++-6.dll",
]);

function fail(message) { throw new Error(message); }
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
function safeRelativePath(value, description) {
    const candidate = requireString(value, description);
    if (candidate.includes("\\") || candidate.startsWith("/") ||
        /^[A-Za-z]:/.test(candidate) || candidate.endsWith("/") ||
        candidate.split("/").some((part) => !part || part === "." || part === "..")) {
        fail(`${description} is not a normalized safe relative path`);
    }
    return candidate;
}
function validateChecksum(checksum, description) {
    requireObject(checksum, description);
    const pattern = checksum.algorithm === "sha256" ? sha256Pattern
        : checksum.algorithm === "sha512" ? /^[0-9a-f]{128}$/ : null;
    if (!pattern?.test(checksum.digest ?? "")) {
        fail(`${description} is not a supported exact digest`);
    }
}
function validateDependency(dependency, ids) {
    requireObject(dependency, "GCC recipe dependency");
    const id = requireString(dependency.id, "GCC recipe dependency id");
    if (ids.has(id)) fail(`duplicate GCC recipe dependency: ${id}`);
    ids.add(id);
    requireString(dependency.source, `dependency ${id} source`);
    requireString(dependency.version, `dependency ${id} version`);
    if (dependency.kind === "archive") {
        safeRelativePath(dependency.file, `dependency ${id} file`);
        validateChecksum(dependency.checksum, `dependency ${id} checksum`);
        if (dependency.signature !== undefined) {
            const signature = requireObject(
                dependency.signature, `dependency ${id} signature`);
            safeRelativePath(signature.file, `dependency ${id} signature file`);
            validateChecksum(signature.checksum, `dependency ${id} signature checksum`);
            if (!Array.isArray(signature.signerFingerprints) ||
                signature.signerFingerprints.length === 0 ||
                signature.signerFingerprints.some(
                    (fingerprint) => !/^[0-9A-F]{40}$/.test(fingerprint ?? ""))) {
                fail(`dependency ${id} signature lacks exact signer fingerprints`);
            }
        }
    } else if (dependency.kind === "git") {
        if (!fullRevisionPattern.test(dependency.revision ?? "") ||
            !fullRevisionPattern.test(dependency.tree ?? "")) {
            fail(`dependency ${id} lacks exact Git revision and tree identity`);
        }
    } else {
        fail(`dependency ${id} has unsupported kind`);
    }
}
function validateArguments(values, description) {
    if (!Array.isArray(values) || values.length === 0 ||
        values.some((value) => typeof value !== "string" || !value)) {
        fail(`${description} must be a nonempty string array`);
    }
}
function configureOptionKey(argument) {
    const match = /^--(enable|disable|with|without)-([^=]+)(?:=.*)?$/.exec(argument);
    if (!match) return argument;
    const family = ["enable", "disable"].includes(match[1]) ? "feature" : "path";
    return `${family}:${match[2]}`;
}
function validateWindowsConfigure(values) {
    validateArguments(values, "Windows GCC configure arguments");
    const options = new Map();
    for (const argument of values) {
        const key = configureOptionKey(argument);
        if (options.has(key)) fail(`duplicate or conflicting GCC configure option: ${key}`);
        options.set(key, argument);
    }
    for (const required of requiredWindowsGccArguments) {
        if (options.get(configureOptionKey(required)) !== required) {
            fail(`required Windows GCC configure option is absent or changed: ${required}`);
        }
    }
}
function validateBuilder(builder) {
    requireObject(builder, "Windows GCC builder");
    if (builder.kind !== "msys2-ucrt64") {
        fail("Windows GCC recipe requires the MSYS2 UCRT64 builder");
    }
    const lock = requireObject(builder.lock, "Windows GCC builder lock");
    if (lock.id !== "msys2-ucrt64-20260820" ||
        safeRelativePath(lock.file, "Windows GCC builder lock file") !==
            "recipes/builders/msys2-ucrt64-20260820.json" ||
        !sha256Pattern.test(lock.sha256 ?? "")) {
        fail("Windows GCC builder lock identity is invalid");
    }
    if (!Array.isArray(builder.payloadPackages) || builder.payloadPackages.length === 0) {
        fail("Windows GCC builder payload packages are absent");
    }
    const packages = new Set();
    for (const name of builder.payloadPackages) {
        requireString(name, "Windows GCC payload package");
        if (packages.has(name)) fail(`duplicate Windows payload package: ${name}`);
        packages.add(name);
    }
    if (packages.has("mingw-w64-ucrt-x86_64-gcc") ||
        packages.has("mingw-w64-ucrt-x86_64-gcc-libs")) {
        fail("Windows payload must not include the bootstrap GCC implementation");
    }
    if (canonicalJson(builder.payloadPackages) !==
        canonicalJson(requiredWindowsPayloadPackages)) {
        fail("Windows GCC payload package set is incomplete or changed");
    }
    if (builder.shell !== "@builder@/usr/bin/bash.exe" ||
        canonicalJson(builder.bootstrapRuntimePackages) !==
            canonicalJson(requiredWindowsBootstrapRuntimePackages) ||
        canonicalJson(builder.generatedProvides) !==
            canonicalJson(requiredWindowsGeneratedProvides) ||
        canonicalJson(builder.generatedRuntimeFiles) !==
            canonicalJson(requiredWindowsGeneratedRuntimeFiles)) {
        fail("Windows GCC bootstrap runtime transition is incomplete or changed");
    }
}
function validatePatch(value, index, dependencies) {
    const patch = requireObject(value, `Windows GCC patch ${index}`);
    if (patch.target !== "gcc" || patch.applyRoot !== "@source@" ||
        patch.strip !== 1 || !fullRevisionPattern.test(patch.blob ?? "")) {
        fail(`Windows GCC patch ${index} has invalid provenance or application identity`);
    }
    const patchPath = safeRelativePath(
        patch.path, `Windows GCC patch ${index} path`);
    const external = patch.sourceDependency === "msys2-gcc-recipes" &&
        dependencies.has(patch.sourceDependency) &&
        /^mingw-w64-gcc\/[A-Za-z0-9._-]+\.patch$/.test(patchPath);
    const local = patch.sourceDependency === "move-toolchains" &&
        /^patches\/gcc\/[A-Za-z0-9._-]+\.patch$/.test(patchPath);
    if (!external && !local) {
        fail(`Windows GCC patch ${index} is outside the pinned GCC recipe`);
    }
}
function validateRoots(roots) {
    const expected = {
        build: "@workspace@/build", builder: "@workspace@/builder",
        dependencies: "@workspace@/dependencies", install: "@workspace@/install",
        source: "@workspace@/source/gcc", sysroot: "@install@",
        sysrootWindows: "@windows-path:@sysroot@",
        workspace: "@build-root@/windows-x86_64-ucrt64/@derivation-digest@",
    };
    if (canonicalJson(requireObject(roots, "Windows GCC logical roots")) !==
        canonicalJson(expected)) fail("Windows GCC logical roots are incomplete or changed");
}
function validateEnvironment(environment) {
    const expected = {
        CC: "@builder@/ucrt64/bin/gcc.exe",
        CPPFLAGS: "-DCOM_NO_WINDOWS_H",
        CXX: "@builder@/ucrt64/bin/g++.exe",
        LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
        PATH: "@install@/bin:@builder@/ucrt64/bin:@builder@/usr/bin",
        SOURCE_DATE_EPOCH: "@source-date-epoch@", gcc_cv_have_tls: "yes",
        glibcxx_cv_atomic_word: "yes", lt_cv_deplibs_check_method: "pass_all",
    };
    if (canonicalJson(requireObject(environment, "Windows GCC environment")) !==
        canonicalJson(expected)) fail("Windows GCC build environment is incomplete or changed");
}
function validateEnvironmentPolicy(policy) {
    const expected = {
        inherit: ["SystemRoot", "TEMP", "TMP"],
        mode: "allowlist-plus-recipe",
        values: "profile.environment",
    };
    if (canonicalJson(requireObject(policy, "Windows GCC environment policy")) !==
        canonicalJson(expected)) {
        fail("Windows GCC environment inheritance policy is incomplete or changed");
    }
}
function validatePhases(phases) {
    if (!Array.isArray(phases) || phases.length !== windowsPhaseIds.length) {
        fail("Windows GCC ordered phase graph is incomplete");
    }
    for (const [index, phase] of phases.entries()) {
        requireObject(phase, `Windows GCC phase ${index}`);
        if (phase.id !== windowsPhaseIds[index]) {
            fail(`Windows GCC phase ${index} must be ${windowsPhaseIds[index]}`);
        }
        const shape = windowsPhaseShape[phase.id];
        if (requireString(phase.cwd, `Windows GCC phase ${phase.id} cwd`) !==
            shape.cwd) {
            fail(`Windows GCC phase ${phase.id} has an unexpected cwd`);
        }
        if (!Array.isArray(phase.operations) || phase.operations.length === 0) {
            fail(`Windows GCC phase ${phase.id} has no operations`);
        }
        phase.operations.forEach((operation, operationIndex) => {
            requireObject(operation,
                `Windows GCC phase ${phase.id} operation ${operationIndex}`);
            requireString(operation.kind,
                `Windows GCC phase ${phase.id} operation ${operationIndex} kind`);
            requireString(operation.id,
                `Windows GCC phase ${phase.id} operation ${operationIndex} id`);
        });
        if (canonicalJson(phase.operations.map((operation) => operation.kind)) !==
            canonicalJson(shape.kinds)) {
            fail(`Windows GCC phase ${phase.id} operations are incomplete or changed`);
        }
    }
    if (canonicalJson(phases.flatMap((phase) =>
        phase.operations.map((operation) => operation.id))) !==
        canonicalJson(windowsGccOperationIds)) {
        fail("Windows GCC operation identities are incomplete or changed");
    }
    const initialize = phases[0].operations[0];
    if (initialize.derivationIdentity !== "@derivation-digest@" ||
        canonicalJson(initialize.containers) !== canonicalJson([
            "@workspace@", "@dependencies@",
        ]) || canonicalJson(initialize.exactReuse) !== canonicalJson([
            "@build@/gcc",
        ]) || canonicalJson(initialize.fresh) !== canonicalJson([
            "@install@",
        ]) || canonicalJson(initialize.materialized) !== canonicalJson([
            "@builder@", "@source@",
        ])) {
        fail("Windows GCC logical-root initialization is incomplete or changed");
    }
    const materializeBuilder = phases[0].operations[1];
    if (materializeBuilder.lock !== "profile.builder.lock" ||
        materializeBuilder.destination !== "@builder@" ||
        materializeBuilder.network !== "locked-downloads-only" ||
        materializeBuilder.reusePolicy !== "verify-exact-or-fail" ||
        materializeBuilder.verifySha256 !== true ||
        materializeBuilder.verifySignatures !== true) {
        fail("Windows GCC builder materialization is incomplete or changed");
    }
    const materializeSources = phases[1].operations;
    if (canonicalJson(materializeSources) !== canonicalJson([
        {checkoutEol: "lf", depth: 1, destination: "@source@",
            id: "materialize-sources.gcc",
            identity: "recipe.source", kind: "materialize-git",
            reusePolicy: "verify-exact-or-fail", verifyTree: true},
        {destination: "@dependencies@/msys2-gcc-recipes",
            checkoutEol: "lf", depth: 1,
            id: "materialize-sources.msys2-gcc-recipes",
            identity: "dependency.msys2-gcc-recipes", kind: "materialize-git",
            reusePolicy: "verify-exact-or-fail", verifyTree: true},
    ])) {
        fail("Windows GCC source materialization is incomplete or changed");
    }
    const prepare = phases[3].operations.find(
        (operation) => operation.kind === "apply-exact-patch-set");
    if (prepare?.patches !== "profile.patches" ||
        prepare.mode !== "git-apply-three-way-index" ||
        prepare.target !== "@source@" ||
        !fullRevisionPattern.test(prepare.expectedTree ?? "")) {
        fail("Windows GCC patch phase lacks deterministic tree verification");
    }
    const populate = phases[2].operations.find(
        (operation) => operation.kind === "extract-locked-packages");
    if (populate?.source !== "profile.builder.lock" ||
        populate.packages !== "profile.builder.payloadPackages" ||
        populate.bootstrapRuntimePackages !==
            "profile.builder.bootstrapRuntimePackages" ||
        populate.generatedProvides !== "profile.builder.generatedProvides" ||
        populate.destination !== "@install@" ||
        populate.stripPrefix !== "ucrt64" ||
        populate.collisionPolicy !== "identical-or-fail" ||
        canonicalJson(populate.exclude) !== canonicalJson([
            ".BUILDINFO", ".INSTALL", ".MTREE", ".PKGINFO",
        ])) {
        fail("Windows GCC payload extraction is incomplete or changed");
    }
    const configure = phases[4].operations.find(
        (operation) => operation.kind === "configure");
    validateWindowsConfigure(configure?.arguments);
    if (configure.program !== "@source@/configure") {
        fail("Windows GCC configure program is not source-bound");
    }
    const autoreconf = phases[3].operations[1];
    if (autoreconf.interpreter !== "@builder@/usr/bin/bash.exe" ||
        autoreconf.environmentPolicy !== "profile.environmentPolicy" ||
        canonicalJson(autoreconf.arguments) !== canonicalJson(["-fiv"])) {
        fail("Windows GCC autoreconf command is incomplete or changed");
    }
    if (configure.interpreter !== "@builder@/usr/bin/bash.exe" ||
        configure.environmentPolicy !== "profile.environmentPolicy") {
        fail("Windows GCC configure interpreter is incomplete or changed");
    }
    const make = phases[5].operations.find((operation) => operation.kind === "make");
    if (canonicalJson(make?.arguments) !== canonicalJson([
        "-O", "-j@jobs@", "STAGE1_CFLAGS=-O2", "MAKEINFO=true",
        "profiledbootstrap",
    ]) || make.interpreter !== "@builder@/usr/bin/bash.exe" ||
        make.environmentPolicy !== "profile.environmentPolicy" ||
        make.environment?.MSYS2_ARG_CONV_EXCL !== "-D") {
        fail("Windows GCC profiled bootstrap command is incomplete or changed");
    }
    const install = phases[6].operations.find((operation) => operation.kind === "make");
    if (install?.interpreter !== "@builder@/usr/bin/bash.exe" ||
        install?.environmentPolicy !== "profile.environmentPolicy" ||
        canonicalJson(install?.arguments) !==
            canonicalJson(["MAKEINFO=true", "install"])) {
        fail("Windows GCC install command is incomplete or changed");
    }
    if (phases[6].operations[1].root !== "@install@") {
        fail("Windows GCC portable-prefix normalization is not install-bound");
    }
    const closure = phases[6].operations[2];
    if (closure.root !== "@install@" || closure.runtime !== "pe-ucrt64" ||
        closure.generatedProvides !== "profile.builder.generatedProvides" ||
        closure.requiredGeneratedFiles !==
            "profile.builder.generatedRuntimeFiles" ||
        closure.requireProducedBy !== "install-gcc" ||
        closure.forbidResolutionFrom !== "@builder@" ||
        closure.requireAllImportsResolved !== true) {
        fail("Windows GCC final runtime closure verification is incomplete or changed");
    }
}
function validateWindowsProfile(profile, dependencies) {
    validateBuilder(profile.builder);
    if (!dependencies.has("msys2-gcc-recipes")) {
        fail("pinned MSYS2 GCC recipe source is absent");
    }
    if (profile.runtime.family !== "ucrt" || profile.threadModel !== "posix" ||
        profile.exceptionModel !== "seh") {
        fail("Windows GCC recipe must select UCRT, POSIX threads, and SEH");
    }
    if (!Array.isArray(profile.patches) || profile.patches.length === 0) {
        fail("Windows GCC recipe requires a selected platform patch set");
    }
    profile.patches.forEach((patch, index) => validatePatch(patch, index, dependencies));
    validateRoots(profile.roots);
    validateEnvironment(profile.environment);
    validateEnvironmentPolicy(profile.environmentPolicy);
    validatePhases(profile.phases);
}

export function validateGccRecipe(recipe) {
    requireObject(recipe, "GCC recipe");
    if (recipe.schemaVersion !== gccRecipeSchemaVersion) {
        fail(`unsupported GCC recipe schema: ${recipe.schemaVersion}`);
    }
    if (recipe.component !== "gcc" || recipe.version !== "16.2.0") {
        fail("GCC recipe component/version must be gcc 16.2.0");
    }
    requireString(recipe.packageRevision, "GCC package revision");
    const source = requireObject(recipe.source, "GCC recipe source");
    requireString(source.repository, "GCC source repository");
    for (const field of ["revision", "tree", "upstreamBaseRevision"]) {
        if (!fullRevisionPattern.test(source[field] ?? "")) {
            fail(`GCC source ${field} is not an exact full object id`);
        }
    }
    if (!Array.isArray(source.patchRevisions) || source.patchRevisions.length === 0 ||
        source.patchRevisions.some((revision) => !fullRevisionPattern.test(revision ?? ""))) {
        fail("GCC source requires an ordered exact Move patch stack");
    }
    if (!Number.isSafeInteger(recipe.sourceDateEpoch) || recipe.sourceDateEpoch < 1) {
        fail("GCC recipe sourceDateEpoch must be a positive integer");
    }
    if (!Array.isArray(recipe.dependencies)) fail("GCC recipe dependencies must be an array");
    const dependencies = new Map();
    const dependencyIds = new Set();
    for (const dependency of recipe.dependencies) {
        validateDependency(dependency, dependencyIds);
        dependencies.set(dependency.id, dependency);
    }
    const profile = requireObject(recipe.profile, "GCC recipe profile");
    const canonical = canonicalProfileIdentity(profile.id);
    if (canonical.buildTriple !== profile.triples?.build ||
        canonical.hostTriple !== profile.triples?.host ||
        canonical.targetTriple !== profile.triples?.target ||
        canonical.targetCpuBaseline !== profile.targetCpuBaseline ||
        canonicalJson(canonical.runtime) !== canonicalJson(profile.runtime)) {
        fail(`GCC recipe disagrees with canonical profile ${profile.id}`);
    }
    if (profile.id === "windows-x86_64-ucrt64") {
        validateWindowsProfile(profile, dependencies);
    } else {
        fail(`GCC recipe profile is not implemented yet: ${profile.id}`);
    }
    return recipe;
}

export async function loadGccRecipe(recipePath) {
    const bytes = await readFile(recipePath, "utf8");
    const recipe = validateGccRecipe(JSON.parse(bytes));
    if (canonicalJson(recipe) !== bytes) fail(`GCC recipe is not canonical JSON: ${recipePath}`);
    const lockPath = path.resolve(repositoryRoot, recipe.profile.builder.lock.file);
    const relativeLock = path.relative(repositoryRoot, lockPath);
    if (relativeLock.startsWith(`..${path.sep}`) || path.isAbsolute(relativeLock)) {
        fail("GCC builder lock escapes the repository");
    }
    const builderLock = await loadBuilderLock(lockPath);
    if (builderLock.digest !== recipe.profile.builder.lock.sha256 ||
        builderLock.lock.id !== recipe.profile.builder.lock.id) {
        fail("GCC recipe builder lock digest or identity disagrees with its file");
    }
    const lockedByName = new Map(
        builderLock.lock.packages.map((entry) => [entry.name, entry]));
    for (const packageName of recipe.profile.builder.payloadPackages) {
        if (!lockedByName.has(packageName)) {
            fail(`Windows payload package is absent from the builder lock: ${packageName}`);
        }
    }
    const payloadProvides = new Set(recipe.profile.builder.payloadPackages);
    for (const packageName of recipe.profile.builder.payloadPackages) {
        for (const provided of lockedByName.get(packageName).provides) {
            payloadProvides.add(provided.split(/[<>=]/, 1)[0]);
        }
    }
    const bootstrapProvides = new Set();
    for (const packageName of recipe.profile.builder.bootstrapRuntimePackages) {
        const packageValue = lockedByName.get(packageName);
        if (!packageValue) {
            fail(`Windows bootstrap runtime package is absent: ${packageName}`);
        }
        bootstrapProvides.add(packageName);
        for (const provided of packageValue.provides) {
            bootstrapProvides.add(provided.split(/[<>=]/, 1)[0]);
        }
    }
    const generatedProvides = new Set(recipe.profile.builder.generatedProvides);
    for (const provided of generatedProvides) {
        if (!bootstrapProvides.has(provided)) {
            fail(`Windows bootstrap runtime does not supply generated identity: ${provided}`);
        }
    }
    for (const packageName of recipe.profile.builder.payloadPackages) {
        for (const dependency of lockedByName.get(packageName).dependencies) {
            const dependencyName = dependency.split(/[<>=]/, 1)[0];
            if (!payloadProvides.has(dependencyName) &&
                !generatedProvides.has(dependencyName)) {
                fail(`Windows payload dependency is unresolved: ${packageName} -> ${dependency}`);
            }
        }
    }
    return {recipe, path: path.resolve(recipePath), digest: sha256Bytes(bytes), builderLock};
}

export function gccBuildPlan(loaded) {
    const {recipe, path: recipePath, digest, builderLock} = loaded;
    return {
        recipe: recipePath, recipeDigest: digest,
        component: `${recipe.component}-${recipe.version}-${recipe.packageRevision}`,
        profile: recipe.profile.id,
        source: {...recipe.source, sourceDateEpoch: recipe.sourceDateEpoch},
        dependencies: recipe.dependencies,
        builder: {
            ...recipe.profile.builder,
            resolvedLock: {
                path: builderLock.path, sha256: builderLock.digest,
                base: builderLock.lock.base, packages: builderLock.lock.packages,
                roots: builderLock.lock.roots,
                signaturePolicy: builderLock.lock.signaturePolicy,
            },
        },
        triples: recipe.profile.triples,
        targetCpuBaseline: recipe.profile.targetCpuBaseline,
        runtime: recipe.profile.runtime,
        threadModel: recipe.profile.threadModel,
        exceptionModel: recipe.profile.exceptionModel,
        roots: recipe.profile.roots,
        environment: recipe.profile.environment,
        environmentPolicy: recipe.profile.environmentPolicy,
        patches: recipe.profile.patches,
        phases: recipe.profile.phases,
        costs: {buildGiB: 80, explicitAcceptanceRequired: true},
    };
}
