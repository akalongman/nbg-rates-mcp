#!/usr/bin/env bash
# Renders assets/icon.png (512x512, the Claude Desktop extension icon) from
# assets/icon.svg with librsvg. The PNG is committed, so a build needs no
# renderer; run this after editing the SVG. Needs rsvg-convert and the Noto
# Sans font (Debian and Ubuntu: librsvg2-bin, fonts-noto-core).
set -euo pipefail
cd "$(dirname "$0")/.."
rsvg-convert --width 512 --height 512 --output assets/icon.png assets/icon.svg
echo "rendered assets/icon.png"
