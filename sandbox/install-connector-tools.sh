#!/usr/bin/env bash
set -euo pipefail
[ "$(id -u)" = 0 ] || exit 1
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends python3 python3-pip python3-venv curl jq unzip default-jre-headless apktool chromium libcap2-bin
arch=$(uname -m)
case "$arch" in x86_64) goarch=amd64 ;; aarch64) goarch=arm64 ;; *) exit 1 ;; esac
curl --fail --silent --show-error --location "https://go.dev/dl/go1.27.4.linux-$goarch.tar.gz" -o /tmp/factory-go.tgz
curl --fail --silent --show-error --location "https://go.dev/dl/go1.27.4.linux-$goarch.tar.gz.sha256" -o /tmp/factory-go.sha256
printf '%s  /tmp/factory-go.tgz\n' "$(cat /tmp/factory-go.sha256)" | sha256sum -c -
tar -xzf /tmp/factory-go.tgz -C /usr/local
ln -sf /usr/local/go/bin/go /usr/local/bin/go
ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
python3 -m pip install --break-system-packages 'uv==0.10.12'
npm install --global '@anthropic-ai/claude-code@2.1.325'
rm /tmp/factory-go.tgz /tmp/factory-go.sha256
rm -rf /var/lib/apt/lists/*
for tool in go python3 uv node git claude chromium apktool; do command -v "$tool" >/dev/null || exit 1; done
