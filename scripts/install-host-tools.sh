#!/usr/bin/env bash
set -euo pipefail
[ "$(uname -s)" = Linux ] || { echo 'Workflow host tools require Linux' >&2; exit 1; }
root=$(cd "$(dirname "$0")/.." && pwd)
destination="$root/.factory-tools"
case "$(uname -m)" in
  x86_64)
    flyarch=x86_64; uvarch=x86_64
    flysum=2f96f16e9ccaf273acb17ef39bd018de4fea8bf4ee905e85de93ca2a723b03fb
    uvsum=d66e96b5f1ca3b99806eee283a8125d33a0bd669e6e6d9bc4ab7ffda63c41bf4 ;;
  aarch64)
    flyarch=arm64; uvarch=aarch64
    flysum=aaa52bbf00405ec5d35d5d7148f261e870a88060f7b90eb028c51930540caaf0
    uvsum=19b7f1f66895261fbaa07f8ea91da0f86337ad4e47efa594e87641c1718ffc52 ;;
  *) exit 1 ;;
esac
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
curl --fail --silent --show-error --location "https://github.com/superfly/flyctl/releases/download/v0.5.10/flyctl_0.5.10_Linux_$flyarch.tar.gz" -o "$stage/fly.tgz"
curl --fail --silent --show-error --location "https://github.com/astral-sh/uv/releases/download/0.12.2/uv-$uvarch-unknown-linux-gnu.tar.gz" -o "$stage/uv.tgz"
printf '%s  %s\n' "$flysum" "$stage/fly.tgz" "$uvsum" "$stage/uv.tgz" | sha256sum -c -
mkdir -p "$destination/bin"
tar -xzf "$stage/fly.tgz" -C "$stage"
tar -xzf "$stage/uv.tgz" -C "$stage"
install -m 755 "$stage/flyctl" "$destination/bin/fly"
install -m 755 "$stage/uv-$uvarch-unknown-linux-gnu/uv" "$destination/bin/uv"
bash "$root/sandbox/install-go.sh" "$destination"
bash "$root/scripts/start-workflows.sh" --check
