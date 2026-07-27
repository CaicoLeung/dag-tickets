#!/bin/sh
# dag-tickets installer — curl|sh bootstrap.
# Downloads the prebuilt binary for the host platform from the latest GitHub
# Release, verifies its SHA256 against the published SHA256SUMS, and installs
# it to ~/.dag-tickets/bin. POSIX sh, no bashisms.
set -eu

REPO="CaicoLeung/dag-tickets"
INSTALL_DIR="${DAG_TICKETS_HOME:-$HOME/.dag-tickets}/bin"

fail() {
  echo "dag-tickets: $*" >&2
  exit 1
}

# --- platform detection -------------------------------------------------------
os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) os=darwin ;;
  Linux)  os=linux ;;
  *) fail "unsupported OS '$os'. Prebuilt binaries: darwin, linux. See https://github.com/$REPO/releases" ;;
esac
case "$arch" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64)  arch=x64 ;;
  *) fail "unsupported arch '$arch'. Prebuilt binaries: arm64, x64. See https://github.com/$REPO/releases" ;;
esac
target="$os-$arch"

# --- prerequisites ------------------------------------------------------------
need() { command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"; }
need curl
need tar
if command -v sha256sum >/dev/null 2>&1; then sha_cmd="sha256sum"
elif command -v shasum >/dev/null 2>&1; then sha_cmd="shasum -a 256"
else fail "no sha256 tool found (need sha256sum or shasum)"; fi

# --- resolve latest release tag ----------------------------------------------
tag=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep -m1 '"tag_name"' \
  | sed -E 's/.*"tag_name"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')
[ -n "$tag" ] || fail "could not resolve latest release tag from the GitHub API"

version=${tag#v}
asset="dag-tickets-$target.tar.gz"
base_url="https://github.com/$REPO/releases/download/$tag"

echo "==> dag-tickets $version ($target)"

# --- download + verify --------------------------------------------------------
tmp=$(mktemp -d 2>/dev/null || mktemp -d -t dag-tickets)
trap 'rm -rf "$tmp"' EXIT

echo "==> downloading $asset"
curl -fsSL "$base_url/$asset"          -o "$tmp/$asset"
curl -fsSL "$base_url/SHA256SUMS"      -o "$tmp/SHA256SUMS"

echo "==> verifying sha256"
actual=$($sha_cmd "$tmp/$asset" | awk '{print $1}')
expected=$(awk -v t="$asset" '$2==t {print $1}' "$tmp/SHA256SUMS")
[ -n "$expected" ] || fail "no checksum for $asset in SHA256SUMS"
[ "$actual" = "$expected" ] || fail "checksum mismatch (expected $expected, got $actual)"

# --- install ------------------------------------------------------------------
mkdir -p "$INSTALL_DIR"
tar -xzf "$tmp/$asset" -C "$INSTALL_DIR"
chmod 755 "$INSTALL_DIR/dag-tickets"

echo
echo "==> installed dag-tickets to $INSTALL_DIR/dag-tickets"
"$INSTALL_DIR/dag-tickets" --version

# --- PATH hint ----------------------------------------------------------------
case ${SHELL:-} in
  */fish)
    rc="$HOME/.config/fish/config.fish"
    line="fish_add_path -g \"$INSTALL_DIR\""
    ;;
  */zsh)
    rc="$HOME/.zshrc"
    line="export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
  *)
    rc="$HOME/.bashrc"
    line="export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac
bin_in_path=0
case ":$PATH:" in
  *":$INSTALL_DIR:"*) bin_in_path=1 ;;
esac
if [ "$bin_in_path" = 1 ]; then
  echo "==> $INSTALL_DIR is already on PATH. Run: dag-tickets --help"
else
  echo
  echo "    $INSTALL_DIR is not on your PATH. Add this line to $rc:"
  echo
  echo "      $line"
  echo
  echo "    Then start a new shell and run: dag-tickets --help"
fi
