#!/usr/bin/env bash
# Builds "Palco Helper.app" (computer use + on-device summaries). macOS only; skipped elsewhere.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ "$(uname)" = "Darwin" ] || { echo "helper: só no macOS, pulando"; exit 0; }
command -v swiftc >/dev/null || { echo "helper: swiftc ausente (xcode-select --install); computer use e Ombro ficam desligados"; exit 0; }
APP="$ROOT/dist/Palco Helper.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$ROOT/native/Info.plist" "$APP/Contents/Info.plist"
swiftc -O -o "$APP/Contents/MacOS/palco-helper" "$ROOT/native/PalcoHelper.swift"
# Ad-hoc signature: macOS ties the Accessibility grant to this build, so a rebuild asks for it again.
codesign --force --sign - --identifier app.palco.helper "$APP" >/dev/null 2>&1 || true
echo "helper: $APP"
