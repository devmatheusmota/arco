// arco-managed: v12
// Gerado automaticamente pelo Arco. Seguro editar — se você mudar este
// arquivo, remova ou altere a linha acima ("arco-managed: vN") para
// impedir que o Arco sobrescreva suas mudanças em versões futuras.
//
// Mantém .planning/ sincronizado sozinho, sem depender do modelo lembrar de
// fazer isso. Estrutura de planejamento (6 arquivos, sempre a mesma,
// independente da complexidade da tarefa):
//   - task.md        determinístico — checklist espelhando os todos.
//   - status.md      determinístico — "Status: <Planning|In Progress|Completed>"
//                    + "Progress: <pct>%".
//   - progress.md    determinístico, SÓ ANEXA — histórico cronológico de
//                    progresso, uma entrada por mudança real.
//   - goal.md        só a IA escreve (via skill, numa SESSÃO-FILHA isolada).
//   - plan.md        só a IA escreve (via skill, idem) — plano de
//                    implementação (o QUE foi feito), sem passos de teste.
//   - procedure.json só a IA escreve, mas via TOOL dedicada
//                    (`gsd_record_step`), nunca texto solto — um item por
//                    chamada, `{ description, category }`. É essa lista
//                    estruturada que vira o checklist do "Briefing de
//                    Testes" na Central de Merges (sem parsing de markdown,
//                    sem título/texto solto virando item marcável por
//                    engano). Reescrito do zero a cada ciclo, igual
//                    goal.md/plan.md.
//
// Cada arquivo tem exatamente UM escritor (determinístico OU skill, nunca os
// dois) — não há risco de um sobrescrever o outro, então não precisa de
// merge textual.
//
// A skill roda numa SESSÃO-FILHA (client.session.create, SEM parentID — uma
// sessão-filha vinculada via parentID nasce sem acesso ao próprio histórico
// quando reaberta depois via `--session <id>` na TUI; sem parentID ela
// resume normalmente). Ela nasce sem acesso ao histórico do pai de qualquer
// forma (confirmado empiricamente), então o plugin empacota manualmente, a
// cada disparo, só o DELTA de mensagens novas da sessão principal desde a
// última sincronização.
//
// A sessão-filha é única e persistente por worktree — criada uma vez,
// reaproveitada em todo ciclo seguinte. O id fica gravado em
// `.planning/.gsd-child-session` (o Arco usa esse arquivo pra abrir uma
// pane "GSD Sync" anexada via `opencode --session <id>`), e
// `.planning/.gsd-child-busy` marca enquanto ela está processando.
//
// Modelo: cada ciclo tenta primeiro o MESMO modelo que a sessão principal
// acabou de usar (espelhado, sempre automático) e, se isso falhar, tenta em
// ordem a cadeia de fallback configurada globalmente no app (lida em
// runtime de `.opencode/arco-gsd-config.json`, escrito pelo Arco a cada
// spawn). Falha é detectada via `session.error` (evento dedicado,
// confirmado empiricamente — não é uma promise rejeitada) seguido de
// `session.idle`; só escreve `.planning/.gsd-child-error` se TODA a cadeia
// esgotar.
//
// Gatilho do skill: ao fim de todo turno com atividade REAL desde o último
// aviso (session.idle DA SESSÃO PRINCIPAL + dirty) — `todowrite` OU qualquer
// tool de trabalho (`write`/`edit`/`patch`/`bash`). `todowrite` sozinho não
// bastava: só dispara quando o modelo decide montar lista de tarefas, o que
// tende a acontecer só no primeiro pedido "grande" da sessão — pedidos
// menores depois (ex.: "adiciona um .env.example") iam direto pra `write`
// sem lista nenhuma e nunca disparavam sincronização.
//
// Validado empiricamente contra opencode 1.18.11 real (server mode, modelo
// gratuito) antes de ser embutido no binário do Arco — ver
// docs/CHANGELOG.md.

