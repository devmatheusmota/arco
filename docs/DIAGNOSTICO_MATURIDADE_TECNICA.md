# Diagnóstico de Maturidade Técnica — Arco

> Documento de diagnóstico, não de execução. Cada achado tem file:line, evidência concreta e uma
> recomendação objetiva — mas nenhuma correção foi aplicada. Priorização e sequenciamento ficam a
> critério do dono do projeto. Gerado por análise assistida (6 varreduras read-only do código-fonte
> em 2026-08-06), usando como referência práticas de engenharia sênior/Staff/Principal (organização
> modular, limites de domínio, testes de comportamento, ADRs, DORA, anti-padrões conhecidos).

## 1. Resumo executivo

| # | Achado | Área | Impacto |
|---|---|---|---|
| 1 | `projectsStore.ts` é um god-object de 3080 linhas cobrindo 8+ domínios distintos + persistência embutida | Frontend | Alto |
| 2 | Cobertura de teste do frontend é ~9% (12/134 arquivos) e é **zero** em componentes, stores e hooks | Frontend | Alto |
| 3 | ~600-700 linhas duplicadas no frontend: polling por provider, cards de uso, caches, boilerplate de modal | Frontend | Médio-Alto |
| 4 | ~150-200 linhas duplicadas no backend: resolução de paths, parse JSONL, `now_ms()` reimplementado 8x | Backend | Médio |
| 5 | 48% dos módulos Rust (24/50) não têm nenhum teste, incluindo `cli_resolver.rs`, `profiles.rs`, `diagnostics.rs` | Backend | Médio-Alto |
| 6 | `CLAUDE.md`/`AGENTS.md` referenciam 5 arquivos e uma estrutura de repo que não existem mais | Governança | Alto (contexto de IA fica errado) |
| 7 | Sem ADR/RFC formal no repo, apesar de decisões nomeadas (`RFC-003/004/006/007`) existirem só em comentários | Governança | Médio |
| 8 | Seletores Zustand amplos em `WorkspaceView`/`ProjectSidebar`/`HomeView` causam re-render em qualquer mutação do app | Performance | Médio |
| 9 | Toda mutação no `projectsStore` serializa a árvore inteira do app (sem delta parcial) | Performance | Médio |
| 10 | `GhosttySurface` faz polling de IPC a 700ms por pane nativo aberto — o mais agressivo do app | Performance | Baixo-Médio |

---

## 2. Estrutura e organização

### 2.1 Frontend (`src/`)

**`projectsStore.ts` — god-object confirmado (`src/stores/projectsStore.ts`, 3080 linhas).**
É ~5x maior que a segunda maior store (`mergeStore.ts`, 561 linhas). Um único
`create<ProjectsState>` expõe ação/estado para pelo menos 8 domínios distintos na mesma interface:

- Perfis (`activeProfileId`, `profiles`, `hydrate`)
- CRUD de grupos (`createGroup`, `moveGroupToParent`, `suspendGroup`, `deleteGroup`, …)
- CRUD de projetos (`createProject`, `setWorktreeMode`, `setValidationCommands`, …)
- Navegação de workspace/tabs (`openProjectWorkspace`, `navigateWorkspaceHistory`, …)
- Layout/grid (`setLayoutMode`, `setProjectGridLayout`, `setWorkspaceGridLayout`)
- CRUD de todos (`createTodo`, `toggleTodo`, `reorderTodo`, …)
- Ciclo de vida de terminal/pane/sub-tab (`createTerminal`, `openPane`, `createSubTab`, …)
- Preferências do app (`setLanguage`, `setUiTheme`, `setCliPath`, …)

Além disso mistura **persistência com estado de UI**: a própria store chama `saveProjectsFile`
com um timer de debounce module-level (`src/stores/projectsStore.ts:283-316`) — serialização em
disco convive no mesmo arquivo com ações como `setFullscreenPane`. Por contraste, `uiStore.ts`
(187 linhas) tem um comentário explícito dizendo que nada ali é persistido e que "tudo persistente
vai pro `projectsStore`" (`src/stores/uiStore.ts:6-9`) — o que confirma que o crescimento do
`projectsStore` é uma decisão arquitetural deliberada (ele é o único dono de estado persistido),
só que sem quebra em slices por domínio.

