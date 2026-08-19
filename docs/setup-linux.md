# Linux setup

This guide configures a Linux x86-64 development environment with:

- GCC 16.1 or newer after an actual C++26 reflection feature probe;
- the pinned Bloomberg `clang-p2996` toolchain for clangd/editor tooling; and
- Xmake 3.0.1 or newer.

Published Linux clang-p2996 artifacts target x86-64 baseline and declare their
minimum glibc. The manager reads the runtime glibc from Node's process report
and selects the newest artifact whose floor is no greater than the host. It
does not parse localized `ldd` output for selection.

## 1. Clone the repository

Install Git, Node.js 20 or newer, and its native Linux npm, then clone the
tooling repository:

```bash
git clone https://github.com/move-engine/move-toolchains.git ~/src/move-toolchains
cd ~/src/move-toolchains
node --version
npm run doctor
```

For Debian or Ubuntu, the common prerequisites for local checks and source
builds include:

```bash
sudo apt update
sudo apt install nodejs npm build-essential cmake ninja-build python3 git unzip
```

The GitHub CLI is needed only to publish releases.

## 2. Choose Linux-local roots

Run the interactive manager:

```bash
npm start
```

Host-local assignments are saved in the ignored `.local/config.json`. For a
large source build, prefer a native Linux filesystem rather than `/mnt/c` or
another Windows-mounted filesystem under WSL2:

```bash
npm start -- assign workspace "$HOME/.local/share/move-toolchains"
npm start -- assign clangd "$HOME/.local/share/move-toolchains"
```

Alternatively, copy `.env.example` to `.env` and configure the Linux host:

```dotenv
MOVE_TOOLCHAINS_LINUX_X64_ROOT=/home/user/.local/share/move-toolchains
MOVE_CLANG_P2996_ROOT=/home/user/.local/share/move-toolchains
MOVE_GCC_ROOT=/opt/gcc/current
MOVE_TOOLCHAINS_RELEASE_REPOSITORY=move-engine/move-toolchains
```

Process environment variables override `.env`; `.env` overrides the saved
host-specific configuration.

## 3. Integrate an existing GCC

If GCC is already installed under a versioned prefix, integrate its root:

```bash
npm start -- integrate /opt/gcc/current
```

The command checks the reported version and target, then compiles, links, and
runs a C++26 `<meta>`/`-freflection` probe. The currently supported floor is GCC
16.1, although a consuming project may require an exact newer release.

Inspect the selected environment with:

```bash
npm start -- status
```

On Linux this status includes the libc family and runtime version used for
artifact selection.

## 4. Check or install Xmake

```bash
npm start -- setup xmake
```

If the system Xmake is sufficiently recent, it is retained. Otherwise, the
manager downloads the official Linux x86-64 bundle, verifies the SHA-256 digest
reported by GitHub, installs it beneath the selected workspace, marks it
executable, and records its absolute path. It does not replace distro-managed
files or modify global `PATH`.

## 5. Download the qualified clang-p2996 artifact

Assign the release repository once:

```bash
npm start -- assign releases move-engine/move-toolchains
```

Inspect the glibc version Node will use for selection when diagnosing a host:

```bash
node -p 'process.report.getReport().header.glibcVersionRuntime'
```

Then download and qualify the latest compatible artifact:

```bash
npm start -- download clangd
```

For a reproducible setup, select an exact release:

```bash
npm start -- download clangd --tag toolchains-2026.08.1
```

The manager verifies the release manifest and archive checksums, rejects unsafe
archive entries, selects by the declared `minimumGlibc` before downloading the
large archive, publishes the versioned install beneath the configured root,
and runs the full trusted-prebuilt qualification at the final location. The
Linux qualification executes clang, clangd, and a reflection/libc++ smoke test;
it also verifies that libc++, libc++abi, and libunwind resolve from the isolated
installation rather than the host.

If no artifact supports the runtime glibc, the command fails before downloading
the archive and prints the explicit source-build command. It never silently
starts an LLVM build. musl and environments whose libc cannot be identified
remain unsupported and receive a distinct diagnostic.

To use an already extracted qualified tree:

```bash
npm start -- integrate "$HOME/.local/share/move-toolchains"
```

## 6. Verify the resulting environment

```bash
npm start -- status
npm run status:clangd -- \
  --root "$HOME/.local/share/move-toolchains"
```

The expected clangd executable is:

```text
<root>/clang-p2996/<revision>/install/bin/clangd
```

Use its absolute path in editor settings when the consuming project does not
generate editor integration itself.

## Optional: install or build GCC from an official GNU release

The local manager wraps `platform/linux/install-modern-toolchains.sh`, which
supports Debian 13+ and Ubuntu-family systems. The configured build installs
GCC 16.2 under the selected workspace's `gcc` directory and does not update
`ld.so.conf` or unversioned command links:

```bash
npm start -- build gcc --jobs 20
```

To discover and build the latest official stable GNU GCC release instead:

```bash
npm start -- build gcc --jobs 20 --latest-release
```

This is a system-aware developer installer, not yet the portable GCC archive
builder. It uses Apt and `sudo` to install source-build prerequisites, verifies
the official GNU source tarball with GNU's detached signature/keyring, selects
a non-experimental bootstrap compiler, and performs the source build. Review
those system changes before running it.

## Optional: build clang-p2996 from source

At least 80 GiB of free space is required. Check prerequisites without changing
the source or install tree:

```bash
npm run doctor:clangd -- \
  --root "$HOME/.local/share/move-toolchains"
```

Start or resume the exact shallow build only after accepting its cost:

```bash
npm start -- build clangd --jobs 20
```

The Linux profile builds and qualifies clang, clangd, libc++, libc++abi, and
libunwind together. Interrupted matching builds are resumable; a dirty or
wrong-revision source checkout is rejected.

## WSL2 notes

- Confirm `command -v node` and `command -v npm` resolve inside the Linux
  filesystem. If npm resolves beneath `/mnt/c`, install npm inside the distro;
  otherwise npm launches Windows Node and selects the Windows host profile.
- Keep large source/build trees in the Linux filesystem for better metadata and
  small-file performance. The repository itself may remain on a mounted Windows
  drive if desired.
- WSL free-space checks report space inside the Linux virtual disk. Ensure that
  the Windows volume backing the VHD also has adequate free space.
- A Linux clangd binary runs inside WSL. Native Windows VS Code should use the
  Windows clangd artifact unless the project is opened through VS Code's WSL
  environment.

## Troubleshooting

- **`installation: absent or unqualified`:** confirm the configured root and
  run `npm start -- download clangd`, or use `npm run adopt:clangd --` only for
  a checksum-verified archive.
- **No compatible glibc artifact:** use the printed opt-in source-build command
  or publish a package built on the required older baseline. Do not replace the
  system glibc or force a newer artifact onto an unsupported loader.
- **musl or unknown libc:** no glibc prebuilt is selected. Use a separately
  qualified source build rather than assuming ABI compatibility.
- **clangd resolves host `libstdc++`:** reject the installation. The qualified
  Linux package must use its isolated libc++/libc++abi/libunwind runtime.
- **GCC reports 16.x but integration fails:** preserve the failure; target and
  reflection feature probes are part of the contract.
- **Source builds fill the WSL virtual disk:** move the configured workspace to
  a larger native Linux filesystem or expand the WSL VHD before retrying.