import type { Plugin } from '@opencode-ai/plugin'
import { tool } from '@opencode-ai/plugin'
import { execFile } from 'node:child_process'
import { mkdir, writeFile, appendFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'

const execFileAsync = promisify(execFile)

type Todo = { content?: string; status?: string; priority?: string }
type ModelRef = { providerID: string; modelID: string }
type ProcedureCategory = 'setup' | 'action' | 'verify'
type ProcedureStep = { description: string; category: ProcedureCategory }

const PLANNING_DIR = '.planning'
const CHILD_SESSION_SENTINEL = '.gsd-child-session'
const CHILD_BUSY_SENTINEL = '.gsd-child-busy'
const CHILD_ERROR_SENTINEL = '.gsd-child-error'
const PROCEDURE_FILE = 'procedure.json'
const MODEL_CHAIN_CONFIG_PATH = '.opencode/arco-gsd-config.json'
// Tools que indicam trabalho real feito (não só leitura/investigação) — além
// de `todowrite`, qualquer uma dessas também marca a sessão como "dirty" pra
// disparar um ciclo GSD Sync novo, mesmo sem lista de tarefas envolvida.
const WORK_SIGNAL_TOOLS = new Set(['write', 'edit', 'patch', 'bash'])

const SKILL_PROMPT = `Atualize os arquivos de planejamento desta worktree:
1. .planning/goal.md — objetivo desta tarefa/sessão (o que deve ser alcançado), cobrindo TODO o trabalho feito nesta worktree até agora — não só o pedido mais recente. Reescreva do zero.
2. .planning/plan.md — plano passo a passo do que foi/será feito, cobrindo TODAS as tarefas desta worktree até agora. NÃO inclua passos de teste/validação aqui — use a ferramenta "gsd_record_step" pra isso (item 3).
3. Ferramenta "gsd_record_step" — chame ela UMA VEZ pra CADA passo que um humano precisa confirmar manualmente pra validar TODO o trabalho desta worktree até agora (não só a tarefa mais recente), nunca uma amostra. Cada chamada é um passo isolado e acionável.
ESCOPO E PROPORCIONALIDADE (regra crítica pro procedimento de teste): o procedimento cobre SÓ os arquivos listados na seção "Arquivos alterados/criados nesta sessão" abaixo — nunca invente passo pra testar rota, comando, servidor ou arquivo que não está nessa lista, mesmo que exista no resto do projeto. A quantidade e complexidade dos passos reflete a complexidade REAL da mudança, nunca o tamanho do app inteiro:
  - Mudança simples (ex.: criar/editar um arquivo de documentação ou config estático) → procedimento simples, normalmente 1-2 passos. Exemplo: "action: abrir <arquivo> e conferir que existe em <caminho exato>" + "verify: conferir que o conteúdo tem <estrutura específica citada de verdade, ex. as seções X/Y/Z>". NÃO rode servidor, NÃO teste API, NÃO abra nada fora do que foi alterado só porque "poderia ser relevante".
  - Mudança em código com efeito observável em runtime (rota nova, comportamento de UI, lógica) → aí cabe setup/action/verify envolvendo rodar/interagir com o sistema, mas só a parte que ESSA mudança especificamente afeta — nunca uma varredura geral do app.
IMPORTANTE: nunca afirme que algo "funciona" ou "está correto" — você não verificou, só implementou/planejou. A confirmação de que funcionou ou não é sempre do usuário.
IMPORTANTE: o resumo da conversa abaixo é só contexto de alto nível, não é fonte confiável pra detalhes exatos. Antes de chamar "gsd_record_step" com um passo que cite um texto específico (mensagem de erro, saída de console, nome de comando, formato de dado), ABRA e releia o arquivo de verdade pra copiar o texto exato dali — nunca escreva de memória ou por suposição/inferência do que "provavelmente" o código faz. Se não conseguir confirmar um detalhe lendo o código, descreva o passo em termos gerais em vez de inventar um texto específico.
NÃO escreva em .planning/status.md, .planning/task.md nem .planning/progress.md — esses são mantidos automaticamente por outro processo, fora do seu controle.
Não implemente nem corrija nada agora — só documente/registre.

Contexto da sessão principal (delta desde a última sincronização) segue abaixo, se houver — é só um resumo em texto solto da conversa, não confie nele pra detalhes exatos de código.`

/** Um arquivo é excluído do escopo do procedimento se for infraestrutura do
 *  próprio Arco (`.planning/` — estado deste plugin — e `.opencode/`/
 *  `opencode.json`, escritos automaticamente a cada spawn: plugin GSD, MCP do
 *  Graphify) — nenhum dos dois é trabalho real do usuário nesta sessão; sem
 *  essa exclusão a sessão-filha via esses arquivos em `git status`/`git diff`
 *  e inventava passo de teste pra "validar que o plugin carrega", desconectado
 *  da tarefa real. */
function isRealWork(f: string): boolean {
  return Boolean(f) && !f.startsWith(`${PLANNING_DIR}/`) && !f.startsWith('.opencode/') && f !== 'opencode.json'
}

/** Arquivos já COMMITADOS nesta worktree desde que a branch divergiu de
 *  `main`/`master` — complementa `getChangedFiles` (que só vê working tree)
 *  com trabalho de ciclos anteriores que já foi commitado (merge parcial,
 *  commit manual do usuário) nesse meio-tempo. Sem isso, `clearProcedure`
 *  zerando `procedure.json` a cada ciclo (ver comentário no topo do arquivo)
 *  faz o passo de validação daquele trabalho ser perdido de verdade — ele
 *  desaparece de `git status` assim que é commitado, e a regra de escopo do
 *  prompt abaixo proíbe inventar passo pra arquivo fora da lista. Best-effort:
 *  sem `main`/`master` resolvível, devolve lista vazia — não bloqueia o ciclo. */
async function getCommittedFilesSinceBase(root: string): Promise<string[]> {
  for (const base of ['main', 'master']) {
    try {
      const { stdout: mergeBaseOut } = await execFileAsync('git', ['merge-base', 'HEAD', base], { cwd: root })
      const mergeBase = mergeBaseOut.trim()
      if (!mergeBase) continue
      const { stdout } = await execFileAsync('git', ['diff', '--name-only', `${mergeBase}..HEAD`], { cwd: root })
      return stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    } catch {
      // base não existe localmente ou merge-base falhou — tenta a próxima
    }
  }
  return []
}

/** Lista arquivos alterados/criados/commitados nesta worktree — une working
 *  tree (`git status --porcelain`, cobre não commitado) com o histórico de
 *  commits desde a base da branch (`getCommittedFilesSinceBase`, cobre
 *  commitado). Fonte de verdade sobre O QUE mudou de verdade nesta worktree,
 *  pra instruir a sessão-filha a reler exatamente esses arquivos em vez de
 *  confiar só no resumo em prosa da conversa (que nunca tem detalhe exato o
 *  suficiente pra escrever validação precisa). */
async function getChangedFiles(root: string): Promise<string[]> {
  let uncommitted: string[] = []
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1'], { cwd: root })
    uncommitted = stdout.split('\n').map((line) => line.slice(3).trim())
  } catch {
    // sem git/fora de um repo — segue só com o que getCommittedFilesSinceBase achar
  }
  const committed = await getCommittedFilesSinceBase(root)
  const all = new Set([...uncommitted, ...committed].filter(isRealWork))
  return [...all]
}