**Recomendação:** dividir em stores por domínio (`useProfilesStore`, `useGroupsStore`,
`useWorkspaceNavStore`, `useLayoutStore`, `useTodosStore`, `useTerminalsStore`,
`usePreferencesStore`) compostos via um único `persist`/save coordenado, ou manter uma store única
mas com slices Zustand (`create<State>()((...a) => ({ ...profilesSlice(...a), ...groupsSlice(...a) }))`)
para separar por arquivo mantendo uma única fonte de save. Extrair a lógica de `saveProjectsFile`
+ debounce para um módulo `persistence.ts` dedicado.

**`src/lib/` — gaveta de utilitários (49 arquivos flat, sem subpastas exceto `i18n/`).**
Mistura, sem nenhuma fronteira interna: wrapper de IPC (`tauri.ts`, 1135 linhas), tipos de domínio
(`types.ts`, 482 linhas), ciclo de vida de sessão/agente (`sessionDiscovery.ts`, `sessionResume.ts`,
`agentRuntimeAdapter.ts`, `spawnQueue.ts`, …), infra cross-cutting (`closeCoordinator.ts`,
`webglPool.ts`, `storageNamespace.ts`), formatação (`costFormat.ts`, `gridLayout.ts`), integração de
terceiros (`spotify.ts` — que inclusive tem suas próprias chamadas `invoke()` diretas, ver §2.3),
4 caches quase idênticos (ver §3.2), e regras de negócio que arguivelmente pertencem às stores
(`todos.ts`, `workspaceNavigation.ts`).

**Recomendação:** subdividir por domínio: `lib/session/`, `lib/provider-usage/`, `lib/infra/`
(webglPool, closeCoordinator, storageNamespace), `lib/format/`. Não é urgente — cada arquivo
individual é pequeno e focado — mas a ausência de fronteira dificulta descobrir o que já existe
antes de duplicar (ver §3.2, os 4 arquivos de cache são o sintoma direto disso).

**Componentes grandes com múltiplas responsabilidades concentradas em um arquivo:**

| Componente | Linhas | Observação |
|---|---|---|
| `AgentCanvasPOC/index.tsx` | 1765 | Canvas + drag-drop (`@dnd-kit`) + `invoke()` direto (bypass de `tauri.ts`) + custo/uso |
| `XTermView/index.tsx` | 1719 | Renderização de terminal + lifecycle de PTY + resume/discovery de sessão + WebGL pooling |
| `ProjectSidebar/index.tsx` | 1540 | Árvore + drag-drop + context menu + chamadas git/file-explorer diretas |
| `PreferencesModal.tsx` | 1215 | Modal de configurações único e grande |
| `EditProjectModal.tsx` | 822 | |

**Recomendação:** extrair hooks de responsabilidade única (`useAgentCanvasDragDrop`,
`useTerminalSessionLifecycle`) e sub-componentes, especialmente nos 3 primeiros — não por contagem
de linhas em si, mas porque cada um tem múltiplos motivos de mudança (UI, orquestração de backend,
lógica de domínio local) na mesma unidade.

**Inconsistências estruturais pontuais (baixo impacto, fáceis de padronizar):**
- `src/components/EmptyState/EmptyState.tsx` quebra a convenção `index.tsx` do resto do projeto.
- `src/components/GhosttySurface/index.tsx` não tem `.module.css` companion.
- `src/components/ui/` mistura arquivos `.tsx` em kebab-case (`ascii-effect.tsx`) com CSS modules em
  PascalCase (`AsciiEffect.module.css`) — único lugar do projeto com essa mistura.
- `src/components/modals/` é flat (33 arquivos) e ~6 modais não têm CSS module dedicado enquanto
  outros compartilham `Modal.module.css`/`controls.module.css` de forma inconsistente.

### 2.2 Backend Rust (`src-tauri/src/`)

**`lib.rs` fica enxuto — ponto positivo a destacar.** 387 linhas, registra 155 comandos via
`invoke_handler!` quase todos como `module::function`, só 4 comandos triviais definidos localmente
(`set_window_opacity`, `quit_app`, `ping`). Nenhuma lógica de negócio (git, merge, PTY) vive em
`lib.rs` — ele é puramente composição/bootstrap. Esse é o padrão que um Staff Engineer esperaria de
um command registry e vale manter como referência ao adicionar novos módulos.

**Módulos "god candidate" por tamanho:**

| Módulo | Linhas | Observação |
|---|---|---|
| `pty.rs` | 1518 | Mistura spawn/lifecycle + I/O de scrollback + gate de memória + prioridade de processo em um arquivo |
| `ghostty_bridge.rs` | 1125 | Majoritariamente FFI/stub específico de macOS + bloco de testes grande — menos preocupante do que o tamanho sugere |
| `git_control.rs` | 985 | Grande, mas é módulo-folha limpo (zero `use crate::` internos) — tamanho vem de cobrir muitas operações git primitivas, não de mistura de responsabilidades |
| `graphify.rs` | 939 | Integração RFC-004 (MCP config, parsing de graph.json, versionamento) |

