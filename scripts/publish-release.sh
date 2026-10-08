#!/usr/bin/env bash
# Idempotent release steps: each checks whether its target already has this
# version before acting, so a release job that failed halfway can be re-run
# from the top (npm refuses to publish an existing version twice).
# Usage: scripts/publish-release.sh <npm|github|registry> <version>
set -euo pipefail
cd "$(dirname "$0")/.."

usage='usage: scripts/publish-release.sh <npm|github|registry> <version>'
step=${1:?$usage}
version=${2:?$usage}
package=nbg-rates-mcp
server=io.github.akalongman/nbg-rates

publish_npm() {
    if [ "$(npm view "$package@$version" version 2> /dev/null || true)" = "$version" ]; then
        echo "$package@$version is already on npm"
        return
    fi
    npm publish --access public
}

publish_github() {
    if gh release view "v$version" > /dev/null 2>&1; then
        echo "GitHub release v$version already exists"
        return
    fi
    gh release create "v$version" "$package-$version.mcpb" --title "v$version" --notes-file CHANGELOG.md
}

publish_registry() {
    local status os arch
    status=$(curl -s -o /dev/null -w '%{http_code}' \
        "https://registry.modelcontextprotocol.io/v0.1/servers/${server/\//%2F}/versions/$version")
    if [ "$status" = 200 ]; then
        echo "the MCP registry already lists $server $version"
        return
    fi
    os=$(uname -s | tr '[:upper:]' '[:lower:]')
    arch=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
    curl -sSL "https://github.com/modelcontextprotocol/registry/releases/download/v1.8.1/mcp-publisher_${os}_${arch}.tar.gz" |
        tar xz mcp-publisher
    ./mcp-publisher login github-oidc
    ./mcp-publisher publish
}

case "$step" in
    npm) publish_npm ;;
    github) publish_github ;;
    registry) publish_registry ;;
    *)
        echo "$usage" >&2
        exit 2
        ;;
esac