function renderTask(todos: Todo[]): string {
  return todos.map((t) => `- [${t.status === 'completed' ? 'x' : ' '}] ${(t.content ?? '').trim()}`).join('\n') + '\n'
}

function renderStatus(total: number, completed: number): string {
  const label = completed === total ? 'Completed' : completed === 0 ? 'Planning' : 'In Progress'
  const progress = total > 0 ? Math.round((completed / total) * 100) : 0
  return `Status: ${label}\nProgress: ${progress}%\n`
}

function renderProgressEntry(total: number, completed: number): string {
  const stamp = new Date().toISOString()
  return `## ${stamp}\n\nProgresso atualizado: ${completed}/${total} tarefas concluídas.\n\n`
}

/** Extrai texto legível das `parts` de uma mensagem (`session.messages`),
 *  ignorando partes não-texto (step-start/step-finish/tool-call etc.). */
function extractMessageText(message: any): string {
  const parts = Array.isArray(message?.parts) ? message.parts : []
  return parts
    .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
    .map((p: any) => p.text.trim())
    .filter(Boolean)
    .join('\n')
}

/** `providerID`/`modelID` da última mensagem do assistente — o modelo que a
 *  sessão principal acabou de usar com sucesso, "conhecido bom" por
 *  construção. `null` se a sessão ainda não tem nenhuma resposta. */