Faixa 500-800 linhas (borderline, não urgente): `conflict_resolution.rs` (771), `worktrees.rs`
(753), `resources.rs` (687), `cli_resolver.rs` (641), `agent_cost.rs` (609), `diagnostics.rs` (546),
`scheduler.rs` (545), `claude_sessions.rs` (542).

**Recomendação:** `pty.rs` é o único caso que justifica split real — separar em
`pty/spawn.rs` (lifecycle), `pty/scrollback.rs` (I/O e compactação, já é uma unidade coesa hoje) e
`pty/memory_gate.rs`. Os demais (`git_control.rs`, `ghostty_bridge.rs`) não precisam de split só por
tamanho — são coesos internamente.

**Acoplamento entre módulos:** análise de `use crate::` nos módulos maiores não encontrou ciclos.
`git_control.rs` tem zero dependências internas (módulo-folha) e é consumido por `worktrees.rs`,
`conflict_resolution.rs`, `graphify.rs` e `pty.rs` — um hub saudável (fan-in sobre um módulo estável
e sem dependências), não uma "zona da dor". `paths.rs`, `stats.rs` e `event_bus.rs` cumprem papel
parecido. Esse é um padrão de acoplamento maduro e não precisa de intervenção.

**Tratamento de erro:** convenção consistente `Result<T, String>` (307 ocorrências em 45/50
arquivos). Sem `thiserror`/`anyhow` no `Cargo.toml`; só 1 enum de erro customizado (`FetchError` em
`antigravity_usage.rs:90`). 467 `.unwrap()` e 102 `.expect(` no total, mas confirmado por amostragem
em `git_control.rs`, `worktrees.rs`, `conflict_resolution.rs` e `planning_gate.rs` que **praticamente
todos** vivem dentro de blocos `#[cfg(test)]` — código de produção usa `?`/`.map_err` de forma
disciplinada. `pty.rs`, por exemplo, tem só 2 `.unwrap()` em produção, ambos em lock de
`Mutex`/`Condvar` (idiom padrão de propagação de poison, não engolimento de erro). **Isso é maduro —
não é um achado de risco, é um ponto forte a preservar** (a única melhoria opcional seria migrar
para `thiserror` se o número de variantes de erro crescer, mas hoje não há sinal de necessidade).

**Sem separação domínio/infra formal.** Lógica pura e I/O (filesystem/processo/rede) convivem nas
mesmas funções — ex.: `pty.rs::spawn_pty` mistura decisão de política (gate de memória, resolução
de launcher) com o spawn bruto do processo, sem uma camada intermediária. Isso é aceitável dado o
tamanho da equipe/produto (não é um serviço distribuído com múltiplos consumidores do domínio), mas
vale registrar como trade-off consciente, não como ausência acidental.

**Nomenclatura:** forte e orientada a domínio (`WorktreeMode`, `ConflictEnv`, `MergeOutcome`,
`ScrollbackBuffer`, `MonitoredAgent`). Busca por `struct \w*(Manager|Handler|Helper|Util)` no
backend inteiro: **zero matches** como identificador real (só aparece em prosa de comentário).

### 2.3 Fronteira `invoke()` (frontend ↔ backend)

Majoritariamente centralizada em `src/lib/tauri.ts` (1135 linhas, ~150 funções tipadas). Dois pontos
de bypass conhecidos, onde `invoke()` é chamado direto, sem passar pelo wrapper:
- `src/lib/spotify.ts:20,24` (`spotify_login`, `spotify_logout`)
- `src/components/AgentCanvasPOC/index.tsx:11,745,820` (`install_agent`, `uninstall_agent`) — o
  único componente do projeto que importa `invoke` diretamente.

**Recomendação:** mover essas 4 chamadas para `lib/tauri.ts` por consistência — baixo esforço, fecha
o único buraco na fronteira.

---

## 3. Código duplicado

### 3.1 Backend Rust

Os módulos paralelos por provider (Claude/Codex/OpenCode/Antigravity) compartilham um esqueleto
quase idêntico — `#[tauri::command] async fn snapshot_X(cwd) → spawn_blocking(|| inner(cwd))` →
resolver diretório do provider → percorrer → parsear JSON/JSONL → filtrar por cwd → ordenar por
`modified_at_ms`. Só o schema por provider muda; o scaffolding é copiado.

