#!/usr/bin/env bash
# Captura SÓ a janela do Arco (não a tela inteira), por CGWindowID.
#
# Resolve o problema que tínhamos: screencapture de tela cheia pegava o app
# errado / dependia de foco. Aqui achamos o window id do processo "arco" via
# CoreGraphics (Swift) e capturamos exatamente essa janela com `screencapture -l`.
#
# Uso: ./scripts/capture-window.sh [saida.png]   (default: /tmp/arco-window.png)
# Requer macOS + permissão de Screen Recording pro terminal que roda isto.
set -uo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  echo "capture-window: só roda no macOS"; exit 0
fi

OUT="${1:-/tmp/arco-window.png}"

# Descobre o CGWindowID da maior janela on-screen cujo dono contém "arco".
WID="$(/usr/bin/swift - <<'SWIFT' 2>/dev/null
import CoreGraphics
import Foundation

let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
    exit(1)
}
// Filtra pelo DONO da janela (nome do processo) == arco — NÃO pelo título,
// que pode conter "arco" numa aba de navegador (ex.: o GitHub do projeto).
var best: (id: Int, area: Int)? = nil
for w in list {
    let owner = (w[kCGWindowOwnerName as String] as? String ?? "").lowercased()
    guard owner == "arco" || owner.hasPrefix("arco") else { continue }
    guard let num = w[kCGWindowNumber as String] as? Int else { continue }
    var area = 0
    if let b = w[kCGWindowBounds as String] as? [String: Any],
       let wdt = b["Width"] as? Double, let hgt = b["Height"] as? Double {
        area = Int(wdt * hgt)
    }
    if best == nil || area > best!.area { best = (num, area) }
}
if let b = best { print(b.id) } else { exit(2) }
SWIFT
)"

if [[ -z "${WID:-}" ]]; then
  echo "capture-window: janela do Arco não encontrada (o app está aberto?)" >&2
  exit 1
fi

# -l <id>: captura a janela; -o: sem sombra; -x: silencioso.
screencapture -x -o -l "$WID" "$OUT"
echo "capture-window: salvo em $OUT (window id $WID)"