function extractMirroredModel(messages: any[]): ModelRef | null {
  const lastAssistant = [...messages].reverse().find((m) => m?.info?.role === 'assistant')
  const providerID = lastAssistant?.info?.providerID
  const modelID = lastAssistant?.info?.modelID
  return typeof providerID === 'string' && typeof modelID === 'string' ? { providerID, modelID } : null
}

export const ArcoGsdStatePlugin: Plugin = async ({ directory, worktree, client }) => {
  const root = (worktree as string | undefined) ?? directory
  const planningDir = join(root, PLANNING_DIR)
  let lastTask = ''
  // Houve todowrite desde o último aviso ao usuário/skill — dispara na
  // próxima session.idle da sessão principal.
  let dirty = false
  // Sessão-filha atual (cacheada depois de lida/criada uma vez).
  let childSessionId: string | null = null
  // Enquanto true, ignora todowrite (provavelmente é a sessão-filha
  // documentando o próprio trabalho, não o plano do agente principal) —
  // fallback seguro caso o hook de tool não exponha de qual sessão veio.
  // Também true durante toda a cadeia de tentativas de modelo (não só a 1ª).
  let childBusy = false
  // Cursor de delta: nº de mensagens da sessão principal já mandadas pra
  // sessão-filha.
  let lastSyncedMessageCount = 0
  // Todos de um `todowrite` que chegou enquanto `childBusy` era true — sem
  // isso, esse todowrite era descartado em silêncio (nem task.md/status.md
  // atualizavam, nem um novo ciclo era agendado). Se fosse o ÚLTIMO todowrite
  // da sessão principal, status.md ficava preso em "In Progress" pra sempre,
  // travando o Gate de Conclusão de Planejamento na Central de Merges.
  // Flusha assim que o ciclo atual da sessão-filha terminar (`setChildBusy(false)`).
  let pendingTodos: Todo[] | null = null

  // Estado da cadeia de fallback em andamento (só existe durante um ciclo).
  let activeChain: ModelRef[] = []
  let activeChainIndex = 0
  let activePromptText = ''
  let attemptFailed = false
  let lastAttemptErrorMessage = ''

  // Reconciliação de boot: `.gsd-child-busy` só é limpo por `setChildBusy(false)`,
  // chamado quando ESTE processo detecta `session.idle`/`session.error` da
  // sessão-filha. Se o processo morrer no meio de um ciclo (pane fechado, app
  // reiniciado, travamento do modelo) sem passar por ali, o sentinel fica
  // órfão em disco pra sempre — a UI (que só lê o arquivo, nunca reconstrói
  // estado do processo antigo) mostra "Sincronizando" eternamente mesmo sem
  // nada rodando de verdade. Uma instância do plugin que está subindo agora
  // não tem `activeChain` nenhuma ainda (linha acima, sempre vazia no boot),
  // então qualquer sentinel pré-existente é necessariamente órfão de um
  // processo anterior — nunca do próprio.
  void rm(join(planningDir, CHILD_BUSY_SENTINEL), { force: true }).catch(() => {})

  async function syncStructure(todos: Todo[]) {
    if (!Array.isArray(todos) || todos.length === 0) return // nunca inventa progresso sem nenhum todo real
    await mkdir(planningDir, { recursive: true }).catch(() => {})
    const completed = todos.filter((t) => t.status === 'completed').length
    const total = todos.length
    const nextTask = renderTask(todos)
    if (nextTask !== lastTask) {
      await writeFile(join(planningDir, 'task.md'), nextTask, 'utf8').catch(() => {})
      await writeFile(join(planningDir, 'status.md'), renderStatus(total, completed), 'utf8').catch(() => {})
      await appendFile(join(planningDir, 'progress.md'), renderProgressEntry(total, completed), 'utf8').catch(() => {})
      lastTask = nextTask
    }
  }

  async function getOrCreateChildSession(mainSessionId: string): Promise<string | null> {
    if (childSessionId) return childSessionId
    const sentinelPath = join(planningDir, CHILD_SESSION_SENTINEL)
    const existing = await readFile(sentinelPath, 'utf8').then((s) => s.trim()).catch(() => '')
    if (existing) {
      childSessionId = existing
      return childSessionId
    }
    try {
      // SEM parentID — ver nota no cabeçalho do arquivo sobre por que uma
      // sessão-filha vinculada não resumia com histórico visível na TUI.
      const created: any = await (client as any).session.create({
        body: { directory: root, title: 'Arco · GSD Sync' },
      })
      const id: string | undefined = created?.data?.id ?? created?.id
      if (!id) return null
      childSessionId = id
      await mkdir(planningDir, { recursive: true }).catch(() => {})
      await writeFile(sentinelPath, id, 'utf8').catch(() => {})
      return id
    } catch {
      return null
    }
  }

  async function buildContextDeltaAndMirror(mainSessionId: string): Promise<{ delta: string; mirrored: ModelRef | null }> {
    try {
      const res: any = await (client as any).session.messages({ path: { id: mainSessionId } })
      const all: any[] = Array.isArray(res?.data) ? res.data : []
      const mirrored = extractMirroredModel(all)
      const delta = all.slice(lastSyncedMessageCount)
      lastSyncedMessageCount = all.length
      const rendered = delta
        .map((m) => {
          const role = m?.info?.role ?? 'unknown'
          const text = extractMessageText(m)
          return text ? `[${role}] ${text}` : ''
        })
        .filter(Boolean)
        .join('\n\n')
      return { delta: rendered, mirrored }
    } catch {
      return { delta: '', mirrored: null }
    }
  }

  /** Cadeia efetiva: modelo espelhado (posição 0, sempre tentado primeiro,
   *  automático) + cadeia de fallback configurada globalmente no app (lida
   *  em runtime — muda sem precisar de nova versão do plugin). */
  async function buildEffectiveChain(mirrored: ModelRef | null): Promise<ModelRef[]> {
    const chain: ModelRef[] = []
    if (mirrored) chain.push(mirrored)
    try {
      const raw = await readFile(join(root, MODEL_CHAIN_CONFIG_PATH), 'utf8')
      const parsed = JSON.parse(raw)
      const configured: unknown[] = Array.isArray(parsed?.modelChain) ? parsed.modelChain : []
      for (const modelID of configured) {
        if (typeof modelID === 'string' && modelID.trim()) {
          chain.push({ providerID: 'opencode', modelID: modelID.trim() })
        }
      }
    } catch {
      // sem config/erro de parse — segue só com o modelo espelhado, se houver
    }
    return chain
  }

  /** Zera `.planning/procedure.json` no início de cada ciclo novo — a
   *  sessão-filha reconstrói a lista inteira via `gsd_record_step` (mesmo
   *  espírito de "reescreve do zero" de goal.md/plan.md), então nunca fica
   *  misturando passo de uma tarefa antiga já removida/mudada com o ciclo
   *  atual. */
  async function clearProcedure() {
    await mkdir(planningDir, { recursive: true }).catch(() => {})
    await writeFile(join(planningDir, PROCEDURE_FILE), '[]', 'utf8').catch(() => {})
  }

  /** Acrescenta um passo em `.planning/procedure.json` (lê-modifica-escreve
   *  — só a tool `gsd_record_step` chama isso, nunca concorrente com si
   *  mesma dentro do mesmo ciclo, já que cada tool call do modelo espera a
   *  anterior terminar). */
  async function appendProcedureStep(step: ProcedureStep) {
    const path = join(planningDir, PROCEDURE_FILE)
    const current: unknown = await readFile(path, 'utf8').then((s) => JSON.parse(s)).catch(() => [])
    const next = Array.isArray(current) ? current : []
    next.push(step)
    await mkdir(planningDir, { recursive: true }).catch(() => {})
    await writeFile(path, JSON.stringify(next, null, 2), 'utf8').catch(() => {})
  }

  async function setChildBusy(busy: boolean) {
    childBusy = busy
    const sentinelPath = join(planningDir, CHILD_BUSY_SENTINEL)
    if (busy) {
      await mkdir(planningDir, { recursive: true }).catch(() => {})
      await writeFile(sentinelPath, '1', 'utf8').catch(() => {})
    } else {
      await rm(sentinelPath, { force: true }).catch(() => {})
      if (pendingTodos) {
        const todos = pendingTodos
        pendingTodos = null
        await syncStructure(todos)
      }
    }
  }

  async function writeChildError(message: string) {
    await mkdir(planningDir, { recursive: true }).catch(() => {})
    await writeFile(join(planningDir, CHILD_ERROR_SENTINEL), message, 'utf8').catch(() => {})
  }

  /** Tenta o modelo atual de `activeChain[activeChainIndex]`. Uma falha
   *  IMEDIATA (schema inválido, erro de rede — vem no próprio retorno de
   *  `promptAsync`, não é uma promise rejeitada) avança pra próxima
   *  tentativa direto, sem esperar evento nenhum (nada chegou a ser
   *  disparado). Falha em runtime (modelo válido no schema mas
   *  inexistente/indisponível) só aparece depois, via `session.error` +
   *  `session.idle` do lado de fora desta função. */
  async function sendChainAttempt(childId: string) {
    const model = activeChain[activeChainIndex]
    const res: any = await (client as any).session
      .promptAsync({ path: { id: childId }, body: { parts: [{ type: 'text', text: activePromptText }], model } })
      .catch((e: any) => ({ error: { data: { message: e?.message ?? String(e) } } }))
    if (res?.error) {
      const msg = res.error?.data?.message ?? res.error?.name ?? 'unknown error'
      await advanceChainOrGiveUp(childId, msg)
    }
    // sem erro imediato — aguarda session.error/session.idle normalmente
  }

  async function advanceChainOrGiveUp(childId: string, errorMessage: string) {
    activeChainIndex += 1
    if (activeChainIndex < activeChain.length) {
      await sendChainAttempt(childId)
      return
    }
    await writeChildError(
      `Todos os ${activeChain.length} modelo(s) da cadeia falharam. Último erro: ${errorMessage}`,
    )
    await setChildBusy(false)
    activeChain = []
    activeChainIndex = 0
  }

  return {
    tool: {
      gsd_record_step: tool({
        description:
          'Registra UM passo de teste real que um humano precisa confirmar manualmente pra validar o trabalho desta worktree — nunca escreva passos de teste como texto solto em plan.md, sempre use esta ferramenta, uma chamada por passo. Escopo estrito: só os arquivos alterados/criados NESTA sessão, proporcional à complexidade real da mudança — nunca invente passo pra testar parte do app que não foi tocada.',
        args: {
          description: z
            .string()
            .describe('O passo em si, em português, acionável (ex.: "Rodar npm run users e conferir que a lista aparece") — copie textos exatos (mensagens/comandos) do código real, nunca invente. Pra mudança simples (ex.: um arquivo de documentação), um passo do tipo "abrir <arquivo> e conferir <estrutura esperada>" já é suficiente — não infle com testes de partes do app não alteradas.'),
          category: z
            .enum(['setup', 'action', 'verify'])
            .describe('setup = preparação necessária antes de testar; action = execução do próprio teste; verify = o que checar no resultado'),
        },
        async execute(args) {
          await appendProcedureStep({ description: args.description, category: args.category })
          return { output: `Passo registrado: [${args.category}] ${args.description}` }
        },
      }),
    },
    'tool.execute.after': async (input) => {
      const toolName = (input as { tool?: string }).tool
      if (childBusy) {
        // Provável tool call da sessão-filha, não do agente principal — mas
        // se for um todowrite de verdade do agente principal chegando nesse
        // meio-tempo, represa os todos em vez de descartar (ver comentário
        // de `pendingTodos`). Fica pendente até o ciclo atual terminar.
        if (toolName === 'todowrite') {
          pendingTodos = ((input as { args?: { todos?: Todo[] } }).args?.todos ?? []) as Todo[]
          dirty = true
        }
        return
      }
      if (toolName === 'todowrite') {
        const todos = ((input as { args?: { todos?: Todo[] } }).args?.todos ?? []) as Todo[]
        await syncStructure(todos)
        dirty = true
        return
      }
      // Trabalho real sem lista de tarefas: `todowrite` só dispara quando o
      // modelo decide que a tarefa "merece" uma lista — pedidos pequenos
      // depois do primeiro grande da sessão (ex.: "adiciona um .env.example")
      // costumam pular isso e ir direto pra `write`/`edit`/`bash`, deixando
      // esse trabalho de fora do ciclo GSD Sync pra sempre. Contar essas
      // tools também garante que QUALQUER trabalho real da sessão — não só
      // o primeiro pedido "grande" — dispara sincronização.
      if (toolName && WORK_SIGNAL_TOOLS.has(toolName)) {
        dirty = true
      }
    },
    event: async ({ event }) => {
      const sessionID = (event.properties as { sessionID?: string } | undefined)?.sessionID
      if (!sessionID) return

      if (event.type === 'session.error' && sessionID === childSessionId) {
        const error = (event.properties as any)?.error
        lastAttemptErrorMessage = error?.data?.message ?? error?.name ?? 'unknown error'
        attemptFailed = true
        return
      }

      if (event.type !== 'session.idle') return

      // Sessão-filha ficou ociosa — ou terminou a tentativa atual com
      // sucesso, ou falhou (sinalizado por session.error logo antes).
      if (sessionID === childSessionId) {
        if (attemptFailed) {
          attemptFailed = false
          await advanceChainOrGiveUp(sessionID, lastAttemptErrorMessage)
          return
        }
        if (activeChain.length > 0) {
          // sucesso — encerra o ciclo
          await setChildBusy(false)
          activeChain = []
          activeChainIndex = 0
        }
        return
      }

      // session.idle de qualquer outra sessão que não seja a principal
      // (child ainda não conhecido) — só a sessão principal, quando dirty,
      // dispara um novo ciclo.
      if (!dirty) return
      dirty = false

      const childId = await getOrCreateChildSession(sessionID)
      if (!childId) return

      const { delta, mirrored } = await buildContextDeltaAndMirror(sessionID)
      const chain = await buildEffectiveChain(mirrored)
      if (chain.length === 0) return // sessão principal ainda sem nenhuma resposta — não há modelo pra espelhar

      const changedFiles = await getChangedFiles(root)
      const filesSection = changedFiles.length > 0
        ? `\n\nArquivos alterados/criados nesta sessão (git status — fonte de verdade, releia CADA um antes de escrever o plano):\n${changedFiles.map((f) => `- ${f}`).join('\n')}`
        : ''

      await clearProcedure()

      activeChain = chain
      activeChainIndex = 0
      activePromptText = (delta ? `${SKILL_PROMPT}\n\n---\n${delta}\n---` : SKILL_PROMPT) + filesSection

      await setChildBusy(true)
      await sendChainAttempt(childId)
    },
  }
}