**a) Resolução de home dir — idêntica em 3 arquivos:**
```rust
// claude_sessions.rs:41-44 / codex_sessions.rs:17-20 / antigravity_sessions.rs:16-19
let home = env::var_os("USERPROFILE")
    .or_else(|| env::var_os("HOME"))
    .map(PathBuf::from)?;
Some(home.join(".claude").join("projects"))  // só o join final muda por provider
```

**b) `modified_ms` — corpo idêntico em 3 arquivos** (`claude_sessions.rs:61-68`,
`codex_sessions.rs:23-30`, `antigravity_sessions.rs:27-33`).

**c) Normalização de cwd — 3 implementações independentes**, uma em `codex_sessions.rs:32-39`,
copiada em `antigravity_sessions.rs:79-86`, e uma terceira variante (`normalize_path`) em
`opencode_sessions.rs:22-33`.

**d) Comentário de doc + wrapper `spawn_blocking` copiado literalmente** entre
`claude_sessions.rs:172-176`, `codex_sessions.rs:98-102`, `antigravity_sessions.rs:112-116`
(mesmo texto em português sobre por que rodar em `spawn_blocking`), com o mesmo idiom de
`map_err(|error| format!("snapshot_X_sessions: falha na task bloqueante: {error}"))` repetido 3x.

**e) Loop de parse JSONL "ler linha → pular vazia → parse Value ou continue"** repetido 5x
(`claude_sessions.rs` 2x, `agent_cost.rs` 2x, `codex_usage.rs` 1x):
```rust
for line in reader.lines().map_while(Result::ok) {
    if line.is_empty() { continue; }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else { continue; };
```

**f) `now_ms()` (SystemTime → millis) reimplementado independentemente em 8 arquivos:**
`crash_watch.rs:45-50`, `event_bus.rs:57-60`, `github_sync.rs:53-56`, `profiles.rs:55,157,163`,
`planning.rs:149-151`, `projects.rs:31-33`, `resources.rs:165-167`, `supervisor.rs:25-27`,
`graphify.rs:98-100`.

**g) Flag Windows `CREATE_NO_WINDOW` triplicada** — `git_control.rs:36-37` já expõe
`hide_console(&mut Command)` para isso, mas `health_probe.rs:91-92` e `projects.rs:129`
(`clone_github_repo`) reimplementam o mesmo bloco de 5 linhas em vez de chamar a função existente.

**h) Structs paralelas sem base comum:** `UsageWindow` (`claude_usage.rs:10-13`) vs.
`CodexUsageWindow` (`codex_usage.rs:11-16`) — mesmo conceito, campos diferentes; `ModelCost`
(`agent_cost.rs:110-120`) vs. `ModelRate` (`agent_cost.rs:438-446`) — o comentário no próprio código
já admite que é a mesma tabela de preços re-declarada; os 4 `*SessionSnapshot`
(`ClaudeSessionSnapshot`, `CodexSessionSnapshot`, `OpenCodeSessionSnapshot`,
`AntigravitySessionSnapshot`) todos compartilham `id: String` + `modified_at_ms: u128` mais um campo
específico — candidato claro a struct base + extensão por provider.

**Volume estimado: ~150-200 linhas.**

**Recomendação:** criar `src-tauri/src/provider_common.rs` com `provider_home_dir(provider)`,
`file_modified_ms(&Metadata)`, `now_ms()`, um helper de iteração JSONL
(`for_each_jsonl_value(reader, |v| {...})`), e um `SessionSnapshotBase` compartilhado (via
`#[serde(flatten)]` ou composição). Trocar as 2 reimplementações de `CREATE_NO_WINDOW` por chamadas
a `git_control::hide_console`. Isso é um refactor mecânico e de baixo risco — vale nota de que os
módulos de uso (`claude_usage.rs`, `codex_usage.rs`, `antigravity_usage.rs`) divergem muito mais
entre si (OAuth vs. JSON-RPC vs. REST do Google) e **não** devem ser forçados a compartilhar lógica
além do scaffolding básico — a duplicação real ali é ~15-20%, não vale a pena abstrair mais que isso.

### 3.2 Frontend

