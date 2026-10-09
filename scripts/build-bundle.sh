#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p "require('./package.json').version")
rm -rf bundle
mkdir -p bundle
npm run build
cp -r dist assets package.json package-lock.json README.md LICENSE CHANGELOG.md manifest.json .mcpbignore bundle/
(cd bundle && npm ci --omit=dev --ignore-scripts)
npx --no-install mcpb validate bundle/manifest.json
npx --no-install mcpb pack bundle "nbg-rates-mcp-${version}.mcpb"
echo "built nbg-rates-mcp-${version}.mcpb"
