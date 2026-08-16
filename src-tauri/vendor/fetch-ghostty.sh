#!/usr/bin/env bash
# Baixa o GhosttyKit.xcframework pré-buildado (libghostty) e extrai só o slice
# macOS em src-tauri/vendor/GhosttyKit.xcframework.
#
# O binário NÃO é versionado (é grande, ~39MB). Este script o reconstrói de
# forma determinística: URL + checksum pinados — a mesma garantia que o SPM
# binaryTarget oferece. Rode-o uma vez antes do primeiro build no macOS:
#
#   ./src-tauri/vendor/fetch-ghostty.sh
#
# Só faz sentido no macOS; em outras plataformas o backend Ghostty não é usado.
set -euo pipefail

# Fonte: https://github.com/Lakr233/libghostty-spm (Package.swift binaryTarget)
URL="https://github.com/Lakr233/libghostty-spm/releases/download/storage.1.2.5/GhosttyKit.xcframework.zip"
SHA256="19518d79dc53b09e9acfc4d8a6bfb1cc8f5d49b8f002df661e7cd17f06e15cde"

VENDOR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$VENDOR_DIR/GhosttyKit.xcframework"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "fetch-ghostty: pulo (libghostty só é usado no macOS)."
  exit 0
fi

if [[ -d "$DEST/macos-arm64_x86_64" ]]; then
  echo "fetch-ghostty: já presente em $DEST — nada a fazer."
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "fetch-ghostty: baixando $URL"
curl -fsSL -o "$TMP/GhosttyKit.xcframework.zip" "$URL"

echo "fetch-ghostty: validando checksum"
ACTUAL="$(shasum -a 256 "$TMP/GhosttyKit.xcframework.zip" | awk '{print $1}')"
if [[ "$ACTUAL" != "$SHA256" ]]; then
  echo "fetch-ghostty: ERRO de checksum!" >&2
  echo "  esperado: $SHA256" >&2
  echo "  obtido:   $ACTUAL" >&2
  exit 1
fi

echo "fetch-ghostty: extraindo"
unzip -q "$TMP/GhosttyKit.xcframework.zip" -d "$TMP/extracted"
rm -rf "$DEST"
mv "$TMP/extracted/GhosttyKit.xcframework" "$DEST"

# Mantemos só o slice macOS — o Arco é macOS desktop. iOS/maccatalyst/sim
# são removidos para não inflar o checkout local.
( cd "$DEST" && rm -rf ios-arm64 ios-arm64_x86_64-simulator ios-arm64_x86_64-maccatalyst )

echo "fetch-ghostty: pronto em $DEST"