**Os 4 arquivos de cache — praticamente idênticos byte a byte.**
`src/lib/claudeUsageCache.ts`, `codexUsageCache.ts`, `antigravityUsageCache.ts` (25-26 linhas cada)
e `src/lib/activityCache.ts` (variante com `days` na chave) implementam o mesmo padrão
cached-value + TTL + dedupe de in-flight promise, só trocando o fetcher/tipo/TTL:
```ts
let cached: { value: ClaudeUsage; at: number } | null = null
let inFlight: Promise<ClaudeUsage> | null = null
export function getCachedClaudeUsage(force = false): Promise<ClaudeUsage> {
  const now = Date.now()
  if (!force && cached && now - cached.at < TTL_MS) return Promise.resolve(cached.value)
  if (!force && inFlight) return inFlight
  inFlight = getClaudeUsage().then((value) => { cached = { value, at: Date.now() }; return value })
    .finally(() => { inFlight = null })
  return inFlight
}
```
**Recomendação:** factory `createCache<T>(fetcher, ttlMs)` — colapsa ~100 linhas em 4 arquivos para
~20 linhas de factory + 4 chamadas de 1 linha.

**`TitleBar/index.tsx:122-214` — 3 blocos `useEffect` de polling por provider (~95 linhas).**
Claude/Codex/Antigravity cada um com seu próprio `cancelled`/`setTimeout`+`setInterval`/cleanup,
diferindo só em delay de startup (1500/2500/3000ms) e se chama `observeXReset`.
**Recomendação:** hook `useProviderUsagePolling(getCachedUsage, setUsage, { delayMs, observeReset })`.

**`HomeView/UsageStrip.tsx` — 3 "Cards" de provider (~270 linhas, `ClaudeCard`/`CodexCard`/
`AntigravityCard`, linhas 186-452).** Mesmo esqueleto `CardHead`/`Hero`/`Meter`/`StatGrid`/
`CardFoot`, só campos e copy mudam. Os sub-componentes compartilhados já existem — falta só um
componente genérico `<UsageCard providerConfig={...} usage={...}/>` dirigido por config.

**Boilerplate de color-swatch + reset/hydrate em 4 modais (~120 linhas).** O mesmo bloco inline de
8 linhas de estilo de swatch circular aparece verbatim em `NewGroupModal.tsx:83-90`,
`EditGroupModal.tsx:89-96`, `NewProjectModal.tsx:146-210` (×3 variantes) e
`EditProjectModal.tsx:447-511` (×4 variantes); o padrão `reset()` + hidratação em `useEffect(() => {
if (open && X) {...} }, [open, X])` se repete nos 4 arquivos com formas quase idênticas. (O wrapper
Radix Dialog em si **já está** de-duplicado via `Modal.tsx` — só o scaffolding de estado interno se
repete.) **Recomendação:** hooks `useColorSwatchPicker(colors, initial)` e
`useModalFormReset(open, entity, mapper)`.

**15 loops `setInterval` independentes**, cada um reimplementando cancelamento/cleanup na mão —
`hooks/useResourceSupervisor.ts`, `useNowPlaying.ts`, `useGsdSyncSessions.ts`,
`useDiscordPresence.ts`, `lib/activityTracker.ts` (2 no mesmo arquivo), `lib/limitResetWatch.ts`,
`stores/mergeStore.ts`, `AgentCanvasPOC` (2 no mesmo arquivo), `TokenHud`, os 3 já citados de
`TitleBar`, `SidebarMergePanel`, `HomeView/TimeAnalytics`, `HomeView/index.tsx`, `GitControl.tsx`,
`GhosttySurface`. **Recomendação:** hook `usePolling(fn, intervalMs, { enabled, startDelayMs })`
compartilhado — reduziria ~90-100 linhas de scaffolding repetido e padronizaria o guard de
visibilidade (hoje `GitControl` usa `document.visibilityState`, `TitleBar` usa um `activeRef`
próprio, `AgentCanvasPOC` usa uma flag local — 3 estratégias diferentes para o mesmo problema).

**2 arrays paralelos de tipos de agente:** `NewTerminalModal.tsx:14-22` (`AGENTS`) e
`EditProjectModal.tsx:28-36` (`ALL_AGENTS`) mantêm listas independentes cobrindo os mesmos 7 tipos
de agente com labels ligeiramente diferentes ("Claude" vs. "Claude Code") — fonte de verdade
duplicada, deveria viver só em `types.ts`.

**Volume total estimado: ~600-700 linhas.**

---

## 4. Performance e otimização

### 4.1 Seletores Zustand e re-render

A maioria dos ~240 pontos de uso de `useProjectsStore` amostrados usa seletores estreitos por campo
(bom padrão — ex. `src/components/TerminalPane/index.tsx:94-104`, `src/components/App.tsx:166-180`,
e uso correto de `useShallow` em `src/components/ProjectSidebar/index.tsx:84-117`). Porém, vários
componentes de topo selecionam **slices inteiras**:
- `WorkspaceView/index.tsx:52-53` — `s.projects`, `s.groups` inteiros.
- `ProjectSidebar/index.tsx:76-79` — `s.projects`, `s.groups`, `s.ungroupedOrder`,
  `s.workspace.containers`.
