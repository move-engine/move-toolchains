# Windows setup

This guide configures a native Windows x86-64 development environment with:

- MSYS2 UCRT64 GCC 16.2 as the production C++ compiler;
- the pinned Move Engine `clang-p2996` build for clangd/editor tooling; and
- Xmake 3.0.1 or newer.

The fastest path uses qualified prebuilt artifacts. Building clang-p2996 from
source is optional and requires substantially more disk space and time.

## 1. Clone the repository

Install Git and Node.js 20 or newer, then clone the tooling repository:

```powershell
git clone https://github.com/move-engine/move-toolchains.git
Set-Location .\move-toolchains
node --version
```

Run the lightweight repository check:

```powershell
npm run doctor
```

The GitHub CLI is needed only to publish releases. It is not required to
install or use a toolchain.

## 2. Choose local roots

The interactive manager saves settings per host in the ignored
`.local/config.json` file:

```powershell
npm start
```

Choose a workspace on a fast drive with enough free space for LLVM source and
build trees:

```powershell
$toolchainRoot = Read-Host "Toolchain workspace root"
npm start -- assign workspace "$toolchainRoot"
npm start -- assign clangd "$toolchainRoot"
```

The workspace contains the versioned layout:

```text
<toolchain-root>\clang-p2996\<revision>\
  source\
  build\
  install\
```

You can use `.env` instead of saved settings. Copy `.env.example` to `.env` and
set one or more of:

```dotenv
MOVE_TOOLCHAINS_WIN32_X64_ROOT=C:\path\to\toolchains
MOVE_CLANG_P2996_ROOT=C:\path\to\toolchains
MOVE_UCRT64_ROOT=C:\msys64\ucrt64
MOVE_TOOLCHAINS_RELEASE_REPOSITORY=move-engine/move-toolchains
```

Direct component variables override the host workspace. Process environment
variables override `.env`, and both override saved host configuration.

## 3. Qualify or install MSYS2 UCRT64 GCC

First run the safe check:

```powershell
npm start -- setup msys2
```

If `C:\msys64\ucrt64` already contains a suitable compiler, the command runs a
real C++26 reflection probe and records the root. It checks the compiler
version, the `x86_64-w64-mingw32` target, UCRT macros, `<meta>`, and
`-freflection`; a version string alone is insufficient.

If MSYS2 or GCC is missing, review the requested system changes and rerun:

```powershell
npm start -- setup msys2 --accept-system-changes
```

That path uses Winget to install MSYS2 when necessary and Pacman to install the
UCRT64 GCC, CMake, Ninja, and Git packages. It does not modify the system unless
`--accept-system-changes` is present.

To use an existing non-default UCRT64 tree:

```powershell
npm start -- integrate D:\tools\msys64\ucrt64
```

The current clangd qualification profile expects GCC 16.2.0 in the UCRT64
root. A consuming project may impose an equal or stricter compiler contract.

## 4. Check or install Xmake

```powershell
npm start -- setup xmake
```

If a sufficiently recent Xmake is already on `PATH`, it is retained. Otherwise,
the manager downloads the official Win64 portable ZIP, verifies GitHub's
SHA-256 digest, installs it under the configured local workspace, and records
the executable path without replacing a system installation.

## 5. Download the qualified GCC + clangd set

Assign the public release repository once:

```powershell
npm start -- assign releases move-engine/move-toolchains
```

Then download the latest compatible Win64 toolchain set:

```powershell
npm start -- download toolchain
```

The manager verifies the complete release manifest before downloading either
large archive. It authenticates both archives, checks their embedded build
receipts and release evidence, and qualifies GCC and clangd together in a
disposable relocated tree. It then freshly extracts both components, verifies
their receipts again, and activates the set with one directory rename. A
partial or failed set never becomes selected.

Use a specific published toolchain release when reproducibility matters:

```powershell
npm start -- download toolchain --tag toolchains-2026.08.10
```

If you already have an extracted qualified installation, integrate its
workspace or `install` directory instead:

```powershell
npm start -- integrate "$toolchainRoot"
```

## 6. Verify the resulting environment

```powershell
npm start -- status
npm run status:clangd -- --root "$toolchainRoot"
```

The expected clangd executable is:

```text
<toolchain-root>\clang-p2996\<revision>\install\bin\clangd.exe
```

Use that absolute path in editor settings when the consuming project does not
generate its own editor integration. Keep GCC/UCRT64 as the actual build
compiler; the pinned Clang fork is currently the reflection-aware language
server, not the supported production compiler on Windows.

## Optional: build clang-p2996 from source

Install Visual Studio 2022 with the C++ desktop workload, CMake, Ninja, Python,
Git, and Node.js. Run from a shell where `cl.exe` is available. At least 80 GiB
of free space is required at the selected root.

Check prerequisites without downloading or building anything:

```powershell
npm run doctor:clangd -- `
  --root "$toolchainRoot" `
  --ucrt64-root C:\msys64\ucrt64
```

Start or resume the exact shallow source build only after accepting its cost:

```powershell
npm start -- build clangd --jobs 20
```

Interrupted builds retain matching source and build state for resumption. A
dirty or wrong-revision source checkout is rejected rather than silently used.

## Optional: package a qualified Windows build

Packaging does not rebuild clangd:

```powershell
npm start -- package clangd
```

The packager stages the existing install, bundles the discovered x64 VC143
application-local runtime, creates the ZIP and checksum, extracts the archive
to a different path, and reruns the full qualification. Existing output is
preserved unless `--force` is supplied.

## Troubleshooting

- **`cl` is missing:** run the source-build doctor from a Visual Studio
  Developer PowerShell, or use the prebuilt path.
- **GCC has the wrong target:** make sure the assigned root is UCRT64, not the
  MSYS, MINGW64, or CLANG64 environment.
- **The compiler version is correct but qualification fails:** keep the probe
  failure. The tool also requires the target ABI and reflection library surface.
- **The clang target already exists:** integrate the existing revision or
  choose another workspace; downloads do not overwrite installations.
- **A portable Xmake is installed but not found in another shell:** use the
  recorded absolute path from `.local/config.json`, or run commands through the
  manager. The installer intentionally does not alter system `PATH`.
