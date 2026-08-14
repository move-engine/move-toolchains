#!/usr/bin/env bash
#
# install-modern-toolchains.sh
#
# Purpose:
#   Install/update modern, non-experimental GCC and Clang/LLVM toolchains on
#   Debian 13+ and Ubuntu-family systems, including WSL2 developer installs.
#
# Core policy:
#   - Clang/LLVM comes from apt.llvm.org VERSIONED release branches.
#     LLVM_MAJOR=auto reads apt.llvm.org's own CURRENT_LLVM_STABLE value and
#     probes the corresponding Release file directly. It never infers stability
#     by choosing the numerically highest repository directory.
#
#   - GCC defaults to official GNU release tarballs, verified with GNU's
#     detached GPG signatures and installed under /opt/gcc/<version>.
#
#   - Debian never uses the Ubuntu Toolchain PPA. GCC_MODE=apt is supported only
#     on Ubuntu-family distributions; Debian uses GCC_MODE=gnu-release.
#
#   - On Debian, unversioned compiler/tool names default to managed symlinks in
#     /usr/local/bin rather than taking ownership of distro-managed /usr/bin
#     paths. Ubuntu-family installs retain update-alternatives by default.
#
# Important:
#   This intentionally changes command resolution for compilers and build tools.
#   For reproducible project builds, prefer per-project CC/CXX settings, CMake
#   presets, XMake configuration, containers, or pinned CI images.
#
# Defaults:
#   LLVM_MAJOR=auto          Latest stable major reported by apt.llvm.org.
#   GCC_MODE=gnu-release     Build/install official GNU GCC release tarballs.
#   GCC_VERSION=auto         Latest stable GNU GCC release.
#   GCC_MAJOR=auto           Do not restrict GCC to a major version.
#   GCC_BUILD_JOBS=auto      Memory-aware parallel build count.
#   COMMAND_LINK_MODE=auto   local on Debian; alternatives on Ubuntu family.
#
# Examples:
#   ./install-modern-toolchains.sh
#     Install/update latest stable GNU GCC and stable LLVM/Clang.
#
#   GCC_MAJOR=16 ./install-modern-toolchains.sh
#     Install/update the latest stable GCC 16.x.y release.
#
#   GCC_VERSION=16.2.0 ./install-modern-toolchains.sh
#     Install exactly GCC 16.2.0 from GNU release tarballs.
#
#   LLVM_MAJOR=22 ./install-modern-toolchains.sh
#     Install LLVM/Clang 22 from apt.llvm.org.
#
#   INSTALL_ONLY=1 ./install-modern-toolchains.sh
#     Install packages/build GCC, but do not change unversioned command links.
#
#   COMMAND_LINK_MODE=local ./install-modern-toolchains.sh
#     Manage unversioned commands under /usr/local/bin on any supported distro.
#
# Notes:
#   - Building GCC from source is resource-intensive. GCC_BUILD_JOBS=auto limits
#     concurrency using available memory; set a positive integer to override.
#
#   - GCC_MIN_FREE_GIB defaults to 20 GiB. Set it to 0 to disable the preflight.
#
#   - Older Clang tool packages and older /opt/gcc releases are retained unless
#     the corresponding cleanup flags below are enabled.

set -Eeuo pipefail

# -----------------------------
# User-configurable defaults
# -----------------------------

# LLVM/Clang major to install.
#   auto  - use apt.llvm.org's CURRENT_LLVM_STABLE and probe the matching
#           versioned Release file directly. If unavailable for this distro,
#           walk downward until an available stable major is found.
#   N     - request exactly major N. A major newer than CURRENT_LLVM_STABLE is
#           rejected unless ALLOW_LLVM_DEVELOPMENT=1.
LLVM_MAJOR="${LLVM_MAJOR:-auto}"
LLVM_AUTO_MAJORS="${LLVM_AUTO_MAJORS:-}"
ALLOW_LLVM_DEVELOPMENT="${ALLOW_LLVM_DEVELOPMENT:-0}"
APT_LLVM_STABLE_SCRIPT_URL="${APT_LLVM_STABLE_SCRIPT_URL:-https://apt.llvm.org/llvm.sh}"
LLVM_AUTO_MIN_MAJOR="${LLVM_AUTO_MIN_MAJOR:-15}"

# GCC installation mode.
#   gnu-release - official GNU release tarballs under /opt/gcc. Default.
#   apt         - apt packages, usually from ppa:ubuntu-toolchain-r/test.
#                 This mode rejects compilers that identify as experimental,
#                 trunk, snapshot, or prerelease builds.
GCC_MODE="${GCC_MODE:-gnu-release}"

# For GCC_MODE=gnu-release:
#   GCC_VERSION=auto       latest stable GNU GCC release.
#   GCC_VERSION=X.Y.Z      exact GNU GCC release.
#   GCC_MAJOR=auto         no major-version restriction.
#   GCC_MAJOR=N            latest stable N.x.y release.
#
# Examples:
#   GCC_MAJOR=16       -> latest stable GCC 16.x.y
#   GCC_VERSION=16.1.0 -> exactly GCC 16.1.0
GCC_VERSION="${GCC_VERSION:-auto}"
GCC_MAJOR="${GCC_MAJOR:-auto}"

# Used only when GCC_MODE=apt and GCC_MAJOR=auto.
# Keep this conservative: apt gcc-16 may be a trunk snapshot on some bases.
GCC_AUTO_MAJORS="${GCC_AUTO_MAJORS:-15 14}"

# GCC source build settings.
GNU_GCC_BASE_URL="${GNU_GCC_BASE_URL:-https://ftp.gnu.org/gnu/gcc}"
GNU_KEYRING_URL="${GNU_KEYRING_URL:-https://ftp.gnu.org/gnu/gnu-keyring.gpg}"
GCC_PREFIX_ROOT="${GCC_PREFIX_ROOT:-/opt/gcc}"
GCC_CURRENT_LINK="${GCC_CURRENT_LINK:-${GCC_PREFIX_ROOT}/current}"
GCC_BUILD_ROOT="${GCC_BUILD_ROOT:-${HOME}/.cache/gcc-builds}"
GCC_BUILD_JOBS="${GCC_BUILD_JOBS:-auto}"
GCC_BUILD_JOB_MEMORY_MB="${GCC_BUILD_JOB_MEMORY_MB:-1536}"
GCC_MIN_FREE_GIB="${GCC_MIN_FREE_GIB:-20}"
GCC_PREFIX_MIN_FREE_GIB="${GCC_PREFIX_MIN_FREE_GIB:-4}"
GCC_LANGUAGES="${GCC_LANGUAGES:-c,c++}"
GCC_BOOTSTRAP="${GCC_BOOTSTRAP:-1}"

# Compiler used to bootstrap/build official GNU GCC.
# auto means: choose the newest installed /usr/bin/gcc-N + /usr/bin/g++-N pair
# whose gcc --version output does not identify as experimental/trunk/snapshot.
# This prevents an accidentally-defaulted experimental gcc-16 from being used
# to build your stable GCC release when a normal distro gcc-12/gcc-14 exists.
GCC_BUILD_CC="${GCC_BUILD_CC:-auto}"
GCC_BUILD_CXX="${GCC_BUILD_CXX:-auto}"
GCC_CONFIGURE_EXTRA="${GCC_CONFIGURE_EXTRA:-}"
GCC_ALTERNATIVE_PRIORITY="${GCC_ALTERNATIVE_PRIORITY:-9000}"

# Make binaries linked with /opt/gcc/current's libstdc++ run without manually
# setting LD_LIBRARY_PATH. This is useful when GCC is the system default, but it
# does make the newer libstdc++ globally visible to the dynamic linker.
UPDATE_GCC_LD_SO_CONF="${UPDATE_GCC_LD_SO_CONF:-1}"

# Cleanup is opt-in.
PRUNE_OLD_GCC_RELEASES="${PRUNE_OLD_GCC_RELEASES:-0}"
OLD_GCC_RELEASES_TO_KEEP="${OLD_GCC_RELEASES_TO_KEEP:-2}"
REMOVE_OLD_CLANG_TOOLS="${REMOVE_OLD_CLANG_TOOLS:-0}"

# Command-resolution behavior.
#   auto         Debian -> /usr/local/bin symlinks; Ubuntu family -> alternatives
#   local        manage /usr/local/bin symlinks
#   alternatives manage distro command paths with update-alternatives
COMMAND_LINK_MODE="${COMMAND_LINK_MODE:-auto}"
LOCAL_COMMAND_DIR="${LOCAL_COMMAND_DIR:-/usr/local/bin}"
SET_CC_CXX_TO_GCC="${SET_CC_CXX_TO_GCC:-1}"
INSTALL_ONLY="${INSTALL_ONLY:-0}"