- `HomeView/index.tsx:72-75`, `TerminalInspector/index.tsx:49` — mesmo padrão.

Como a store usa atualização estilo Immer, qualquer mutação em qualquer lugar da árvore troca a
referência da slice inteira — esses componentes re-renderizam em mutações completamente não
relacionadas ao que exibem (ex.: `ProjectSidebar` inteiro, 1540 linhas, re-renderiza quando um PTY
muda de session-id em outro projeto).

Além disso, `TerminalPane/index.tsx:121-140` e `WorkspaceView/PaneArea.tsx:67` rodam um `.find()`
linear sobre `projects` **dentro do próprio seletor**, reexecutado a cada notificação da store — não
causa re-render espúrio por si (a referência do objeto encontrado é estável), mas é custo O(n) por
mutação × número de panes abertos simultaneamente.

**Recomendação:** trocar seleção de slice inteira por seletores por-id combinados com `useShallow`
onde só um subconjunto é necessário; considerar um índice `Map<id, Project>` na store para os
lookups por id em vez de `.find()` sobre array.

### 4.2 Memoização

| Componente | `useMemo` | `useCallback` | `React.memo` |
|---|---|---|---|
| `XTermView/index.tsx` (1719L) | 0 | 8 | Não |
| `AgentCanvasPOC/index.tsx` (1765L) | 0 | 6 | Não |
| `ProjectSidebar/index.tsx` (1540L, ~16 handlers) | 5 | **0** | Não |

`ProjectSidebar` define ~16 handlers por render (`onDragEnd`, `onGroupOpenAll`, `renderGroup`
recursivo, …) sem nenhum `useCallback` — todos são referências novas a cada render, propagadas para
filhos. `AgentCanvasPOC/index.tsx:1179-1187` roda 5 `.filter()`/agrupamentos sobre `nodes` direto no
corpo do render sem `useMemo`. `XTermView`, instanciado uma vez por pane de terminal aberto, não é
memoizado — ao contrário do seu componente pai `TerminalPane`, que já usa `memo()`.
Pontos positivos existentes: `TerminalPane`, `ProjectContainer`, `WebPane`, `MarkdownRenderer` já
usam `memo()`.

**Recomendação:** adicionar `useCallback` aos handlers de `ProjectSidebar`, `useMemo` aos
agrupamentos de `AgentCanvasPOC`, e avaliar `React.memo` em `XTermView` (maior ganho potencial dado
que múltiplas instâncias coexistem por workspace).

### 4.3 Persistência do `projectsStore`

Todas as ~59 chamadas ao wrapper interno `update()` que produzem mudança agendam
`scheduleSave(get)` (`src/stores/projectsStore.ts:987`), que debounce em 500ms
(`SAVE_DEBOUNCE_MS`) mas ao disparar serializa **a árvore inteira** do `ProjectsFile` — grupos,
projetos (com todos os terminais/tabs), todos, workspace, preferências, `cliPaths` — via
`JSON.stringify(payload, null, 2)` (pretty-print, custo extra), independente do tamanho da mudança
que disparou o save. Ou seja, marcar um todo como feito serializa o mesmo payload que mover uma
pane inteira.

**Recomendação:** o debounce já resolve o problema de "muitos saves"; o que falta é reduzir o custo
de cada save — remover o pretty-print (`null, 2`) do `JSON.stringify` de produção (só formata para
debug humano, custo real em CPU/IO para uma store de 3080 linhas de estado) e considerar, se o
payload crescer mais, um formato incremental/append-log ao invés de reescrita total.

### 4.4 WebGL/xterm

`src/lib/webglPool.ts` não faz pooling de contexto WebGL de fato — é um contador de
orçamento/budget (padrão 4 simultâneos). Acima de 4 panes visíveis com WebGL, os panes adicionais
caem para fallback Canvas2D — comportamento correto e documentado, mas o nome "pool" é enganoso (não
há reuso de contexto GL entre panes). `@xterm/addon-serialize` está declarado em `package.json` mas
não é importado em nenhum lugar de `src/` — dependência morta.

### 4.5 Bundle

