# Move toolchains

This repository collects toolchain automation extracted from private Move
repositories. Move currently depends on C++26 static reflection, so a coherent
development environment requires both a reflection-capable production compiler
and editor tooling that can understand the same code. It provides local build,
qualification, packaging, and release scripts for GCC 16 and a reflection-aware
clangd built from Bloomberg's `clang-p2996` fork. Check the
[GitHub Releases page](https://github.com/move-engine/move-toolchains/releases)
for the latest prebuilt toolchains. The release artifacts are portable and
structured to be easily consumed by Move's new Xmake toolchain.

The initial implementation deliberately targets the two environments already
qualified by the project:

- Windows x86-64 with MSYS2 UCRT64 GCC 16.2 and a native clang-p2996 language
  server; and
- Debian/WSL2 x86-64 with native GCC 16.2 and the full clang-p2996/libc++
  toolchain.

Setup guides:

- [Windows](docs/setup-windows.md)
- [Linux and WSL2](docs/setup-linux.md)

It is local-first. GitHub Actions and broader host detection can be added after
the package protocol and relocation tests are stable.

## Interactive manager

Run the top-level manager without arguments:

```text
npm start
```

It presents the host-appropriate operations for assigning or integrating
existing roots, building or downloading clang-p2996, assigning or downloading
GCC, building the configured or latest official stable GCC release, checking or
installing MSYS2/UCRT64, checking or downloading portable Xmake, packaging, and
publishing.

Every operation also has a non-interactive command. See:

```text
npm start -- help
```

Host-local assignments are saved under `.local/config.json`. They can be
overridden without editing that file through process environment variables or
a repository-root `.env`; copy `.env.example` for the supported names. The
precedence order is command line, process environment, `.env`, saved host
configuration, then repository defaults. This permits Windows, WSL/Linux, and
later macOS to use different build volumes from the same checkout.

## Requirements

- Node.js 20 or newer;
- Git, CMake, Ninja, and the platform compiler prerequisites for source builds;
- `unzip` on Linux/macOS for cross-host ZIP release verification;
- at least 80 GiB free for a clang-p2996 build; and
- GitHub CLI (`gh`) only when publishing a release.

Run the lightweight check with:

```text
npm run doctor
```

## clang-p2996 source build

The migrated bootstrap uses an exact shallow fetch of the Bloomberg fork,
qualifies the result, and preserves resumable build state:

```text
npm run doctor:clangd
npm start -- build clangd --jobs 20
```

On Windows, `--ucrt64-root` defaults to `C:\msys64\ucrt64`. On Linux, the
bootstrap builds clang, clangd, libc++, libc++abi, and libunwind as one isolated
toolchain.

Package and relocation-test the qualified Windows installation with:

```text
npm start -- package clangd
```

The packager discovers the latest installed x64 `Microsoft.VC143.CRT`
application-local runtime, copies the complete redistributable DLL set, runs
the staged clangd, creates the ZIP and checksum, extracts it to a different
path, and runs the bootstrap's full trusted-prebuilt qualification there.
Pass `--vc-runtime-dir` to override Visual Studio discovery. Public
redistribution remains subject to the applicable Microsoft and upstream
licenses; license collection is a release gate, not implied by successful
packaging.

## Linux GCC

`platform/linux/install-modern-toolchains.sh` is the existing exact GNU release
installer. For the current target:

```text
sudo env GCC_VERSION=16.2.0 GCC_BUILD_JOBS=20 INSTALL_ONLY=1 \
  UPDATE_GCC_LD_SO_CONF=0 \
  ./platform/linux/install-modern-toolchains.sh
```

This remains a developer-machine installer, not yet the GCC archive builder.
The archive lane must install into a staging prefix, qualify relocation, and
close non-baseline runtime dependencies before a GCC asset is added to
`toolchains.json`.

## Verify the current release set

The first manifest describes the already-qualified clang-p2996 archives. Point
the verifier at the directory holding them:

```text
npm run release:verify -- \
  --artifact-dir .local\prebuilt
```

Verification checks every declared asset and adjacent checksum, rejects unsafe
archive paths, and confirms required toolchain entries. It generates release
notes and a machine-readable release manifest beneath `.local/releases`.

## Publish a GitHub Release

Publication is dry-run by default:

```text
npm start -- assign releases OWNER/move-toolchains
npm start -- publish
```

After reviewing the exact tag and asset list, add `--publish`. A real publish
requires an authenticated `gh`, refuses a dirty Git worktree or an existing
release, creates a draft, uploads the complete declared asset set, and only then
publishes it. If final publication fails, the uploaded draft is preserved for
inspection.

Enable immutable releases in the GitHub repository before the first public
release. Never run release publication from untrusted pull-request code.

## Consumer bootstrap boundary

A consuming repository should carry only a small bootstrap adapter. It should:

1. accept a system GCC only after version, target, ABI, `<meta>`, and reflection
   feature probes pass;
2. offer a pinned portable Xmake when Xmake is absent or too old;
3. download the latest release compatible with the consumer's declared
   toolchain channel, rather than executing this repository's latest source
   revision; and
4. verify the release manifest and checksum before extraction and local
   qualification.

An Xmake dependency cannot replace its parent project's compiler midway through
configuration, so external consumers must bootstrap before their first Xmake
configure. Once bootstrapped, ordinary root-level `xmake` remains the target
workflow.
