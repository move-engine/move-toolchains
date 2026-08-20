# Move GCC and Clang tools matrix

## Purpose

`move-toolchains` will produce a paired production-compiler and reflection-
language-tools distribution for these exact host profiles:

| Profile | Production compiler | Reflection language tools |
| --- | --- | --- |
| `windows-x86_64-ucrt64` | Move-qualified GCC 16.2 | Move `clang-p2996` clang/clangd and reflection libc++ headers |
| `linux-x86_64-glibc2.38` | Move-qualified GCC 16.2 | Move `clang-p2996` clang/clangd/libc++ toolchain |
| `linux-x86_64-glibc2.35` | Move-qualified GCC 16.2 | Move `clang-p2996` clang/clangd/libc++ toolchain |

The profile is part of artifact identity. Names such as `modern` or generic
`linux-x64` are not sufficient artifact compatibility claims.

GCC and Clang tools remain independently versioned component archives. A
release-level toolchain-set manifest selects exactly one qualified archive of
each component for one profile. Installers select a complete compatible set;
they never independently mix components from different profiles.

## GCC source topology

`move-engine/gcc` is the only Move GCC source repository. Platform differences
belong in build recipes unless a platform demonstrates a genuine source-level
correction.

The maintained branches have distinct roles:

- `master` mirrors upstream GCC history and receives no Move patches;
- `feature/trunk-<patch-name>` carries one reviewable downstream patch and its
  GCC regression tests on current upstream trunk;
- `move` integrates the currently accepted Move patch stack and is the rolling
  source line used to prepare future toolchains; and
- `releases/move-gcc-<version>` carries the ordered, reviewed backports on the
  exact official release commit used by that compiler package.

The manifest always pins a full source commit, its upstream base, and the
ordered Move patch commits. A branch name is provenance and maintenance
policy, not a reproducible build input. Advancing `move` therefore cannot
change an existing package derivation.

The imported-namespace reflection correction described in
[`gcc-imported-namespace-reflection.md`](gcc-imported-namespace-reflection.md)
exists on trunk feature commit
`65fa3a2e1926e9ee9f795c3272a78132cc48cdeb` and is integrated in rolling
`move` commit `f6dab223ec6724569a214a0f3c5d8f9c391bfbdf`. Its GCC 16.2 backport is
commit `ced2ae7f6670c0371e0464e5aaa888c44ebd012a` on
`releases/move-gcc-16.2.0`, based directly on official release commit
`78d4ac73dd391005b895a6148cd9831e28e1208b`. All three GCC 16.2 profile
artifacts must pin that one backport commit. Future updates merge a new
upstream trunk checkpoint into `move`, resolve each feature independently,
and cut a new exact release line when packages are promoted. None of these
operations changes mirrored `master`.

## Manifest layers

The checked-in manifest owns immutable derivation inputs:

- component source repositories and full revisions;
- upstream base and ordered downstream patch commits;
- component and package revisions;
- dependency source URLs/repositories, revisions, and archive hashes;
- build, host, and target triples;
- bootstrap compiler identity and accepted version;
- configure arguments and target CPU baseline;
- CRT/libc family and compatibility floor;
- pinned builder image or environment identity; and
- build-receipt, qualification, package, and release schema versions.

An artifact declaration binds one component archive to one exact profile. A
toolchain-set declaration binds one GCC artifact and one Clang tools artifact
with the same profile. Release verification rejects missing components,
profile disagreement, duplicate artifact identities, and references to
undeclared archives.

## Build receipts and archive hashes

Every staged component installation contains `move-build-receipt.json`. The
receipt records:

- the normalized manifest inputs above;
- source and patch commits in application order;
- the normalized configure/build/install commands;
- relevant non-secret environment values;
- the observed bootstrap compiler version;
- the build-image identity;
- `SOURCE_DATE_EPOCH` derived from the pinned component source commit;
- qualification cases and their outcomes; and
- a deterministic payload-tree manifest that explicitly excludes the receipt
  itself and later package/release evidence, including relative
  path, kind, mode, size, and content or link-target hash.

Absolute workstation paths and secrets are not portable receipt inputs. Build
tools express paths through stable logical roots and retain raw machine logs
outside the archive.

An archive cannot contain its own final SHA-256 without making its contents
self-referential. The adjacent checksum and release manifest therefore record
the final archive SHA-256 and bind it to the embedded receipt and installed-
tree digest. Release verification checks all three layers:

```text
manifest derivation inputs
        |
        v
embedded receipt + receipt-excluded payload-tree digest
        |
        v
archive bytes <- adjacent checksum and release manifest SHA-256
```

Archives use sorted paths, fixed numeric ownership, normalized permissions,
and timestamps derived from `SOURCE_DATE_EPOCH` where the platform archive
format permits it. The first required property is reproducible derivation from
fully pinned inputs; bit-for-bit comparison is recorded as evidence rather
than assumed.

The embedded receipt records qualification completed against the staged
payload before packaging, including a staged-prefix-independence check that
does not claim archive relocation. Extracted-archive relocation,
path-with-spaces, clean-runtime, and archive-byte qualification necessarily
occur after the archive exists; their results live in release-side evidence
and the release manifest, which binds the embedded receipt hash, payload-tree
digest, and final archive SHA-256.