`mermaid` (`MarkdownRenderer`) e `cytoscape` (`GraphifyView`) — bibliotecas pesadas — são importadas
estaticamente via `WorkspaceView/PaneArea.tsx:6-9` e `RightSidebar/index.tsx:8`, sem lazy-load,
mesmo sendo usadas só quando o usuário abre uma pane de Markdown/Graphify. Hoje só 4 componentes
usam lazy-load (`App.tsx:53-68`: `AgentCanvasPOC`, `HomeView`, `LayoutDesignerModal`,
`MemoryAnalyticsModal`) — os ~25 modais restantes em `src/components/modals/` entram estaticamente
no bundle principal mesmo sendo renderizados raramente.

**Recomendação:** `React.lazy()` para `MarkdownPane`/`GraphifyView` e para os modais menos
frequentes (ex. `ProfilesModal`, `SyncModal`, `ThemePickerModal`, `WelcomeModal`) — ganho direto no
tempo de boot do app. Remover `@xterm/addon-serialize` do `package.json` se de fato não é usado.

### 4.6 Backend — I/O e locks

**Ponto positivo a destacar:** o I/O de scrollback do PTY (`pty.rs`) já é bem desenhado — append
incremental com throttle de 250ms (`push_scrollback`), escrita dedicada a uma thread de background
via canal `mpsc` (evita bloquear a thread de leitura do PTY, com comentário explícito sobre latência
de digitação), e compactação amortizada a cada ~4MB de saída — não é rewrite síncrono por evento.
Locks em `pty.rs` (ex. `write_pty`) são cuidadosamente escopados dentro de `spawn_blocking` com
comentário explicando por que (para não travar attach/resize/kill de outros PTYs). Isso é o padrão
correto e não precisa de mudança.

**Único achado real:** `src-tauri/src/projects.rs::save_projects` (linhas 59-89) segura
`SAVE_MUTEX` (`tokio::sync::Mutex`) e, **ainda com o guard ativo**, roda `fs::create_dir_all`,
`fs::write`, `fs::rename` síncronos diretamente na task async, sem `spawn_blocking` — inconsistente
com o padrão que o próprio arquivo usa em `clone_github_repo` (que sim usa `spawn_blocking`).
Impacto hoje é baixo (payload pequeno, chamadas já debounced no frontend), mas em disco lento
(rede, AV scan) bloquearia uma worker thread do Tokio e serializaria outros `save_projects`
concorrentes atrás dele.

**Recomendação:** envolver o corpo de `save_projects` em `tokio::task::spawn_blocking`, mesmo padrão
já usado em `clone_github_repo` no mesmo arquivo.

### 4.7 Polling

`GhosttySurface/index.tsx:239-254` faz uma chamada IPC assíncrona (`ghosttySurfaceExited`) a cada
**700ms por pane nativo aberto** — o intervalo mais agressivo encontrado no app, e escala
linearmente com o número de panes Ghostty simultâneos (N panes = N chamadas IPC independentes a
cada 700ms). Os demais 14 pollers do frontend variam de 3s a 5min, cada um com sua própria lógica de
cancelamento (ver §3.2).

**Recomendação:** aumentar o intervalo do `GhosttySurface` (700ms é sub-segundo para checar se um
processo saiu — 2-3s provavelmente é imperceptível ao usuário) ou, melhor, mover a checagem de saída
para um evento push do backend em vez de poll.

---

## 5. Docs, governança e CI

- **`CLAUDE.md`/`AGENTS.md` referenciam 5 arquivos inexistentes** (`CONTEXTO_IA.md`, `GLOSSARY.md`,
  `BUILD_WINDOWS.md`, `HANDOFF_STATUS.md`, `CURRENT_STEP.md`) e descrevem uma estrutura de repo
  (`poc/` com `public launch/` dentro) que não corresponde ao layout atual (`src/`/`src-tauri/`
  ficam direto na raiz). Isso é especialmente crítico porque `CLAUDE.md`/`AGENTS.md` são o contexto
  injetado automaticamente em qualquer agente de IA que trabalhe no repo — um agente que siga esses
  links literalmente vai falhar ou alucinar estrutura.
- **Sem ADRs/RFCs formais** — nenhuma pasta `adr/`/`decisions/`/`rfcs/`, nenhum arquivo
  `ADR-*.md`. Porém o código *referencia* decisões nomeadas em comentários (`RFC-003` em
  `worktrees.rs`, `RFC-004` em `graphify.rs`, `RFC-006` em `merge_analyzer.rs`, `RFC-007` em
  `conflict_resolution.rs`) — ou seja, decisões arquiteturais relevantes já são tratadas como
  "numeradas" na cabeça de quem escreveu o código, só falta capturá-las como documento revisável.
