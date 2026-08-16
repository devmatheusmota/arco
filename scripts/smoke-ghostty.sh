#!/usr/bin/env bash
# Smoke test do backend nativo Ghostty no app real (macOS).
#
# Substitui o ciclo manual de "subir o app → screenshot → adivinhar". Liga a
# flag nativeTerminalMacos, sobe o app em dev, e espera os sinais de sucesso no
# log:
#   - "[arco-ghostty] surface criada"   → surface real criada
# Falha (exit 1) se aparecer panic / "surface_new FALHOU" / timeout.
#
# Uso: ./scripts/smoke-ghostty.sh
# Requer: vendor/GhosttyKit.xcframework (rode vendor/fetch-ghostty.sh antes).
set -uo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  echo "smoke-ghostty: só roda no macOS"; exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROFILE_JSON="$HOME/Library/Application Support/com.mota.arco/profiles/default/projects.json"
LOG="$(mktemp)"
TIMEOUT=180

cleanup() {
  [[ -n "${APP_PID:-}" ]] && kill "$APP_PID" 2>/dev/null
  pkill -f "target/debug/arco" 2>/dev/null
  pkill -f "tauri dev" 2>/dev/null
}
trap cleanup EXIT

# Mata instâncias órfãs que segurariam a porta do dev server (1422) — senão o
# tauri dev aborta com "Port already in use" e o smoke falha por ruído.
echo "smoke: limpando instâncias anteriores..."
lsof -ti:1422 2>/dev/null | xargs kill -9 2>/dev/null
pkill -9 -f "target/debug/arco" 2>/dev/null
pkill -9 -f "tauri dev" 2>/dev/null
sleep 1

# Liga a flag (se houver projeto/perfil). Sem o JSON, o app criará um na 1ª run;
# nesse caso o smoke ainda valida que o app sobe sem crash.
if [[ -f "$PROFILE_JSON" ]]; then
  node -e '
    const fs=require("fs");const f=process.argv[1];
    const j=JSON.parse(fs.readFileSync(f,"utf8"));
    j.preferences=j.preferences||{};
    j.preferences.nativeTerminalMacos=true;
    // Garante que o app NÃO abra na Home, senão nenhum pane (e nenhuma surface) monta.
    j.preferences.alwaysStartOnHome=false;
    // Garante um container aberto com um pane visível do projeto ativo — é o que
    // faz o TerminalPane (e portanto o GhosttySurface) montar. Sem isso a
    // workspace fica vazia e o smoke daria timeout sem nada errado no backend.
    const proj = (j.projects||[]).find(p=>p.id===j.activeProjectId && (p.terminals||[]).length>0)
              || (j.projects||[]).find(p=>(p.terminals||[]).length>0);
    if (proj) {
      proj.terminals.forEach(t=>{ t.disabled=false; });
      j.activeProjectId = proj.id;
      j.workspace = j.workspace || {containers:[],recentProjectIds:[],recentTabs:[]};
      j.workspace.containers = [{
        projectId: proj.id,
        paneIds: proj.terminals.map(t=>t.id),
        size: 0, internalLayout: proj.layoutMode||"auto", collapsed:false, lastUsedAt: 1,
      }];
      console.error("smoke: container aberto p/ projeto", JSON.stringify(proj.name));
    } else {
      console.error("smoke: AVISO nenhum projeto com terminal — crie um antes");
    }
    fs.writeFileSync(f,JSON.stringify(j,null,2));
  ' "$PROFILE_JSON" && echo "smoke: estado preparado (flag + container aberto)"
fi

echo "smoke: subindo o app (tauri dev) com auto-probe de input..."
# ARCO_GHOSTTY_PROBE=1: após a surface estabilizar, o backend digita um echo
# e lê o grid de volta — prova o fluxo input→shell→render no app REAL.
ARCO_GHOSTTY_PROBE=1 ./node_modules/.bin/tauri dev >"$LOG" 2>&1 &
APP_PID=$!

deadline=$((SECONDS + TIMEOUT))
status="timeout"
while (( SECONDS < deadline )); do
  # Sucesso forte: o echo digitado apareceu na tela do terminal real.
  if grep -q "PROBE echo_visivel=true" "$LOG"; then status="ok"; break; fi
  if grep -qE "PROBE echo_visivel=false|PROBE erro" "$LOG"; then status="probe_fail"; break; fi
  if grep -qE "surface_new FALHOU|panicked|Segmentation|abort\(\)" "$LOG"; then status="fail"; break; fi
  if ! kill -0 "$APP_PID" 2>/dev/null; then status="died"; break; fi
  sleep 2
done

echo "----- linhas relevantes do log -----"
grep -E "surface criada|PROBE" "$LOG" | tail -8
echo "------------------------------------"

case "$status" in
  ok)         echo "✅ smoke OK: terminal Ghostty vivo — echo digitado apareceu na tela (input→shell→render)"; exit 0 ;;
  probe_fail) echo "❌ smoke FALHOU: surface criada mas o echo não chegou/renderizou (input ou render quebrado)"; exit 1 ;;
  fail)       echo "❌ smoke FALHOU: surface_new falhou ou panic"; exit 1 ;;
  died)       echo "❌ smoke FALHOU: app morreu sem provar o terminal"; exit 1 ;;
  timeout)    echo "❌ smoke FALHOU: timeout (${TIMEOUT}s). Pane nativo pode não ter sido exibido."; exit 1 ;;
esac
