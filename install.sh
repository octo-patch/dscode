#!/bin/sh
# Installs the same self-contained archive users can unpack and run directly.
set -eu
install_dir=${DSCODE_INSTALL_DIR:-"$HOME/.local/share/dscode-app"}
bin_dir=${DSCODE_BIN_DIR:-"$HOME/.local/bin"}
releases=${DSCODE_RELEASES_URL:-https://github.com/qiz029/dscode/releases}
fail() { printf 'DSCODE: %s\n' "$*" >&2; exit 1; }
# System tools by absolute path, never a same-named command earlier on PATH.
tool() { for dir in /usr/bin /bin; do [ -x "$dir/$1" ] && { printf '%s/%s' "$dir" "$1"; return; }; done; fail "Missing system tool: $1"; }
grep=$(tool grep) || exit 1
readlink=$(tool readlink) || exit 1
dirname=$(tool dirname) || exit 1
case "$install_dir" in /*) ;; *) fail 'DSCODE_INSTALL_DIR must be absolute' ;; esac
case "$bin_dir" in /*) ;; *) fail 'DSCODE_BIN_DIR must be absolute' ;; esac
[ "$#" -le 1 ] || fail 'Usage: install.sh [exact-version]'
version=${1:-latest}
if [ "$version" != latest ]; then
  printf '%s\n' "$version" | "$grep" -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9._-]+)?$' || fail 'Expected an exact version'
fi
# Never replace a source/npm/Homebrew command that happens to have the same name.
if [ -e "$bin_dir/dscode" ] || [ -L "$bin_dir/dscode" ]; then
  [ -L "$bin_dir/dscode" ] && [ "$("$readlink" "$bin_dir/dscode")" = "$install_dir/dscode" ] || fail "Command belongs to another installation: $bin_dir/dscode. Choose DSCODE_BIN_DIR or remove that old link explicitly."
fi
repair_dir=''
if [ -e "$install_dir" ] || [ -L "$install_dir" ]; then
  [ -f "$install_dir/.dscode-standalone.json" ] || fail "Existing directory is not a self-contained installation: $install_dir"
  if [ "$("$install_dir/dscode" --version)" = 0.7.41 ] && [ "$version" != 0.7.41 ]; then
    repair_dir=$install_dir
  else
    exec "$install_dir/dscode" update "$version"
  fi
fi
source_dir=''
if [ -f "$0" ]; then
  candidate=$(CDPATH= cd -- "$("$dirname" -- "$0")" && pwd)
  if [ -f "$candidate/.dscode-standalone.json" ]; then source_dir=$candidate; fi
fi
work=$(mktemp -d "${TMPDIR:-/tmp}/dscode-install.XXXXXX")
stage=''
lock=''
cleanup() { rm -rf "$work"; [ -z "$stage" ] || rm -rf "$stage"; [ -z "$lock" ] || rmdir "$lock"; }
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
if [ -z "$source_dir" ]; then
  case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) fail 'Self-contained packages support macOS and Linux only' ;; esac
  case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) fail 'Unsupported architecture' ;; esac
  # The bundled Node and native modules are glibc builds.
  if [ "$os" = linux ] && ! getconf GNU_LIBC_VERSION >/dev/null 2>&1; then fail 'Linux packages require glibc; musl distributions such as Alpine are not supported'; fi
  awk=$(tool awk) || exit 1
  tar=$(tool tar) || exit 1
  if [ -x /usr/bin/shasum ]; then sha256() { /usr/bin/shasum -a 256 "$1"; }; else sha256sum=$(tool sha256sum) || exit 1; sha256() { "$sha256sum" "$1"; }; fi
  if [ "$version" = latest ]; then
    final=$(curl -fsSL -o /dev/null -w '%{url_effective}' "$releases/latest")
    version=${final##*/v}
  fi
  printf '%s\n' "$version" | "$grep" -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9._-]+)?$' || fail 'Could not resolve the release version'
  asset=dscode-$version-$os-$arch-standalone.tar.gz
  printf 'Downloading DSCODE %s…\n' "$version"
  curl -fsSL "$releases/download/v$version/$asset" -o "$work/$asset"
  curl -fsSL "$releases/download/v$version/$asset.sha256" -o "$work/checksum"
  expected=$("$awk" 'NR == 1 { print $1 }' "$work/checksum")
  printf '%s\n' "$expected" | "$grep" -Eq '^[a-f0-9]{64}$' || fail 'Invalid release checksum'
  actual=$(sha256 "$work/$asset" | "$awk" '{ print $1 }')
  [ "$expected" = "$actual" ] || fail 'Package checksum mismatch; nothing was installed'
  "$tar" -tzf "$work/$asset" > "$work/entries"
  if "$grep" -Eq '(^/|(^|/)\.\.(/|$))' "$work/entries"; then fail 'Unsafe package archive paths'; fi
  mkdir "$work/app"
  "$tar" -xzf "$work/$asset" -C "$work/app"
  source_dir=$work/app
fi
[ -f "$source_dir/.dscode-standalone.json" ] && [ -x "$source_dir/dscode" ] || fail 'Not a self-contained DSCODE package'
if [ -n "$repair_dir" ]; then
  "$source_dir/dscode" --check
  if [ "$("$source_dir/dscode" --version)" = 0.7.41 ]; then
    "$repair_dir/dscode" update "$version"
  else
    "$source_dir/dscode" --update-installation "$repair_dir" "$version"
  fi
  exit
fi
parent=$("$dirname" -- "$install_dir")
mkdir -p "$parent" "$bin_dir"
mkdir "$install_dir.install-lock" || fail 'Another installation is in progress'
lock=$install_dir.install-lock
[ ! -e "$install_dir" ] && [ ! -L "$install_dir" ] || fail 'Installation appeared concurrently; retry'
stage=$(mktemp -d "$parent/.dscode-install.XXXXXX")
cp -R "$source_dir/." "$stage/"
"$stage/dscode" --check
if [ "$version" != latest ]; then
  [ "$("$stage/dscode" --version)" = "$version" ] || fail 'Package version does not match the requested release'
fi
mv "$stage" "$install_dir"
stage=''
ln -s "$install_dir/dscode" "$bin_dir/dscode" || fail "Package installed at $install_dir; could not create command link"
printf 'Installed: %s/dscode\nData: %s\n' "$bin_dir" "${DSCODE_HOME:-$HOME/.local/share/dscode-state}"
case ":$PATH:" in *":$bin_dir:"*) ;; *) printf 'Add %s to PATH.\n' "$bin_dir" ;; esac
