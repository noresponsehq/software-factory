#!/usr/bin/env bash
set -euo pipefail
destination=${1:?installation directory required}
case "$(uname -m)" in
  x86_64) arch=amd64; checksum=7226736c2339719cda28fbf3a54d71aa63bcefe376e98cef00034268dab24840 ;;
  aarch64) arch=arm64; checksum=3392582988a273a87ab5043ee1b2c9c17a2c3c00580bf9326c47a2e0aaaeac92 ;;
  *) echo 'Go installation requires Linux amd64 or arm64' >&2; exit 1 ;;
esac
[ "$(uname -s)" = Linux ] || exit 1
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
curl --fail --silent --show-error --location "https://go.dev/dl/go1.27.4.linux-$arch.tar.gz" -o "$stage/go.tgz"
printf '%s  %s\n' "$checksum" "$stage/go.tgz" | sha256sum -c -
mkdir -p "$destination"
tar -xzf "$stage/go.tgz" -C "$destination"
"$destination/go/bin/go" version