## Shared command boundary

The intended non-interactive interface is:

```text
npm run gcc -- plan --profile <profile>
npm run gcc -- build --profile <profile> [--jobs N] --accept-cost
npm run gcc -- qualify --profile <profile>
npm run gcc -- package --profile <profile> [--output-dir PATH]
```

`plan` is read-only and reports exact sources, dependencies, triples, roots,
commands, expected storage, and builder identity. A build is never an implicit
fallback from setup/download and never starts without the explicit cost gate.
Build, staging, package, module cache, qualification, and evidence roots are
profile- and component-specific.

The existing Ubuntu 22.04 lane will become a shared profile runner rather than
a second GCC-specific script. It retains external storage-root support and can
run either component in the same pinned glibc 2.35 environment. The native
Windows UCRT64 and Linux glibc 2.38 runners consume the same manifest and
receipt contract.

## Windows UCRT64 recipe boundary

The Windows artifact is built natively under MSYS2 UCRT64, but it is never
installed into the bootstrap `C:\msys64\ucrt64` prefix. The recipe owns clean
source, build, sysroot, staging, and qualification roots.

The manifest must settle and record:

- `x86_64-w64-mingw32` build, host, and target triples;
- UCRT, SEH, and the chosen POSIX/winpthreads or Win32 thread model;
- exact binutils and mingw-w64 sources;
- exact GMP, MPFR, MPC, ISL, and other build dependencies;
- C and C++ languages, LTO policy, and x86-64 baseline flags; and
- whether host executables are independent of an interactive MSYS2 shell.

Qualification runs with a sanitized `PATH` containing only the staged
toolchain and declared Windows system locations. PE imports for every shipped
executable and DLL are inventoried. Required non-system DLLs are copied into
the package and recorded; an undeclared dependency on the builder's MSYS2
installation fails qualification.

## Linux recipe boundary

Linux packages are built inside an environment whose actual runtime glibc is
the declared floor. Distribution names are supporting evidence, not the ABI
claim. Every shipped ELF executable and shared library is inspected for:

- maximum required `GLIBC_*` symbol version;
- unresolved dynamic dependencies;
- required GCC, C++, unwind, and other non-system runtime closure; and
- an RPATH/RUNPATH and interpreter policy that survives relocation.

The glibc 2.35 lane uses the pinned Ubuntu 22.04 builder. The glibc 2.38 lane
must use a separately pinned environment whose runtime is exactly 2.38; it
must not infer the floor from a newer Debian host and relabel the result.

The runtime qualification extracts to a new path containing spaces, removes
build tools from `PATH`, runs C and C++ smoke programs, and exercises the
reflection/modules probes. The 2.35 artifact is additionally run on a newer
glibc host to prove forward compatibility.

## GCC qualification boundary

Every packaged GCC artifact must pass from a clean module cache:

1. C11 and ordinary C++ compilation/link/run;
2. C++26 reflection independently of modules;
3. C++20 module and partition workflows independently of reflection;
4. the exact Nez imported-namespace reflection fixture;
5. member count, exact reflected type identity, and identifier assertions;
6. bundled `reflect-4` and related `reflect-2`/`reflect-3` coverage;
7. a maintained practical subset of GCC modules/reflection tests;
8. relocation and a path containing spaces;
9. absence of build-tree paths and undeclared host runtime dependencies; and
10. clean qualification on the profile's declared runtime floor.

The minimized case is demonstrated once against the exact unpatched upstream
base and once against the corrected source. All three artifacts independently
run the positive qualification because they share source but not host runtime
or packaging behavior.

## Clang tools normalization

The existing Clang tools build remains a distinct component and source
revision. Its recipes adopt the same profile names, root isolation, receipt,
deterministic package, runtime audit, and toolchain-set manifest contracts.

The Windows component remains language-server focused: native clang/clangd,
Clang resource headers, and the reflection-capable libc++ headers used for
tooling. GCC/UCRT64 remains the production compiler. Linux remains the full
Clang tools plus libc++, libc++abi, and libunwind installation required by the
existing reflection qualification.

## Installation and selection

Setup detects process host and architecture, then uses Node's
`process.report.getReport().header.glibcVersionRuntime` for glibc. Musl and
unknown libc environments receive an explicit unsupported result.

Selection chooses the newest complete toolchain set whose compatibility floor
is no greater than the host runtime. It verifies the release manifest and
adjacent checksums before extracting either component. If no compatible set
exists, setup fails before downloading a component and explains the explicit
source-build command and storage requirement. It never silently starts a
large compiler build.

After both components relocate and qualify, setup records their roots and
configures clangd as the reflection language server. A partial component
download or qualification failure is quarantined and never becomes the active
toolchain set.

## Delivery gates

No release or `main` update is permitted until all six component archives and
all three composed sets pass:

- source and patch review;
- component-focused qualification;
- PE/ELF runtime-closure review;
- exact UCRT/glibc compatibility review;
- relocation and clean-host qualification;
- first-run download, checksum, install, status, and offline reuse;
- cross-host forward-compatibility checks;
- deterministic receipt/tree verification; and
- final release-manifest and checksum review.

Intermediate implementation and evidence stay on published task branches.
Large builds require an explicit cost acceptance and use external storage;
planning, validation, and dry runs must not trigger them.
