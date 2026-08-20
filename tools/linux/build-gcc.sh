#!/usr/bin/env bash

set -Eeuo pipefail

readonly expected_revision="ced2ae7f6670c0371e0464e5aaa888c44ebd012a"
readonly expected_tree="57f5cc6c172e3e3e08a66c4f1efcf032c84c0b65"

root=""
jobs="20"
expected_glibc=""

fail() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}

usage() {
    cat <<'EOF'
Usage: build-gcc.sh --root PATH --expected-glibc VERSION [--jobs N]

Build the exact Move GCC 16.2.0 move.1 source already cloned at ROOT/source.
The source checkout must be clean at the pinned revision and tree. The script
creates ROOT/build and ROOT/install, runs a release-checking profiled bootstrap,
and installs the result without changing system compiler selection.
EOF
}

while (( $# > 0 )); do
    case "$1" in
        --root)
            (( $# >= 2 )) || fail "--root requires a value"
            root="$2"
            shift 2
            ;;
        --expected-glibc)
            (( $# >= 2 )) || fail "--expected-glibc requires a value"
            expected_glibc="$2"
            shift 2
            ;;
        --jobs)
            (( $# >= 2 )) || fail "--jobs requires a value"
            jobs="$2"
            shift 2
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            fail "unknown argument: $1"
            ;;
    esac
done

[[ -n "$root" && "$root" == /* ]] || fail "--root must be an absolute path"
[[ "$jobs" =~ ^[1-9][0-9]*$ ]] && (( jobs <= 64 )) \
    || fail "--jobs must be an integer from 1 through 64"
[[ "$expected_glibc" =~ ^[0-9]+\.[0-9]+$ ]] \
    || fail "--expected-glibc must be a major.minor version"

for command_name in gcc g++ git make getconf readelf sha256sum; do
    command -v "$command_name" >/dev/null \
        || fail "required command is missing: $command_name"
done

actual_glibc="$(getconf GNU_LIBC_VERSION)"
[[ "$actual_glibc" == "glibc ${expected_glibc}" ]] \
    || fail "builder glibc mismatch: expected ${expected_glibc}, observed ${actual_glibc}"

source_root="${root}/source"
build_root="${root}/build"
install_root="${root}/install"
log_file="${root}/build.log"

[[ -d "${source_root}/.git" ]] || fail "source checkout is absent: ${source_root}"
[[ "$(git -C "$source_root" rev-parse HEAD)" == "$expected_revision" ]] \
    || fail "source revision does not match the Move GCC 16.2 release"
[[ "$(git -C "$source_root" write-tree)" == "$expected_tree" ]] \
    || fail "source tree does not match the Move GCC 16.2 release"
[[ -z "$(git -C "$source_root" status --porcelain --untracked-files=all)" ]] \
    || fail "source checkout is dirty"

if [[ -e "$build_root" && ! -f "${build_root}/Makefile" ]]; then
    fail "existing build root is not a resumable configured build: ${build_root}"
fi
if [[ -e "$install_root" && ! -d "$install_root" ]]; then
    fail "install root is not a directory: ${install_root}"
fi

mkdir -p "$build_root" "$install_root"
dpkg-query -W -f='${binary:Package}\t${Version}\n' \
    | LC_ALL=C sort > "${root}/builder-packages.txt"

exec > >(tee -a "$log_file") 2>&1

printf 'build_started=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'glibc=%s\n' "$actual_glibc"
printf 'source=%s\n' "$expected_revision"
printf 'tree=%s\n' "$expected_tree"
printf 'bootstrap_cc=%s\n' "$(gcc --version | head -n 1)"

if [[ ! -f "${build_root}/Makefile" ]]; then
    configure_arguments=(
        "--prefix=${install_root}"
        "--build=x86_64-pc-linux-gnu"
        "--host=x86_64-pc-linux-gnu"
        "--target=x86_64-pc-linux-gnu"
        "--enable-bootstrap"
        "--enable-checking=release"
        "--with-arch=x86-64"
        "--with-tune=generic"
        "--enable-languages=c,c++,lto"
        "--enable-lto"
        "--enable-shared"
        "--enable-static"
        "--enable-libatomic"
        "--enable-threads=posix"
        "--enable-tls"
        "--enable-graphite"
        "--enable-libstdcxx-backtrace=yes"
        "--enable-libstdcxx-filesystem-ts"
        "--enable-libstdcxx-time"
        "--enable-libgomp"
        "--disable-multilib"
        "--disable-nls"
        "--disable-werror"
        "--with-system-zlib"
        "--with-pkgversion=Move GCC 16.2.0 move.1"
        "--with-bugurl=https://github.com/move-engine/gcc/issues"
        "--with-boot-ldflags=-static-libstdc++ -static-libgcc"
        "--with-stage1-ldflags=-static-libstdc++ -static-libgcc"
    )
    (
        cd "$build_root"
        CC=/usr/bin/gcc CXX=/usr/bin/g++ \
            "${source_root}/configure" "${configure_arguments[@]}"
    )
fi

make -C "$build_root" -j"$jobs" \
    'BOOT_CFLAGS=-O2 -march=x86-64 -mtune=generic' profiledbootstrap
make -C "$build_root" install

"${install_root}/bin/gcc" --version
"${install_root}/bin/g++" --version
printf 'build_completed=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