# apt repository behavior.
# GCC PPA is only relevant for GCC_MODE=apt. It is not used for the default
# official GNU release-tarball path.
SKIP_GCC_PPA="${SKIP_GCC_PPA:-0}"
SKIP_LLVM_REPO_SETUP="${SKIP_LLVM_REPO_SETUP:-${SKIP_LLVM_INSTALLER:-0}}"

APT_LLVM_BASE_URL="${APT_LLVM_BASE_URL:-https://apt.llvm.org}"
APT_LLVM_KEY_URL="${APT_LLVM_KEY_URL:-https://apt.llvm.org/llvm-snapshot.gpg.key}"
APT_LLVM_KEYRING="${APT_LLVM_KEYRING:-/usr/share/keyrings/apt.llvm.org.gpg}"

# -----------------------------
# Logging and error handling
# -----------------------------

log() {
    printf '\n\033[1;34m==>\033[0m %s\n' "$*"
}

warn() {
    printf '\n\033[1;33mWARNING:\033[0m %s\n' "$*" >&2
}

die() {
    printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2
    exit 1
}

on_error() {
    local exit_code=$?
    local line_no=$1
    local command_text=$2
    printf '\n\033[1;31mERROR:\033[0m command failed with exit code %d at line %s:\n  %s\n' \
        "$exit_code" "$line_no" "$command_text" >&2
    exit "$exit_code"
}

trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR

require_command() {
    command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

is_positive_integer() {
    [[ "${1:-}" =~ ^[1-9][0-9]*$ ]]
}

is_nonnegative_integer() {
    [[ "${1:-}" =~ ^[0-9]+$ ]]
}

is_boolean_01() {
    [[ "${1:-}" == "0" || "${1:-}" == "1" ]]
}

is_semver_triplet() {
    [[ "${1:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

# -----------------------------
# Root/sudo handling
# -----------------------------

SUDO=()
SUDO_KEEPALIVE_PID=""

setup_privilege_escalation() {
    if [[ "$(id -u)" -eq 0 ]]; then
        SUDO=()
        return
    fi

    require_command sudo

    log "Requesting sudo access"
    sudo -v
    SUDO=(sudo)

    # Keep sudo alive while long package operations and source builds run.
    while true; do
        sudo -n true || exit 0
        sleep 30
    done 2>/dev/null &
    SUDO_KEEPALIVE_PID="$!"
}

cleanup() {
    if [[ -n "${SUDO_KEEPALIVE_PID:-}" ]]; then
        kill "$SUDO_KEEPALIVE_PID" 2>/dev/null || true
    fi
}

trap cleanup EXIT

# -----------------------------
# apt and OS helpers
# -----------------------------

candidate_exists() {
    # Return success if apt knows about a package and has an install candidate.
    local pkg="$1"
    local candidate=""

    candidate="$(apt-cache policy "$pkg" 2>/dev/null | awk '/Candidate:/ { print $2; exit }')"
    [[ -n "$candidate" && "$candidate" != "(none)" ]]
}

require_apt_candidates() {
    local missing=()
    local pkg

    for pkg in "$@"; do
        if ! candidate_exists "$pkg"; then
            missing+=("$pkg")
        fi
    done

    if (( ${#missing[@]} > 0 )); then
        printf 'Missing required apt candidates:\n' >&2
        printf '  %s\n' "${missing[@]}" >&2
        die "Required package candidates are unavailable. Check repository setup and requested versions."
    fi
}

install_required_packages() {
    require_apt_candidates "$@"
    "${SUDO[@]}" apt-get install -y "$@"
}

install_optional_packages() {
    local available=()
    local skipped=()
    local pkg

    for pkg in "$@"; do
        if candidate_exists "$pkg"; then
            available+=("$pkg")
        else
            skipped+=("$pkg")
        fi
    done

    if (( ${#available[@]} > 0 )); then
        "${SUDO[@]}" apt-get install -y "${available[@]}"
    fi

    if (( ${#skipped[@]} > 0 )); then
        warn "Skipping optional packages without apt candidates: ${skipped[*]}"
    fi
}

installed_package_names_matching() {
    local regex="$1"
    dpkg-query -W -f='${binary:Package}\n' 2>/dev/null | grep -E "$regex" || true
}

apt_llvm_repo_path_exists() {
    local repo_path="$1"
    wget --compression=none --spider --quiet "${APT_LLVM_BASE_URL}/${repo_path}/dists/"
}

resolve_distro_and_llvm_repo() {
    local codename="${VERSION_CODENAME:-}"
    local ubuntu_codename="${UBUNTU_CODENAME:-}"
    local id_like=" ${ID_LIKE:-} "

    DISTRO_FAMILY=""
    APT_LLVM_REPO_PATH=""
    APT_LLVM_SUITE_PREFIX=""

    if [[ "${ID:-}" == "debian" ]]; then
        DISTRO_FAMILY="debian"
        [[ -n "$codename" ]] || die "Debian VERSION_CODENAME is missing from /etc/os-release."

        # apt.llvm.org currently publishes stable Debian releases under their
        # codename and Debian testing/sid under /unstable/. Prefer a dedicated
        # codename path if it exists so this keeps working when testing becomes
        # stable; otherwise use the upstream unstable mapping.
        if apt_llvm_repo_path_exists "$codename"; then
            APT_LLVM_REPO_PATH="$codename"
            APT_LLVM_SUITE_PREFIX="llvm-toolchain-${codename}"
        elif [[ "$codename" == "sid" || "$codename" == "forky" || "$codename" == "testing" || "$codename" == "unstable" ]]; then
            APT_LLVM_REPO_PATH="unstable"
            APT_LLVM_SUITE_PREFIX="llvm-toolchain"
        else
            die "apt.llvm.org has no repository path for Debian codename '${codename}'."
        fi
        return
    fi

    case "${ID:-}" in
        ubuntu|pop|linuxmint|elementary|zorin)
            DISTRO_FAMILY="ubuntu"
            ;;
        *)
            if [[ "$id_like" == *" ubuntu "* ]]; then
                DISTRO_FAMILY="ubuntu"
            else
                die "Unsupported apt-based distribution '${ID:-unknown}'. Supported: Debian and Ubuntu-family systems."
            fi
            ;;
    esac

    codename="${ubuntu_codename:-$codename}"
    [[ -n "$codename" ]] || die "Could not determine Ubuntu base codename from /etc/os-release."
    APT_LLVM_REPO_PATH="$codename"
    APT_LLVM_SUITE_PREFIX="llvm-toolchain-${codename}"
}

repo_release_exists() {
    local repo_path="$1"
    local suite="$2"
    local url="${APT_LLVM_BASE_URL}/${repo_path}/dists/${suite}/Release"

    wget --compression=none --spider --quiet "$url"
}

# -----------------------------
# Stable LLVM/Clang via apt.llvm.org
# -----------------------------

fetch_apt_llvm_stable_major() {
    local tmp=""
    local stable=""

    tmp="$(mktemp)"
    if ! wget --compression=none -qO "$tmp" "$APT_LLVM_STABLE_SCRIPT_URL"; then
        rm -f "$tmp"
        die "Could not download apt.llvm.org's llvm.sh to determine the current stable LLVM major. Set LLVM_MAJOR explicitly to bypass auto-detection."
    fi

    stable="$(sed -nE 's/^[[:space:]]*CURRENT_LLVM_STABLE=([0-9]+)[[:space:]]*$/\1/p' "$tmp" | head -n 1)"
    rm -f "$tmp"

    is_positive_integer "$stable" \
        || die "Could not parse CURRENT_LLVM_STABLE from apt.llvm.org llvm.sh. Set LLVM_MAJOR explicitly."

    printf '%s\n' "$stable"
}

select_apt_llvm_major() {
    local requested_major="$1"
    local stable_major=""
    local major=""

    stable_major="$(fetch_apt_llvm_stable_major)"
    log "apt.llvm.org reports current stable LLVM major: ${stable_major}" >&2

    if [[ "$requested_major" != "auto" ]]; then
        is_positive_integer "$requested_major" \
            || die "LLVM_MAJOR must be 'auto' or a positive integer; got '${requested_major}'."

        if (( requested_major > stable_major )) && [[ "$ALLOW_LLVM_DEVELOPMENT" != "1" ]]; then
            die "LLVM ${requested_major} is newer than apt.llvm.org's current stable major ${stable_major}. Set ALLOW_LLVM_DEVELOPMENT=1 to opt into prerelease/development LLVM."
        fi

        if repo_release_exists "$APT_LLVM_REPO_PATH" "${APT_LLVM_SUITE_PREFIX}-${requested_major}"; then
            printf '%s\n' "$requested_major"
            return
        fi

        if [[ "$ALLOW_LLVM_DEVELOPMENT" == "1" ]] \
            && repo_release_exists "$APT_LLVM_REPO_PATH" "$APT_LLVM_SUITE_PREFIX"; then
            warn "Versioned suite for LLVM ${requested_major} is unavailable; the unsuffixed apt.llvm.org development suite will be tried because ALLOW_LLVM_DEVELOPMENT=1."
            printf '%s\n' "$requested_major"
            return
        fi

        die "apt.llvm.org has no usable repository suite for LLVM ${requested_major} under '${APT_LLVM_REPO_PATH}'."
    fi

    if [[ -n "$LLVM_AUTO_MAJORS" ]]; then
        for major in $LLVM_AUTO_MAJORS; do
            is_positive_integer "$major" \
                || die "LLVM_AUTO_MAJORS contains a non-integer entry: '${major}'."

            if (( major > stable_major )) && [[ "$ALLOW_LLVM_DEVELOPMENT" != "1" ]]; then
                continue
            fi

            if repo_release_exists "$APT_LLVM_REPO_PATH" "${APT_LLVM_SUITE_PREFIX}-${major}"; then
                printf '%s\n' "$major"
                return
            fi
        done
        die "Could not find an apt.llvm.org suite from LLVM_AUTO_MAJORS='${LLVM_AUTO_MAJORS}' under '${APT_LLVM_REPO_PATH}'."
    fi

    is_positive_integer "$LLVM_AUTO_MIN_MAJOR" \
        || die "LLVM_AUTO_MIN_MAJOR must be a positive integer."

    # Do not scrape apt.llvm.org's directory index. The stable major is already
    # known authoritatively; probe concrete Release files instead. This avoids
    # binary/compressed directory responses being captured into Bash strings.
    for (( major = stable_major; major >= LLVM_AUTO_MIN_MAJOR; major-- )); do
        if repo_release_exists "$APT_LLVM_REPO_PATH" "${APT_LLVM_SUITE_PREFIX}-${major}"; then
            printf '%s\n' "$major"
            return
        fi
    done

    die "Could not find a versioned apt.llvm.org Release file for stable LLVM ${stable_major} or any major down to ${LLVM_AUTO_MIN_MAJOR} under '${APT_LLVM_REPO_PATH}'."
}

select_apt_llvm_suite() {
    local major="$1"
    local suffixed_suite="${APT_LLVM_SUITE_PREFIX}-${major}"

    if repo_release_exists "$APT_LLVM_REPO_PATH" "$suffixed_suite"; then
        printf '%s\n' "$suffixed_suite"
        return
    fi

    if [[ "$ALLOW_LLVM_DEVELOPMENT" == "1" ]] \
        && repo_release_exists "$APT_LLVM_REPO_PATH" "$APT_LLVM_SUITE_PREFIX"; then
        warn "Using apt.llvm.org development suite '${APT_LLVM_SUITE_PREFIX}' because ALLOW_LLVM_DEVELOPMENT=1."
        printf '%s\n' "$APT_LLVM_SUITE_PREFIX"
        return
    fi

    die "apt.llvm.org suite '${suffixed_suite}' is unavailable under '${APT_LLVM_REPO_PATH}'."
}

configure_apt_llvm_repository() {
    local major="$1"
    local suite=""
    local source_file=""
    local tmp_key=""

    suite="$(select_apt_llvm_suite "$major")"
    source_file="/etc/apt/sources.list.d/apt.llvm.org-${APT_LLVM_REPO_PATH}-${major}.sources"

    log "Configuring apt.llvm.org repository: ${APT_LLVM_REPO_PATH}/${suite}"

    tmp_key="$(mktemp)"
    wget --compression=none -qO "$tmp_key" "$APT_LLVM_KEY_URL"
    "${SUDO[@]}" install -d -m 0755 "$(dirname "$APT_LLVM_KEYRING")"
    gpg --dearmor < "$tmp_key" | "${SUDO[@]}" tee "$APT_LLVM_KEYRING" >/dev/null
    rm -f "$tmp_key"

    # Remove the legacy one-line source file used by older revisions of this
    # installer for the same repository/major, avoiding duplicate apt entries.
    "${SUDO[@]}" rm -f "/etc/apt/sources.list.d/apt.llvm.org-${APT_LLVM_REPO_PATH}-${major}.list"

    cat <<EOF | "${SUDO[@]}" tee "$source_file" >/dev/null
Types: deb
URIs: ${APT_LLVM_BASE_URL}/${APT_LLVM_REPO_PATH}/
Suites: ${suite}
Components: main
Signed-By: ${APT_LLVM_KEYRING}
EOF
}

# -----------------------------
# Official GNU GCC release discovery/build/install
# -----------------------------

list_gnu_gcc_releases() {
    # Print official GNU GCC release versions like 15.2.0 and 16.1.0.
    # This intentionally ignores snapshots and branch names because it only
    # parses release directories whose names are version triplets.
    wget --compression=none -qO- "${GNU_GCC_BASE_URL}/" \
        | grep -oE 'gcc-[0-9]+\.[0-9]+\.[0-9]+/' \
        | sed -E 's|gcc-||; s|/||' \
        | sort -V -u
}

find_latest_gnu_gcc_release() {
    local major_filter="$1"
    local releases=()

    if [[ "$major_filter" == "auto" ]]; then
        mapfile -t releases < <(list_gnu_gcc_releases)
    else
        is_positive_integer "$major_filter" || die "GCC_MAJOR must be 'auto' or a positive integer; got '${major_filter}'."
        mapfile -t releases < <(list_gnu_gcc_releases | grep -E "^${major_filter}\\.")
    fi

    if (( ${#releases[@]} == 0 )); then
        die "Could not find a stable GNU GCC release matching GCC_MAJOR='${major_filter}'."
    fi

    printf '%s\n' "${releases[-1]}"
}

resolve_gnu_gcc_version() {
    if [[ "$GCC_VERSION" == "auto" ]]; then
        find_latest_gnu_gcc_release "$GCC_MAJOR"
        return
    fi

    is_semver_triplet "$GCC_VERSION" || die "GCC_VERSION must be 'auto' or X.Y.Z; got '${GCC_VERSION}'."

    if [[ "$GCC_MAJOR" != "auto" ]]; then
        is_positive_integer "$GCC_MAJOR" || die "GCC_MAJOR must be 'auto' or a positive integer; got '${GCC_MAJOR}'."
        [[ "$GCC_VERSION" == "${GCC_MAJOR}."* ]] || die "GCC_VERSION='${GCC_VERSION}' does not match GCC_MAJOR='${GCC_MAJOR}'."
    fi

    printf '%s\n' "$GCC_VERSION"
}

detect_wsl() {
    if grep -Eqi '(microsoft|wsl)' /proc/sys/kernel/osrelease 2>/dev/null \
        || grep -Eqi '(microsoft|wsl)' /proc/version 2>/dev/null; then
        printf '1\n'
    else
        printf '0\n'
    fi
}

resolve_gcc_build_jobs() {
    local cpu_jobs=""
    local mem_available_mb=""
    local memory_jobs=""
    local resolved=""

    if [[ "$GCC_BUILD_JOBS" != "auto" ]]; then
        is_positive_integer "$GCC_BUILD_JOBS" \
            || die "GCC_BUILD_JOBS must be 'auto' or a positive integer."
        return
    fi

    is_positive_integer "$GCC_BUILD_JOB_MEMORY_MB" \
        || die "GCC_BUILD_JOB_MEMORY_MB must be a positive integer."

    cpu_jobs="$(nproc 2>/dev/null || printf '1')"
    is_positive_integer "$cpu_jobs" || cpu_jobs=1

    mem_available_mb="$(awk '/^MemAvailable:/ { print int($2 / 1024); exit }' /proc/meminfo 2>/dev/null || true)"
    if ! is_positive_integer "$mem_available_mb"; then
        warn "Could not read MemAvailable from /proc/meminfo; using CPU count (${cpu_jobs}) for GCC_BUILD_JOBS."
        GCC_BUILD_JOBS="$cpu_jobs"
        return
    fi

    memory_jobs=$(( mem_available_mb / GCC_BUILD_JOB_MEMORY_MB ))
    (( memory_jobs >= 1 )) || memory_jobs=1

    if (( memory_jobs < cpu_jobs )); then
        resolved="$memory_jobs"
    else
        resolved="$cpu_jobs"
    fi

    GCC_BUILD_JOBS="$resolved"
    log "Auto-selected GCC build parallelism: ${GCC_BUILD_JOBS} job(s) (${cpu_jobs} CPU thread(s), ${mem_available_mb} MiB available memory, ${GCC_BUILD_JOB_MEMORY_MB} MiB/job budget)"
}

find_existing_path_for_df() {
    local path="$1"
    while [[ ! -e "$path" && "$path" != "/" ]]; do
        path="$(dirname "$path")"
    done
    printf '%s\n' "$path"
}

check_free_space_gib() {
    local path="$1"
    local minimum_gib="$2"
    local label="$3"
    local anchor=""
    local available_kib=""
    local required_kib=""

    [[ "$minimum_gib" =~ ^[0-9]+$ ]] \
        || die "Free-space threshold for ${label} must be a non-negative integer GiB value."
    (( minimum_gib == 0 )) && return

    anchor="$(find_existing_path_for_df "$path")"
    available_kib="$(df -Pk "$anchor" | awk 'NR == 2 { print $4; exit }')"
    [[ "$available_kib" =~ ^[0-9]+$ ]] \
        || die "Could not determine free space for ${label} at ${anchor}."

    required_kib=$(( minimum_gib * 1024 * 1024 ))
    if (( available_kib < required_kib )); then
        die "Insufficient free space for ${label}: need at least ${minimum_gib} GiB at ${anchor}, have approximately $(( available_kib / 1024 / 1024 )) GiB. Set the corresponding *_MIN_FREE_GIB value to 0 to bypass this preflight."
    fi
}

preflight_gcc_disk_space() {
    mkdir -p "$GCC_BUILD_ROOT"
    check_free_space_gib "$GCC_BUILD_ROOT" "$GCC_MIN_FREE_GIB" "GCC build tree"
    check_free_space_gib "$GCC_PREFIX_ROOT" "$GCC_PREFIX_MIN_FREE_GIB" "GCC install prefix"

    if [[ "${IS_WSL:-0}" == "1" ]]; then
        warn "WSL disk preflight checks free space inside the Linux VHD. Ensure the Windows volume backing the WSL VHD also has sufficient free space."
    fi
}

install_gnu_gcc_build_dependencies() {
    log "Installing GCC source-build dependencies"

    install_required_packages \
        build-essential \
        make \
        flex \
        bison \
        texinfo \
        gawk \
        xz-utils \
        wget \
        gpgv \
        ca-certificates \
        libgmp-dev \
        libmpfr-dev \
        libmpc-dev \
        zlib1g-dev

    # These are useful when available, but not required for a C/C++ compiler.
    install_optional_packages \
        libisl-dev \
        libzstd-dev
}

reject_experimental_gcc() {
    local gcc_bin="$1"
    local version_text=""

    [[ -x "$gcc_bin" ]] || die "GCC executable not found: ${gcc_bin}"

    version_text="$($gcc_bin --version | head -n 1)"

    if grep -Eiq '(experimental|trunk|snapshot|prerelease)' <<< "$version_text"; then
        die "Rejecting experimental GCC build: ${version_text}"
    fi
}

select_gcc_bootstrap_compilers() {
    # Select the compiler used to build official GNU GCC. This is separate from
    # the compiler we install as the final system default.
    #
    # If GCC_BUILD_CC/GCC_BUILD_CXX are explicit paths, validate and use them.
    # Otherwise, scan versioned distro compilers such as /usr/bin/gcc-12 and
    # /usr/bin/g++-12. This avoids using an experimental gcc that currently
    # happens to own the unversioned /usr/bin/gcc alternative.
    local cc=""
    local cxx=""
    local candidate=""
    local major=""
    local candidates=()

    if [[ "$GCC_BUILD_CC" != "auto" || "$GCC_BUILD_CXX" != "auto" ]]; then
        [[ "$GCC_BUILD_CC" != "auto" && "$GCC_BUILD_CXX" != "auto" ]] \
            || die "Set both GCC_BUILD_CC and GCC_BUILD_CXX, or leave both as auto."
        [[ -x "$GCC_BUILD_CC" ]] || die "GCC_BUILD_CC is not executable: ${GCC_BUILD_CC}"
        [[ -x "$GCC_BUILD_CXX" ]] || die "GCC_BUILD_CXX is not executable: ${GCC_BUILD_CXX}"
        reject_experimental_gcc "$GCC_BUILD_CC"
        printf '%s\t%s\n' "$GCC_BUILD_CC" "$GCC_BUILD_CXX"
        return
    fi

    mapfile -t candidates < <(find /usr/bin -maxdepth 1 -regextype posix-extended -regex '.*/gcc-[0-9]+' -printf '%f\n' 2>/dev/null | sed -E 's/^gcc-//' | sort -Vr)

    for major in "${candidates[@]}"; do
        cc="/usr/bin/gcc-${major}"
        cxx="/usr/bin/g++-${major}"

        [[ -x "$cc" && -x "$cxx" ]] || continue

        if "$cc" --version | head -n 1 | grep -Eiq '(experimental|trunk|snapshot|prerelease)'; then
            continue
        fi

        printf '%s\t%s\n' "$cc" "$cxx"
        return
    done

    die "Could not find a non-experimental versioned GCC/G++ pair for bootstrapping. Try: GCC_BUILD_CC=/usr/bin/gcc-12 GCC_BUILD_CXX=/usr/bin/g++-12 ./install-modern-toolchains.sh"
}

install_gnu_gcc_release() {
    local version="$1"
    local prefix="${GCC_PREFIX_ROOT}/${version}"
    local workdir="${GCC_BUILD_ROOT}/gcc-${version}"
    local tarball="gcc-${version}.tar.xz"
    local sig="${tarball}.sig"
    local base_url="${GNU_GCC_BASE_URL}/gcc-${version}"
    local source_dir="${workdir}/gcc-${version}"
    local build_dir="${workdir}/build"
    local configure_args=()
    local bootstrap_pair=""
    local bootstrap_cc=""
    local bootstrap_cxx=""

    log "Preparing official GNU GCC ${version}"

    is_semver_triplet "$version" || die "Resolved GCC version is not X.Y.Z: ${version}"

    mkdir -p "$workdir"
    cd "$workdir"

    if [[ ! -f "$tarball" ]]; then
        log "Downloading ${tarball}"
        wget -c "${base_url}/${tarball}"
    else
        log "Using existing downloaded ${tarball}"
    fi

    if [[ ! -f "$sig" ]]; then
        log "Downloading ${sig}"
        wget -c "${base_url}/${sig}"
    else
        log "Using existing downloaded ${sig}"
    fi

    if [[ ! -f gnu-keyring.gpg ]]; then
        log "Downloading GNU keyring"
        wget -c -O gnu-keyring.gpg "$GNU_KEYRING_URL"
    else
        log "Using existing GNU keyring"
    fi

    log "Verifying GNU GCC tarball signature"
    gpgv --keyring ./gnu-keyring.gpg "$sig" "$tarball"

    bootstrap_pair="$(select_gcc_bootstrap_compilers)"
    bootstrap_cc="${bootstrap_pair%%$'\t'*}"
    bootstrap_cxx="${bootstrap_pair#*$'\t'}"
    log "Using bootstrap compiler: CC=${bootstrap_cc}, CXX=${bootstrap_cxx}"

    if [[ -x "${prefix}/bin/gcc" && -x "${prefix}/bin/g++" ]]; then
        log "GCC ${version} is already installed at ${prefix}"
    else
        log "Extracting GCC ${version} source"
        rm -rf "$source_dir" "$build_dir"
        tar -xf "$tarball"
        mkdir -p "$build_dir"

        configure_args=(
            "--prefix=${prefix}"
            "--enable-languages=${GCC_LANGUAGES}"
            "--disable-multilib"
            "--enable-default-pie"
            "--enable-default-ssp"
            "--with-system-zlib"
        )

        if [[ "$GCC_BOOTSTRAP" == "0" ]]; then
            configure_args+=("--disable-bootstrap")
        fi

        # GCC_CONFIGURE_EXTRA is intentionally split by the shell here so callers
        # can pass extra configure flags as one environment variable, e.g.:
        #   GCC_CONFIGURE_EXTRA="--enable-checking=release"
        if [[ -n "$GCC_CONFIGURE_EXTRA" ]]; then
            # shellcheck disable=SC2206
            configure_args+=( $GCC_CONFIGURE_EXTRA )
        fi

        log "Configuring GCC ${version}"
        (
            cd "$build_dir"
            CC="$bootstrap_cc" CXX="$bootstrap_cxx" "${source_dir}/configure" "${configure_args[@]}"
        )

        log "Building GCC ${version} with ${GCC_BUILD_JOBS} parallel job(s)"
        (
            cd "$build_dir"
            CC="$bootstrap_cc" CXX="$bootstrap_cxx" make -j"$GCC_BUILD_JOBS"
        )

        log "Installing GCC ${version} to ${prefix}"
        (
            cd "$build_dir"
            "${SUDO[@]}" make install
        )
    fi

    reject_experimental_gcc "${prefix}/bin/gcc"

    log "Updating ${GCC_CURRENT_LINK} -> ${prefix}"
    "${SUDO[@]}" install -d -m 0755 "$GCC_PREFIX_ROOT"
    "${SUDO[@]}" ln -sfnT "$prefix" "$GCC_CURRENT_LINK"

    if [[ "$UPDATE_GCC_LD_SO_CONF" == "1" ]]; then
        log "Configuring dynamic linker path for ${GCC_CURRENT_LINK}"

        # This makes libstdc++ from /opt/gcc/current visible to programs built
        # with this compiler. It is the practical choice when making this GCC a
        # system default. Set UPDATE_GCC_LD_SO_CONF=0 if you prefer to manage
        # LD_LIBRARY_PATH or rpath per project.
        {
            printf '%s/lib64\n' "$GCC_CURRENT_LINK"
            printf '%s/lib\n' "$GCC_CURRENT_LINK"
        } | "${SUDO[@]}" tee /etc/ld.so.conf.d/gcc-current.conf >/dev/null

        "${SUDO[@]}" ldconfig
    else
        warn "Skipping ld.so.conf update. Binaries linked with this GCC may need LD_LIBRARY_PATH or rpath to find the matching libstdc++."
    fi

    RESOLVED_GCC_VERSION="$version"
    GCC_BIN="${GCC_CURRENT_LINK}/bin/gcc"
    GXX_BIN="${GCC_CURRENT_LINK}/bin/g++"
    GCC_PRIORITY="$GCC_ALTERNATIVE_PRIORITY"
}

prune_old_gnu_gcc_releases() {
    local keep_count="$1"
    local current_real=""
    local releases=()
    local to_remove=()
    local path=""

    [[ "$PRUNE_OLD_GCC_RELEASES" == "1" ]] || return 0
    is_positive_integer "$keep_count" || die "OLD_GCC_RELEASES_TO_KEEP must be a positive integer."

    current_real="$(readlink -f "$GCC_CURRENT_LINK" 2>/dev/null || true)"

    mapfile -t releases < <(
        find "$GCC_PREFIX_ROOT" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended \
            -regex '.*/[0-9]+\.[0-9]+\.[0-9]+' -printf '%f\n' 2>/dev/null \
            | sort -V
    )

    if (( ${#releases[@]} <= keep_count )); then
        return
    fi

    while (( ${#releases[@]} > keep_count )); do
        path="${GCC_PREFIX_ROOT}/${releases[0]}"
        releases=("${releases[@]:1}")

        if [[ "$(readlink -f "$path" 2>/dev/null || true)" == "$current_real" ]]; then
            continue
        fi

        to_remove+=("$path")
    done

    if (( ${#to_remove[@]} > 0 )); then
        log "Pruning old GCC releases"
        printf 'Removing:\n'
        printf '  %s\n' "${to_remove[@]}"
        "${SUDO[@]}" rm -rf -- "${to_remove[@]}"
    fi
}

# -----------------------------
# update-alternatives helpers
# -----------------------------

alternative_master_link() {
    local name="$1"
    local output=""

    # update-alternatives --query exits nonzero when the group does not exist.
    # In this script, that is not an error; it simply means there is no existing
    # master link to protect.
    output="$(update-alternatives --query "$name" 2>/dev/null || true)"

    awk -F': ' '$1 == "Link" { print $2; exit }' <<< "$output"
}

safe_alternative_name() {
    local name="$1"
    printf '%s' "$name" | tr -c '[:alnum:]' '-'
}

path_dir_index() {
    local wanted="$1"
    local index=0
    local part

    IFS=':' read -r -a path_parts <<< "${PATH:-}"
    for part in "${path_parts[@]}"; do
        if [[ "$part" == "$wanted" ]]; then
            printf '%s\n' "$index"
            return
        fi
        index=$((index + 1))
    done

    printf '%s\n' ""
}

warn_if_usr_local_bin_will_not_shadow_usr_bin() {
    local local_index=""
    local usr_index=""

    local_index="$(path_dir_index /usr/local/bin)"
    usr_index="$(path_dir_index /usr/bin)"

    if [[ -z "$local_index" ]]; then
        warn "/usr/local/bin is not in PATH. Private fallback alternatives there will not affect command resolution."
        return
    fi

    if [[ -n "$usr_index" && "$local_index" -gt "$usr_index" ]]; then
        warn "/usr/local/bin appears after /usr/bin in PATH. Private fallback alternatives may not shadow distro commands."
    fi
}

install_alternative_direct() {
    # Args:
    #   $1 command name, e.g. gcc
    #   $2 target executable, e.g. /opt/gcc/current/bin/gcc
    #   $3 priority
    #
    # Normally manages /usr/bin/<command> with alternative name <command>.
    # If an existing master alternative with the same name uses another link
    # path, use a private /usr/local/bin/<command> link and a private group name
    # instead of failing.
    local command_name="$1"
    local target_path="$2"
    local priority="$3"
    local link_path="/usr/bin/${command_name}"
    local alt_name="$command_name"
    local existing_link=""
    local private_name=""

    if [[ ! -x "$target_path" ]]; then
        warn "Skipping ${command_name}: target is not executable: ${target_path}"
        return
    fi

    existing_link="$(alternative_master_link "$alt_name")"

    if [[ -n "$existing_link" && "$existing_link" != "$link_path" ]]; then
        private_name="modern-toolchain-$(safe_alternative_name "$command_name")"
        warn "Alternative group '${alt_name}' already manages '${existing_link}', not '${link_path}'. Managing /usr/local/bin/${command_name} via '${private_name}' instead."
        warn_if_usr_local_bin_will_not_shadow_usr_bin
        "${SUDO[@]}" install -d -m 0755 /usr/local/bin
        link_path="/usr/local/bin/${command_name}"
        alt_name="$private_name"
    fi

    if [[ -e "$link_path" && ! -L "$link_path" ]]; then
        die "Refusing to replace non-symlink path: $link_path"
    fi

    "${SUDO[@]}" update-alternatives --install "$link_path" "$alt_name" "$target_path" "$priority"
    "${SUDO[@]}" update-alternatives --set "$alt_name" "$target_path"
}

DEFERRED_ALT_NAMES=()
DEFERRED_ALT_TARGETS=()

add_alternative_slave_or_defer() {
    # Args:
    #   $1 array name to append slave args to
    #   $2 slave symlink path
    #   $3 slave alternative name
    #   $4 target executable
    local -n arr="$1"
    local link_path="$2"
    local alt_name="$3"
    local target_path="$4"
    local existing_link=""

    if [[ ! -x "$target_path" ]]; then
        warn "Skipping ${alt_name}: target is not executable: ${target_path}"
        return
    fi

    existing_link="$(alternative_master_link "$alt_name")"
    if [[ -n "$existing_link" ]]; then
        warn "Alternative group '${alt_name}' already exists as a master group; configuring it separately instead of making it a slave."
        DEFERRED_ALT_NAMES+=("$alt_name")
        DEFERRED_ALT_TARGETS+=("$target_path")
        return
    fi

    arr+=(--slave "$link_path" "$alt_name" "$target_path")
}

install_deferred_alternatives() {
    local priority="$1"
    local i

    for (( i = 0; i < ${#DEFERRED_ALT_NAMES[@]}; i++ )); do
        install_alternative_direct "${DEFERRED_ALT_NAMES[$i]}" "${DEFERRED_ALT_TARGETS[$i]}" "$priority"
    done

    DEFERRED_ALT_NAMES=()
    DEFERRED_ALT_TARGETS=()
}

warn_if_local_command_dir_will_not_shadow_usr_bin() {
    local local_index=""
    local usr_index=""

    local_index="$(path_dir_index "$LOCAL_COMMAND_DIR")"
    usr_index="$(path_dir_index /usr/bin)"

    if [[ -z "$local_index" ]]; then
        warn "${LOCAL_COMMAND_DIR} is not in PATH. Managed local compiler links will not affect command resolution."
        return
    fi

    if [[ -n "$usr_index" && "$local_index" -gt "$usr_index" ]]; then
        warn "${LOCAL_COMMAND_DIR} appears after /usr/bin in PATH. Managed local compiler links may not shadow distro commands."
    fi
}

install_local_command_link() {
    local command_name="$1"
    local target_path="$2"
    local link_path="${LOCAL_COMMAND_DIR}/${command_name}"

    if [[ ! -x "$target_path" ]]; then
        warn "Skipping ${command_name}: target is not executable: ${target_path}"
        return
    fi

    "${SUDO[@]}" install -d -m 0755 "$LOCAL_COMMAND_DIR"

    if [[ -e "$link_path" && ! -L "$link_path" ]]; then
        die "Refusing to replace non-symlink command path: ${link_path}"
    fi

    "${SUDO[@]}" ln -sfn "$target_path" "$link_path"
}

configure_local_command_links() {
    local gcc_dir="$(dirname "$GCC_BIN")"

    log "Configuring unversioned compiler/tool links under ${LOCAL_COMMAND_DIR}"
    warn_if_local_command_dir_will_not_shadow_usr_bin

    install_local_command_link gcc        "$GCC_BIN"
    install_local_command_link g++        "$GXX_BIN"
    install_local_command_link cpp        "${gcc_dir}/cpp"
    install_local_command_link gcov       "${gcc_dir}/gcov"
    install_local_command_link gcov-dump  "${gcc_dir}/gcov-dump"
    install_local_command_link gcov-tool  "${gcc_dir}/gcov-tool"
    install_local_command_link gcc-ar     "${gcc_dir}/gcc-ar"
    install_local_command_link gcc-nm     "${gcc_dir}/gcc-nm"
    install_local_command_link gcc-ranlib "${gcc_dir}/gcc-ranlib"
    install_local_command_link lto-dump   "${gcc_dir}/lto-dump"

    if [[ "$SET_CC_CXX_TO_GCC" == "1" ]]; then
        install_local_command_link cc  "$GCC_BIN"
        install_local_command_link c++ "$GXX_BIN"
    fi

    install_local_command_link clang           "/usr/bin/clang-${LLVM_MAJOR}"
    install_local_command_link clang++         "/usr/bin/clang++-${LLVM_MAJOR}"
    install_local_command_link clang-cpp       "/usr/bin/clang-cpp-${LLVM_MAJOR}"
    install_local_command_link clangd          "/usr/bin/clangd-${LLVM_MAJOR}"
    install_local_command_link clang-format    "/usr/bin/clang-format-${LLVM_MAJOR}"
    install_local_command_link clang-tidy      "/usr/bin/clang-tidy-${LLVM_MAJOR}"
    install_local_command_link lld             "/usr/bin/lld-${LLVM_MAJOR}"
    install_local_command_link ld.lld          "/usr/bin/ld.lld-${LLVM_MAJOR}"
    install_local_command_link lld-link        "/usr/bin/lld-link-${LLVM_MAJOR}"
    install_local_command_link wasm-ld         "/usr/bin/wasm-ld-${LLVM_MAJOR}"
    install_local_command_link lldb            "/usr/bin/lldb-${LLVM_MAJOR}"
    install_local_command_link llvm-ar         "/usr/bin/llvm-ar-${LLVM_MAJOR}"
    install_local_command_link llvm-nm         "/usr/bin/llvm-nm-${LLVM_MAJOR}"
    install_local_command_link llvm-ranlib     "/usr/bin/llvm-ranlib-${LLVM_MAJOR}"
    install_local_command_link llvm-objdump    "/usr/bin/llvm-objdump-${LLVM_MAJOR}"
    install_local_command_link llvm-readelf    "/usr/bin/llvm-readelf-${LLVM_MAJOR}"
    install_local_command_link llvm-strip      "/usr/bin/llvm-strip-${LLVM_MAJOR}"
    install_local_command_link llvm-config     "/usr/bin/llvm-config-${LLVM_MAJOR}"
    install_local_command_link llvm-cov        "/usr/bin/llvm-cov-${LLVM_MAJOR}"
    install_local_command_link llvm-profdata   "/usr/bin/llvm-profdata-${LLVM_MAJOR}"
    install_local_command_link llvm-symbolizer "/usr/bin/llvm-symbolizer-${LLVM_MAJOR}"
    install_local_command_link llvm-size       "/usr/bin/llvm-size-${LLVM_MAJOR}"
    install_local_command_link llvm-strings    "/usr/bin/llvm-strings-${LLVM_MAJOR}"
}

verify_command_resolution() {
    local command_name="$1"
    local expected_target="$2"
    local resolved=""
    local resolved_real=""
    local expected_real=""

    if ! command -v "$command_name" >/dev/null 2>&1; then
        warn "${command_name} is not found in PATH after installation."
        return
    fi

    resolved="$(command -v "$command_name")"
    resolved_real="$(readlink -f "$resolved" 2>/dev/null || printf '%s' "$resolved")"
    expected_real="$(readlink -f "$expected_target" 2>/dev/null || printf '%s' "$expected_target")"

    if [[ "$resolved_real" != "$expected_real" ]]; then
        warn "${command_name} resolves to ${resolved} -> ${resolved_real}, not expected target ${expected_real}. PATH may contain an earlier shadowing command."
    fi
}

print_version_if_available() {
    local command_name="$1"

    printf '\n'
    if command -v "$command_name" >/dev/null 2>&1; then
        command -v "$command_name"
        "$command_name" --version 2>/dev/null | head -n 1 || true
    else
        printf '%s not found\n' "$command_name"
    fi
}

# -----------------------------
# GCC apt mode, retained as an explicit fallback path
# -----------------------------

install_gcc_from_apt() {
    [[ "$DISTRO_FAMILY" == "ubuntu" ]] \
        || die "GCC_MODE=apt uses the Ubuntu Toolchain PPA and is not supported on Debian. Use GCC_MODE=gnu-release."

    if [[ "$SKIP_GCC_PPA" != "1" ]]; then
        log "Installing Ubuntu PPA helper and adding Ubuntu Toolchain PPA"
        install_required_packages software-properties-common
        require_command add-apt-repository
        "${SUDO[@]}" add-apt-repository -y ppa:ubuntu-toolchain-r/test
        "${SUDO[@]}" apt-get update
    else
        log "Skipping Ubuntu Toolchain PPA because SKIP_GCC_PPA=1"
    fi

    if [[ "$GCC_MAJOR" == "auto" ]]; then
        log "Auto-selecting newest available apt GCC candidate"

        local selected=""
        local candidate

        for candidate in $GCC_AUTO_MAJORS; do
            is_positive_integer "$candidate" || die "GCC_AUTO_MAJORS contains a non-integer entry: '${candidate}'."
            if candidate_exists "gcc-${candidate}" && candidate_exists "g++-${candidate}"; then
                selected="$candidate"
                break
            fi
        done

        [[ -n "$selected" ]] || die "Could not find gcc/g++ candidates from GCC_AUTO_MAJORS='${GCC_AUTO_MAJORS}'."
        GCC_MAJOR="$selected"
    fi

    log "Installing GCC/G++ ${GCC_MAJOR} from apt"
    install_required_packages "gcc-${GCC_MAJOR}" "g++-${GCC_MAJOR}"

    GCC_BIN="/usr/bin/gcc-${GCC_MAJOR}"
    GXX_BIN="/usr/bin/g++-${GCC_MAJOR}"
    GCC_PRIORITY="$((GCC_MAJOR * 10))"

    reject_experimental_gcc "$GCC_BIN"
}

# -----------------------------
# Preflight validation and base setup
# -----------------------------

require_command apt-get
require_command apt-cache
require_command dpkg-query
require_command awk
require_command grep
require_command sed
require_command mktemp
require_command readlink
require_command sort
require_command find
require_command dirname
require_command df
require_command head

if [[ "$LLVM_MAJOR" != "auto" ]]; then
    is_positive_integer "$LLVM_MAJOR" || die "LLVM_MAJOR must be 'auto' or a positive integer; got '${LLVM_MAJOR}'."
fi
is_positive_integer "$LLVM_AUTO_MIN_MAJOR" || die "LLVM_AUTO_MIN_MAJOR must be a positive integer."

case "$GCC_MODE" in
    gnu-release|apt)
        ;;
    *)
        die "GCC_MODE must be 'gnu-release' or 'apt'; got '${GCC_MODE}'."
        ;;
esac

if [[ "$GCC_VERSION" != "auto" ]]; then
    is_semver_triplet "$GCC_VERSION" || die "GCC_VERSION must be 'auto' or X.Y.Z; got '${GCC_VERSION}'."
fi

if [[ "$GCC_MAJOR" != "auto" ]]; then
    is_positive_integer "$GCC_MAJOR" || die "GCC_MAJOR must be 'auto' or a positive integer; got '${GCC_MAJOR}'."
fi

if [[ "$GCC_BUILD_JOBS" != "auto" ]]; then
    is_positive_integer "$GCC_BUILD_JOBS" || die "GCC_BUILD_JOBS must be 'auto' or a positive integer."
fi
is_positive_integer "$GCC_BUILD_JOB_MEMORY_MB" || die "GCC_BUILD_JOB_MEMORY_MB must be a positive integer."
is_nonnegative_integer "$GCC_MIN_FREE_GIB" || die "GCC_MIN_FREE_GIB must be a non-negative integer."
is_nonnegative_integer "$GCC_PREFIX_MIN_FREE_GIB" || die "GCC_PREFIX_MIN_FREE_GIB must be a non-negative integer."

is_boolean_01 "$ALLOW_LLVM_DEVELOPMENT" || die "ALLOW_LLVM_DEVELOPMENT must be 0 or 1."
is_boolean_01 "$GCC_BOOTSTRAP" || die "GCC_BOOTSTRAP must be 0 or 1."
is_boolean_01 "$UPDATE_GCC_LD_SO_CONF" || die "UPDATE_GCC_LD_SO_CONF must be 0 or 1."
is_boolean_01 "$PRUNE_OLD_GCC_RELEASES" || die "PRUNE_OLD_GCC_RELEASES must be 0 or 1."
is_positive_integer "$OLD_GCC_RELEASES_TO_KEEP" || die "OLD_GCC_RELEASES_TO_KEEP must be a positive integer."
is_boolean_01 "$REMOVE_OLD_CLANG_TOOLS" || die "REMOVE_OLD_CLANG_TOOLS must be 0 or 1."
is_boolean_01 "$SET_CC_CXX_TO_GCC" || die "SET_CC_CXX_TO_GCC must be 0 or 1."
is_boolean_01 "$INSTALL_ONLY" || die "INSTALL_ONLY must be 0 or 1."
is_boolean_01 "$SKIP_GCC_PPA" || die "SKIP_GCC_PPA must be 0 or 1."
is_boolean_01 "$SKIP_LLVM_REPO_SETUP" || die "SKIP_LLVM_REPO_SETUP must be 0 or 1."

case "$COMMAND_LINK_MODE" in
    auto|local|alternatives)
        ;;
    *)
        die "COMMAND_LINK_MODE must be 'auto', 'local', or 'alternatives'; got '${COMMAND_LINK_MODE}'."
        ;;
esac

[[ "$LOCAL_COMMAND_DIR" == /* ]] || die "LOCAL_COMMAND_DIR must be an absolute path."

if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
else
    die "/etc/os-release not found; cannot identify OS family."
fi

log "Detected OS: ${PRETTY_NAME:-unknown}"
IS_WSL="$(detect_wsl)"
if [[ "$IS_WSL" == "1" ]]; then
    log "Detected WSL environment"
fi

setup_privilege_escalation

# -----------------------------
# Install base apt/repo tooling
# -----------------------------

log "Installing apt repository helper tools"
"${SUDO[@]}" apt-get update
install_required_packages \
    ca-certificates \
    gnupg \
    gpgv \
    tar \
    wget

require_command wget
require_command gpg
require_command gpgv
require_command tar
if [[ "$UPDATE_GCC_LD_SO_CONF" == "1" ]]; then
    require_command ldconfig
fi

# Determine distro semantics only after wget is guaranteed to exist because the
# apt.llvm.org mapping probes whether a dedicated Debian codename path exists.
resolve_distro_and_llvm_repo
log "Using apt.llvm.org repository path: ${APT_LLVM_REPO_PATH}"
log "Using apt.llvm.org suite prefix: ${APT_LLVM_SUITE_PREFIX}"

if [[ "$COMMAND_LINK_MODE" == "auto" ]]; then
    if [[ "$DISTRO_FAMILY" == "debian" ]]; then
        COMMAND_LINK_MODE="local"
    else
        COMMAND_LINK_MODE="alternatives"
    fi
fi
log "Using command link mode: ${COMMAND_LINK_MODE}"

if [[ "$GCC_MODE" == "apt" && "$DISTRO_FAMILY" != "ubuntu" ]]; then
    die "GCC_MODE=apt is Ubuntu-PPA-specific and is not supported on Debian. Use GCC_MODE=gnu-release."
fi

# -----------------------------
# Configure/install LLVM/Clang
# -----------------------------

RESOLVED_LLVM_MAJOR="$(select_apt_llvm_major "$LLVM_MAJOR")"
LLVM_MAJOR="$RESOLVED_LLVM_MAJOR"
log "Resolved LLVM/Clang major: ${LLVM_MAJOR}"

if [[ "$SKIP_LLVM_REPO_SETUP" != "1" ]]; then
    configure_apt_llvm_repository "$LLVM_MAJOR"
else
    log "Skipping apt.llvm.org repository setup because SKIP_LLVM_REPO_SETUP=1"
fi

log "Updating apt metadata after LLVM repository setup"
"${SUDO[@]}" apt-get update

log "Installing/updating selected LLVM/Clang ${LLVM_MAJOR} packages"

LLVM_REQUIRED_PACKAGES=(
    "clang-${LLVM_MAJOR}"
    "lld-${LLVM_MAJOR}"
    "lldb-${LLVM_MAJOR}"
    "llvm-${LLVM_MAJOR}"
)

LLVM_OPTIONAL_PACKAGES=(
    "clangd-${LLVM_MAJOR}"
    "clang-format-${LLVM_MAJOR}"
    "clang-tidy-${LLVM_MAJOR}"
    "clang-tools-${LLVM_MAJOR}"
    "llvm-${LLVM_MAJOR}-dev"
    "llvm-${LLVM_MAJOR}-runtime"
    "libclang-rt-${LLVM_MAJOR}-dev"
    "libc++-${LLVM_MAJOR}-dev"
    "libc++abi-${LLVM_MAJOR}-dev"
    "libomp-${LLVM_MAJOR}-dev"
    "libunwind-${LLVM_MAJOR}-dev"
)

install_required_packages "${LLVM_REQUIRED_PACKAGES[@]}"
install_optional_packages "${LLVM_OPTIONAL_PACKAGES[@]}"

# -----------------------------
# Install/update GCC
# -----------------------------

GCC_BIN=""
GXX_BIN=""
GCC_PRIORITY=""
RESOLVED_GCC_VERSION=""

if [[ "$GCC_MODE" == "gnu-release" ]]; then
    install_gnu_gcc_build_dependencies
    RESOLVED_GCC_VERSION="$(resolve_gnu_gcc_version)"
    log "Resolved stable GNU GCC release: ${RESOLVED_GCC_VERSION}"

    if [[ ! -x "${GCC_PREFIX_ROOT}/${RESOLVED_GCC_VERSION}/bin/gcc" || ! -x "${GCC_PREFIX_ROOT}/${RESOLVED_GCC_VERSION}/bin/g++" ]]; then
        resolve_gcc_build_jobs
        preflight_gcc_disk_space
    fi

    install_gnu_gcc_release "$RESOLVED_GCC_VERSION"
    prune_old_gnu_gcc_releases "$OLD_GCC_RELEASES_TO_KEEP"
else
    install_gcc_from_apt
fi

CLANG_BIN="/usr/bin/clang-${LLVM_MAJOR}"

[[ -x "$GCC_BIN" ]] || die "Expected executable not found: $GCC_BIN"
[[ -x "$GXX_BIN" ]] || die "Expected executable not found: $GXX_BIN"
[[ -x "$CLANG_BIN" ]] || die "Expected executable not found: $CLANG_BIN"

LLVM_PRIORITY="$((LLVM_MAJOR * 10))"

# -----------------------------
# Configure command resolution
# -----------------------------

if [[ "$INSTALL_ONLY" == "1" ]]; then
    log "Skipping unversioned command changes because INSTALL_ONLY=1"
elif [[ "$COMMAND_LINK_MODE" == "local" ]]; then
    configure_local_command_links
else
    require_command update-alternatives

    log "Configuring update-alternatives for GCC"

    GCC_ALT_ARGS=(
        --install /usr/bin/gcc gcc "$GCC_BIN" "$GCC_PRIORITY"
    )

    add_alternative_slave_or_defer GCC_ALT_ARGS /usr/bin/g++        g++        "$(dirname "$GCC_BIN")/g++"
    add_alternative_slave_or_defer GCC_ALT_ARGS /usr/bin/cpp        cpp        "$(dirname "$GCC_BIN")/cpp"
    add_alternative_slave_or_defer GCC_ALT_ARGS /usr/bin/gcov       gcov       "$(dirname "$GCC_BIN")/gcov"
    add_alternative_slave_or_defer GCC_ALT_ARGS /usr/bin/gcov-dump  gcov-dump  "$(dirname "$GCC_BIN")/gcov-dump"
    add_alternative_slave_or_defer GCC_ALT_ARGS /usr/bin/gcov-tool  gcov-tool  "$(dirname "$GCC_BIN")/gcov-tool"
    add_alternative_slave_or_defer GCC_ALT_ARGS /usr/bin/gcc-ar     gcc-ar     "$(dirname "$GCC_BIN")/gcc-ar"
    add_alternative_slave_or_defer GCC_ALT_ARGS /usr/bin/gcc-nm     gcc-nm     "$(dirname "$GCC_BIN")/gcc-nm"
    add_alternative_slave_or_defer GCC_ALT_ARGS /usr/bin/gcc-ranlib gcc-ranlib "$(dirname "$GCC_BIN")/gcc-ranlib"
    add_alternative_slave_or_defer GCC_ALT_ARGS /usr/bin/lto-dump   lto-dump   "$(dirname "$GCC_BIN")/lto-dump"

    "${SUDO[@]}" update-alternatives "${GCC_ALT_ARGS[@]}"
    "${SUDO[@]}" update-alternatives --set gcc "$GCC_BIN"
    install_deferred_alternatives "$GCC_PRIORITY"

    if [[ "$SET_CC_CXX_TO_GCC" == "1" ]]; then
        log "Setting cc and c++ defaults to GCC/G++"
        install_alternative_direct cc "$GCC_BIN" "$GCC_PRIORITY"
        install_alternative_direct c++ "$GXX_BIN" "$GCC_PRIORITY"
    else
        log "Leaving cc and c++ alternatives unchanged"
    fi

    log "Configuring update-alternatives for Clang/LLVM ${LLVM_MAJOR}"

    CLANG_ALT_ARGS=(
        --install /usr/bin/clang clang "$CLANG_BIN" "$LLVM_PRIORITY"
    )

    add_alternative_slave_or_defer CLANG_ALT_ARGS /usr/bin/clang++         clang++         "/usr/bin/clang++-${LLVM_MAJOR}"
    add_alternative_slave_or_defer CLANG_ALT_ARGS /usr/bin/clang-cpp       clang-cpp       "/usr/bin/clang-cpp-${LLVM_MAJOR}"
    add_alternative_slave_or_defer CLANG_ALT_ARGS /usr/bin/clangd          clangd          "/usr/bin/clangd-${LLVM_MAJOR}"
    add_alternative_slave_or_defer CLANG_ALT_ARGS /usr/bin/clang-format    clang-format    "/usr/bin/clang-format-${LLVM_MAJOR}"
    add_alternative_slave_or_defer CLANG_ALT_ARGS /usr/bin/clang-tidy      clang-tidy      "/usr/bin/clang-tidy-${LLVM_MAJOR}"
    add_alternative_slave_or_defer CLANG_ALT_ARGS /usr/bin/lld             lld             "/usr/bin/lld-${LLVM_MAJOR}"
    add_alternative_slave_or_defer CLANG_ALT_ARGS /usr/bin/ld.lld          ld.lld          "/usr/bin/ld.lld-${LLVM_MAJOR}"
    add_alternative_slave_or_defer CLANG_ALT_ARGS /usr/bin/lld-link        lld-link        "/usr/bin/lld-link-${LLVM_MAJOR}"
    add_alternative_slave_or_defer CLANG_ALT_ARGS /usr/bin/wasm-ld         wasm-ld         "/usr/bin/wasm-ld-${LLVM_MAJOR}"
    add_alternative_slave_or_defer CLANG_ALT_ARGS /usr/bin/lldb            lldb            "/usr/bin/lldb-${LLVM_MAJOR}"
    add_alternative_slave_or_defer CLANG_ALT_ARGS /usr/bin/llvm-ar         llvm-ar         "/usr/bin/llvm-ar-${LLVM_MAJOR}"
    add_alternative_slave_or_defer CLANG_ALT_ARGS /usr/bin/llvm-nm         llvm-nm         "/usr/bin/llvm-nm-${LLVM_MAJOR}"
    add_alternative_slave_or_defer CLANG_ALT_ARGS /usr/bin/llvm-ranlib     llvm-ranlib     "/usr/bin/llvm-ranlib-${LLVM_MAJOR}"
    add_alternative_slave_or_defer CLANG_ALT_ARGS /usr/bin/llvm-objdump    llvm-objdump    "/usr/bin/llvm-objdump-${LLVM_MAJOR}"
    add_alternative_slave_or_defer CLANG_ALT_ARGS /usr/bin/llvm-readelf    llvm-readelf    "/usr/bin/llvm-readelf-${LLVM_MAJOR}"
    add_alternative_slave_or_defer CLANG_ALT_ARGS /usr/bin/llvm-strip      llvm-strip      "/usr/bin/llvm-strip-${LLVM_MAJOR}"
    add_alternative_slave_or_defer CLANG_ALT_ARGS /usr/bin/llvm-config     llvm-config     "/usr/bin/llvm-config-${LLVM_MAJOR}"
    add_alternative_slave_or_defer CLANG_ALT_ARGS /usr/bin/llvm-cov        llvm-cov        "/usr/bin/llvm-cov-${LLVM_MAJOR}"
    add_alternative_slave_or_defer CLANG_ALT_ARGS /usr/bin/llvm-profdata   llvm-profdata   "/usr/bin/llvm-profdata-${LLVM_MAJOR}"
    add_alternative_slave_or_defer CLANG_ALT_ARGS /usr/bin/llvm-symbolizer llvm-symbolizer "/usr/bin/llvm-symbolizer-${LLVM_MAJOR}"
    add_alternative_slave_or_defer CLANG_ALT_ARGS /usr/bin/llvm-size       llvm-size       "/usr/bin/llvm-size-${LLVM_MAJOR}"
    add_alternative_slave_or_defer CLANG_ALT_ARGS /usr/bin/llvm-strings    llvm-strings    "/usr/bin/llvm-strings-${LLVM_MAJOR}"

    "${SUDO[@]}" update-alternatives "${CLANG_ALT_ARGS[@]}"
    "${SUDO[@]}" update-alternatives --set clang "$CLANG_BIN"
    install_deferred_alternatives "$LLVM_PRIORITY"
fi

# -----------------------------
# Optional Clang cleanup
# -----------------------------

if [[ "$REMOVE_OLD_CLANG_TOOLS" == "1" ]]; then
    log "Removing older versioned Clang-family tool packages"

    mapfile -t OLD_CLANG_TOOL_PACKAGES < <(
        installed_package_names_matching '^(clang|clangd|clang-format|clang-tidy|clang-tools|lld|lldb)-[0-9]+(:[[:alnum:]][[:alnum:].+-]*)?$' \
            | grep -Ev -- "-${LLVM_MAJOR}(:[[:alnum:]][[:alnum:].+-]*)?$" || true
    )

    if (( ${#OLD_CLANG_TOOL_PACKAGES[@]} > 0 )); then
        printf 'Purging packages:\n'
        printf '  %s\n' "${OLD_CLANG_TOOL_PACKAGES[@]}"
        "${SUDO[@]}" apt-get purge -y "${OLD_CLANG_TOOL_PACKAGES[@]}"
        "${SUDO[@]}" apt-get autoremove -y
    else
        log "No older Clang-family tool packages found"
    fi
else
    log "Keeping older Clang-family tool packages. Set REMOVE_OLD_CLANG_TOOLS=1 to purge them."
fi

# -----------------------------
# Verification
# -----------------------------

hash -r 2>/dev/null || true

log "Verifying compiler/tool installation"

if [[ "$INSTALL_ONLY" != "1" ]]; then
    verify_command_resolution gcc "$GCC_BIN"
    verify_command_resolution g++ "$GXX_BIN"
    verify_command_resolution clang "$CLANG_BIN"
    verify_command_resolution clang++ "/usr/bin/clang++-${LLVM_MAJOR}"

    if [[ "$SET_CC_CXX_TO_GCC" == "1" ]]; then
        verify_command_resolution cc "$GCC_BIN"
        verify_command_resolution c++ "$GXX_BIN"
    fi
else
    log "INSTALL_ONLY=1: skipping unversioned command-resolution checks"
fi

reject_experimental_gcc "$GCC_BIN"

for tool in gcc g++ cc c++ cpp clang clang++ clangd clang-format clang-tidy lld ld.lld lldb llvm-ar llvm-nm llvm-ranlib llvm-objdump llvm-readelf llvm-config; do
    print_version_if_available "$tool"
done

if [[ "$INSTALL_ONLY" != "1" && "$COMMAND_LINK_MODE" == "alternatives" ]]; then
    printf '\n'
    log "Relevant update-alternatives selections"

    for alt in gcc clang cc c++ cpp g++ modern-toolchain-cpp modern-toolchain-g++; do
        if update-alternatives --query "$alt" >/dev/null 2>&1; then
            printf '\n[%s]\n' "$alt"
            update-alternatives --query "$alt" 2>/dev/null | sed -n '1,14p' || true
        fi
    done
elif [[ "$INSTALL_ONLY" != "1" && "$COMMAND_LINK_MODE" == "local" ]]; then
    printf '\n'
    log "Managed local command links"
    for tool in gcc g++ cc c++ clang clang++ clangd clang-format clang-tidy lld lldb llvm-ar llvm-config; do
        if [[ -L "${LOCAL_COMMAND_DIR}/${tool}" ]]; then
            printf '  %s -> %s\n' "${LOCAL_COMMAND_DIR}/${tool}" "$(readlink "${LOCAL_COMMAND_DIR}/${tool}")"
        fi
    done
fi

if [[ "$GCC_MODE" == "gnu-release" ]]; then
    printf '\nGNU GCC current symlink:\n'
    printf '  %s -> %s\n' "$GCC_CURRENT_LINK" "$(readlink -f "$GCC_CURRENT_LINK" 2>/dev/null || true)"
fi

log "Done"
