#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script requires macOS because it uses sips, iconutil, and AppKit." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_SVG="$REPO_ROOT/public/logo.svg"
ICONS_DIR="$REPO_ROOT/src-tauri/icons"
IOS_DIR="$ICONS_DIR/ios"
SWIFT_SCRIPT="$REPO_ROOT/dev/generate-apple-icons.swift"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/macro-apple-icons.XXXXXX")"
TRANSPARENT_MASTER="$TMP_DIR/logo-master.png"
MAC_MASTER="$TMP_DIR/apple-macos-master.png"
IOS_MASTER="$TMP_DIR/apple-ios-master.png"
ICONSET_DIR="$TMP_DIR/icon.iconset"

cleanup() {
  rm -rf "$TMP_DIR"
}

trap cleanup EXIT

resize_png() {
  local input="$1"
  local size="$2"
  local output="$3"

  sips -z "$size" "$size" "$input" --out "$output" >/dev/null
}

echo "Rendering logo master from SVG..."
sips -s format png -z 1024 1024 "$SOURCE_SVG" --out "$TRANSPARENT_MASTER" >/dev/null

echo "Composing Apple masters..."
xcrun swift "$SWIFT_SCRIPT" "$TRANSPARENT_MASTER" "$MAC_MASTER" "$IOS_MASTER"

echo "Building macOS icon.icns..."
mkdir -p "$ICONSET_DIR"
resize_png "$MAC_MASTER" 16 "$ICONSET_DIR/icon_16x16.png"
resize_png "$MAC_MASTER" 32 "$ICONSET_DIR/icon_16x16@2x.png"
resize_png "$MAC_MASTER" 32 "$ICONSET_DIR/icon_32x32.png"
resize_png "$MAC_MASTER" 64 "$ICONSET_DIR/icon_32x32@2x.png"
resize_png "$MAC_MASTER" 128 "$ICONSET_DIR/icon_128x128.png"
resize_png "$MAC_MASTER" 256 "$ICONSET_DIR/icon_128x128@2x.png"
resize_png "$MAC_MASTER" 256 "$ICONSET_DIR/icon_256x256.png"
resize_png "$MAC_MASTER" 512 "$ICONSET_DIR/icon_256x256@2x.png"
resize_png "$MAC_MASTER" 512 "$ICONSET_DIR/icon_512x512.png"
cp "$MAC_MASTER" "$ICONSET_DIR/icon_512x512@2x.png"
iconutil -c icns "$ICONSET_DIR" -o "$ICONS_DIR/icon.icns"

echo "Building iOS AppIcon PNGs..."
mkdir -p "$IOS_DIR"

while IFS=: read -r size filename; do
  resize_png "$IOS_MASTER" "$size" "$IOS_DIR/$filename"
done <<'EOF'
20:AppIcon-20x20@1x.png
40:AppIcon-20x20@2x-1.png
40:AppIcon-20x20@2x.png
60:AppIcon-20x20@3x.png
29:AppIcon-29x29@1x.png
58:AppIcon-29x29@2x-1.png
58:AppIcon-29x29@2x.png
87:AppIcon-29x29@3x.png
40:AppIcon-40x40@1x.png
80:AppIcon-40x40@2x-1.png
80:AppIcon-40x40@2x.png
120:AppIcon-40x40@3x.png
120:AppIcon-60x60@2x.png
180:AppIcon-60x60@3x.png
76:AppIcon-76x76@1x.png
152:AppIcon-76x76@2x.png
167:AppIcon-83.5x83.5@2x.png
1024:AppIcon-512@2x.png
EOF

echo "Apple icons updated:"
echo "  - $ICONS_DIR/icon.icns"
echo "  - $IOS_DIR/AppIcon-*.png"