- **Sem `CODEOWNERS`.**
- **CI sem lint dedicado** — `ci.yml` roda `tsc && vite build` (que também garante completude de
  i18n via tipagem) + testes + `cargo check`/`cargo test` multi-plataforma, mas não há step de
  ESLint nem `cargo clippy`.
- **Divergência de script de teste:** `package.json`'s `"test"` roda `vitest run`, mas o comentário
  em `ci.yml` e a §4 do `CLAUDE.md` descrevem `node --test` — que na verdade é o script separado
  `test:node`, não chamado explicitamente no CI hoje.
- **i18n:** ponto forte real — `pt-BR.ts` é tipado como `Record<MessageKey, string>` contra as
  chaves de `en.ts`, então `npm run build` falha em qualquer chave faltando/sobrando. Mecanismo de
  enforcement é estrutural (tipagem), não um script de lint separado — elegante e resistente a
  esquecimento.
- **Changelog:** disciplina real — `docs/CHANGELOG.md` é mantido ativamente sob `[Não lançado]` e
  correlaciona com o trabalho em andamento no working tree.
- **`docs/HANDOFF_SESSAO_ATUAL.md`** é uma nota de sessão de IA explicitamente temporária
  ("pode apagar depois de ler") sentada em `docs/` ao lado de documentos permanentes.

---

## 6. Matriz de severidade

| Achado | Área | Impacto | Esforço | Recomendação |
|---|---|---|---|---|
| `projectsStore.ts` god-object (3080L) | Frontend | Alto | L | Quebrar em slices por domínio |
| Cobertura de teste frontend ~9%, zero em componentes/stores/hooks | Frontend | Alto | L | Testar `projectsStore` e componentes críticos primeiro (XTermView, ProjectSidebar) |
| `CLAUDE.md`/`AGENTS.md` referenciam docs/estrutura inexistentes | Governança | Alto | S | Atualizar ou remover as referências quebradas |
| 24/50 módulos Rust sem nenhum teste | Backend | Médio-Alto | M | Priorizar `cli_resolver.rs`, `profiles.rs`, session-parsing |
| Duplicação frontend (~600-700L: polling, cards, caches, modais) | Frontend | Médio | M | `createCache<T>`, `usePolling`, `<UsageCard/>` genérico |
| Duplicação backend (~150-200L: paths, JSONL parse, `now_ms`) | Backend | Médio | S-M | Módulo `provider_common.rs` |
| Sem ADR/RFC formal apesar de decisões referenciadas no código | Governança | Médio | S | Formalizar RFC-003/004/006/007 já citados como docs reais |
| Seletores Zustand amplos (`WorkspaceView`, `ProjectSidebar`, `HomeView`) | Performance | Médio | M | Seletores por-id + `useShallow` |
| `save_projects` sem `spawn_blocking` | Backend/Perf | Baixo-Médio | S | Envolver em `spawn_blocking` (mesmo padrão de `clone_github_repo`) |
| Sem `useCallback`/`useMemo` em `ProjectSidebar`/`AgentCanvasPOC` | Performance | Médio | S-M | Memoizar handlers e agrupamentos |
| Bundle: `mermaid`/`cytoscape`/~25 modais sem lazy-load | Performance | Baixo-Médio | S | `React.lazy()` |
| `GhosttySurface` polling a 700ms/pane | Performance | Baixo-Médio | S | Aumentar intervalo ou trocar por evento push |
| Sem `CODEOWNERS`, sem lint no CI | Governança | Baixo | S | Adicionar `CODEOWNERS` + step de ESLint/clippy |
| Divergência script de teste (`test` vs. `test:node`) | Governança | Baixo | S | Alinhar CI/CLAUDE.md com o script real usado |
| `HANDOFF_SESSAO_ATUAL.md` como doc permanente | Governança | Baixo | S | Apagar (já marcado como descartável) |
| 2 arrays paralelos de tipo de agente | Frontend | Baixo | S | Unificar em `types.ts` |
| Inconsistências estruturais menores (`EmptyState`, `ui/` naming) | Frontend | Baixo | S | Padronizar convenção |

---

## 7. Nota de escopo

Este documento é um **diagnóstico com recomendações pontuais**, não um plano de refatoração
sequenciado. Nenhuma mudança de código foi feita para produzi-lo. Prioridade, ordem e quais itens
valem o esforço ficam inteiramente a critério do dono do projeto — vários achados de "Baixo" impacto
são triviais de corrigir isoladamente, enquanto os de "Alto" impacto (god-object, cobertura de
teste, docs de IA quebrados) são intencionalmente maiores e merecem uma conversa própria antes de
qualquer execução.
