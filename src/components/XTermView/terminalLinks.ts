import type { ILink } from '@xterm/xterm'

export type FileLinkKind = 'markdown' | 'image' | 'video' | 'text'

export type DetectedTerminalLink = {
  text: string
  target: string
  index: number
  displayLength: number
  kind: 'url' | 'path'

  fileKind?: FileLinkKind
}

type TerminalBufferLine = {
  readonly isWrapped: boolean
  translateToString(trimRight?: boolean): string
}

type TerminalBuffer = {
  readonly length: number
  getLine(y: number): TerminalBufferLine | undefined
}

export type LogicalTerminalLine = {
  text: string
  startLine: number
}

const LINK_START_PATTERN =
  /https?:\/\/|(?<![@\w.-])(?:localhost(?::\d{1,5})?|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:app|ai|biz|br|ca|cloud|co|com|de|dev|edu|fr|gg|gov|info|io|jp|live|me|net|online|org|page|sh|site|tech|tools|tv|uk|xyz))(?::\d{1,5})?(?:\/[^\s<>"'`|]*)?|(?:[A-Za-z]:\\|\\\\)|(?<![\w])(?:~\/|\/)(?=[A-Za-z0-9_.~])/gi
const URL_PROTOCOL_PATTERN = /^https?:\/\//i
const BARE_URL_PATTERN =
  /^(?:localhost(?::\d{1,5})?|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:app|ai|biz|br|ca|cloud|co|com|de|dev|edu|fr|gg|gov|info|io|jp|live|me|net|online|org|page|sh|site|tech|tools|tv|uk|xyz))(?::\d{1,5})?(?:\/[^\s<>"'`|]*)?/i

const LINE_COL_SUFFIX = /:\d+(?::\d+)?$/
const MARKDOWN_EXT_PATTERN = /\.(md|markdown|mdx)$/i
const IMAGE_EXT_PATTERN = /\.(png|jpe?g|gif|webp|bmp|avif|ico|svg)$/i
const VIDEO_EXT_PATTERN = /\.(mp4|m4v|mov|avi|mkv|webm|ogv)$/i
const FILE_EXT_PATTERN = /\.[A-Za-z0-9]{1,12}$/
const FILE_EXT_BOUNDARY_PATTERN =
  /\.(?:md|markdown|mdx|png|jpe?g|gif|webp|bmp|avif|ico|svg|txt|tsx?|jsx?|json|ya?ml|toml|csv|pdf|mp4|m4v|mov|avi|mkv|webm|mp3|wav|flac|m4a|zip|7z|rar|tar|gz|exe|msi|dll)(?=$|[\s),.;:])/i
const LINK_TRAILING_PUNCTUATION = /[\s),.;:]+$/

export function isVideoFilePath(path: string): boolean {
  return VIDEO_EXT_PATTERN.test(stripLineColumn(path.trim()))
}

export function isMarkdownFilePath(path: string): boolean {
  return MARKDOWN_EXT_PATTERN.test(stripLineColumn(path.trim()))
}

export function stripLineColumn(text: string): string {
  return text.replace(LINE_COL_SUFFIX, '')
}

export function classifyFileLink(text: string): FileLinkKind | undefined {
  const clean = stripLineColumn(text)
  if (MARKDOWN_EXT_PATTERN.test(clean)) return 'markdown'
  if (IMAGE_EXT_PATTERN.test(clean)) return 'image'
  if (VIDEO_EXT_PATTERN.test(clean)) return 'video'
  if (FILE_EXT_PATTERN.test(clean)) return 'text'
  return undefined
}
const HARD_LINK_DELIMITERS = new Set(['\t', '\r', '\n', '<', '>', '"', "'", '`', '|'])

function isLikelyAbsolutePath(text: string): boolean {
  if (!/^(?:~\/|\/)/.test(text)) return true
  const clean = stripLineColumn(text)
  const withoutRoot = clean.startsWith('~/') ? clean.slice(2) : clean.slice(1)
  return withoutRoot.includes('/') || FILE_EXT_PATTERN.test(clean)
}

function normalizeUrlTarget(text: string): string {
  if (URL_PROTOCOL_PATTERN.test(text)) {
    return text.replace(URL_PROTOCOL_PATTERN, (protocol) => protocol.toLowerCase())
  }
  return `${/^localhost(?::|\/|$)/i.test(text) ? 'http' : 'https'}://${text}`
}

function findLinkEnd(line: string, start: number, isUrl: boolean): number {
  const opener = line[start - 1]
  const closer = opener === '(' ? ')' : opener === '[' ? ']' : undefined
  if (closer && !isUrl) {
    const boundedEnd = line.indexOf(closer, start)
    if (boundedEnd !== -1) return boundedEnd
  }

  let end = start
  while (end < line.length) {
    const char = line[end]
    if (HARD_LINK_DELIMITERS.has(char)) break
    if (isUrl && /\s/.test(char)) break
    if (char === ' ' && line[end + 1] === ' ') break
    if (char === ' ' && !isUrl) {
      const pathSoFar = line.slice(start, end)
      const endsAtDirectorySeparator =
        pathSoFar.endsWith('/') ||
        (/^(?:[A-Za-z]:\\|\\\\)/.test(pathSoFar) && pathSoFar.endsWith('\\'))
      if (endsAtDirectorySeparator) break

      // A space is only worth crossing to reach a file extension — that is what a path
      // with spaces looks like. With no extension ahead, the rest of the line is prose.
      const escaped = line[end - 1] === '\\'
      if (!escaped && !FILE_EXT_BOUNDARY_PATTERN.test(line.slice(end + 1))) break
    }

    // A second link after whitespace belongs to a separate match.
    if (char === ' ') {
      const remainder = line.slice(end + 1)
      if (/^(?:https?:\/\/|[A-Za-z]:\\|\\\\|~\/|\/)/.test(remainder)) break
    }
    end += 1

    if (!isUrl && FILE_EXT_BOUNDARY_PATTERN.test(line.slice(start, end))) break
  }
  return end
}

export function detectTerminalLinks(line: string): DetectedTerminalLink[] {
  const links: DetectedTerminalLink[] = []
  LINK_START_PATTERN.lastIndex = 0

  for (const match of line.matchAll(LINK_START_PATTERN)) {
    const index = match.index ?? 0
    if (links.some((link) => index < link.index + link.displayLength)) continue

    const isUrl = URL_PROTOCOL_PATTERN.test(match[0]) || BARE_URL_PATTERN.test(match[0])
    const raw = line.slice(index, findLinkEnd(line, index, isUrl))
    const displayText = raw.replace(LINK_TRAILING_PUNCTUATION, '')
    if (!displayText) continue

    const kind = isUrl ? 'url' : 'path'
    const text = kind === 'url' ? displayText : displayText.replace(/\\ /g, ' ')
    if (kind === 'path' && !isLikelyAbsolutePath(text)) continue
    links.push({
      text,
      target: kind === 'url' ? normalizeUrlTarget(text) : text,
      index,
      displayLength: displayText.length,
      kind,
      fileKind: kind === 'path' ? classifyFileLink(text) : undefined,
    })
  }
  return links
}

/** A logical line of the buffer: its soft-wrapped rows, read as one string. */
type TerminalTextRun = {
  text: string
  startLine: number
  endLine: number
  /** Cell the text starts at on its first row; above 0 once a continuation drops its indent. */
  column: number
}

export type TerminalLinkMatch = {
  link: DetectedTerminalLink
  range: ReturnType<typeof terminalLinkRange>
}

/**
 * Rows an app wraps by itself (Ink, which Claude Code draws with, moves the cursor to the next
 * row instead of letting the terminal wrap) reach the buffer as separate lines. A link is only
 * carried across that break when it runs into the right edge and the next line picks up with
 * a single token, so a new list item or a new link below stays its own line.
 */
const MAX_HARD_WRAP_RUNS = 6
const MAX_CONTINUATION_INDENT = 8
const LIST_MARKER_TOKEN = /^(?:[-*+•●⎿]|\d+[.)])$/
const LINK_START_TOKEN = /^(?:https?:\/\/|[A-Za-z]:\\|\\\\|~\/)/i
const TRAILING_PUNCTUATION_ONLY = /^[),.;:]*$/

function logicalLineAt(buffer: TerminalBuffer, index: number): TerminalTextRun | null {
  let startIndex = index
  if (startIndex < 0 || startIndex >= buffer.length || !buffer.getLine(startIndex)) return null

  while (startIndex > 0 && buffer.getLine(startIndex)?.isWrapped) startIndex -= 1

  let endIndex = startIndex
  while (endIndex + 1 < buffer.length && buffer.getLine(endIndex + 1)?.isWrapped) endIndex += 1

  let text = ''
  for (let row = startIndex; row <= endIndex; row += 1) {
    text += buffer.getLine(row)?.translateToString(row === endIndex) ?? ''
  }

  return { text, startLine: startIndex + 1, endLine: endIndex + 1, column: 0 }
}

export function getLogicalTerminalLine(
  buffer: TerminalBuffer,
  bufferLineNumber: number,
): LogicalTerminalLine | null {
  const run = logicalLineAt(buffer, bufferLineNumber - 1)
  return run ? { text: run.text, startLine: run.startLine } : null
}

/** Apps pad the rest of a row with written spaces, which `translateToString` keeps. */
function rowReachesRightEdge(buffer: TerminalBuffer, index: number, columns: number): boolean {
  const row = buffer.getLine(index)?.translateToString(true).trimEnd() ?? ''
  return row.length >= columns - 1
}

/** The indent to drop when `text` can continue a link cut on the row above, else `null`. */
function continuationIndent(text: string): number | null {
  const indent = text.length - text.trimStart().length
  const token = text.slice(indent).match(/^\S+/)?.[0]
  if (!token || indent > MAX_CONTINUATION_INDENT) return null
  if (LIST_MARKER_TOKEN.test(token) || LINK_START_TOKEN.test(token)) return null
  return indent
}

function linkRunsIntoEdge(runs: readonly TerminalTextRun[]): boolean {
  const text = runs.map((run) => run.text).join('')
  const trimmed = text.trimEnd()
  return detectTerminalLinks(text).some((link) =>
    TRAILING_PUNCTUATION_ONLY.test(trimmed.slice(link.index + link.displayLength)),
  )
}

function hardWrappedChain(
  buffer: TerminalBuffer,
  head: TerminalTextRun,
  columns: number,
): TerminalTextRun[] {
  const runs = [{ ...head }]
  for (let count = 0; count < MAX_HARD_WRAP_RUNS; count += 1) {
    const last = runs[runs.length - 1]
    if (!rowReachesRightEdge(buffer, last.endLine - 1, columns) || !linkRunsIntoEdge(runs)) break
    const next = logicalLineAt(buffer, last.endLine)
    const indent = next ? continuationIndent(next.text) : null
    if (!next || indent === null) break
    last.text = last.text.trimEnd()
    runs.push({ ...next, text: next.text.slice(indent), column: indent })
  }
  return runs
}

/**
 * Links on one buffer row, whole even when the text wraps. Called by the link provider, which
 * xterm only asks on hover — once per row the pointer enters — so the extra rows read for a
 * hard wrap never cost anything while typing or repainting.
 */
export function findTerminalLinks(
  buffer: TerminalBuffer,
  bufferLineNumber: number,
  columns: number,
): TerminalLinkMatch[] {
  const hovered = logicalLineAt(buffer, bufferLineNumber - 1)
  if (!hovered?.text) return []

  let start = hovered
  for (let count = 0; count < MAX_HARD_WRAP_RUNS; count += 1) {
    const aboveIndex = start.startLine - 2
    if (aboveIndex < 0 || !rowReachesRightEdge(buffer, aboveIndex, columns)) break
    if (continuationIndent(start.text) === null) break
    const above = logicalLineAt(buffer, aboveIndex)
    if (!above) break
    start = above
  }

  // The earliest row found above may head a chain that stops short of the hovered row; the
  // next chain then starts right after it.
  for (;;) {
    const runs = hardWrappedChain(buffer, start, columns)
    const last = runs[runs.length - 1]
    if (last.endLine >= bufferLineNumber) return linksOnRow(runs, bufferLineNumber, columns)
    const next = logicalLineAt(buffer, last.endLine)
    if (!next) return []
    start = next
  }
}

function linksOnRow(
  runs: readonly TerminalTextRun[],
  bufferLineNumber: number,
  columns: number,
): TerminalLinkMatch[] {
  const text = runs.map((run) => run.text).join('')
  const matches: TerminalLinkMatch[] = []
  for (const link of detectTerminalLinks(text)) {
    let offset = 0
    for (const run of runs) {
      const from = Math.max(link.index, offset)
      const to = Math.min(link.index + link.displayLength, offset + run.text.length)
      if (from < to) {
        const range = terminalLinkRange(run.startLine, columns, {
          index: run.column + from - offset,
          displayLength: to - from,
        })
        if (range.start.y <= bufferLineNumber && bufferLineNumber <= range.end.y) {
          matches.push({ link, range })
        }
      }
      offset += run.text.length
    }
  }
  return matches
}

export function terminalLinkRange(
  startLine: number,
  columns: number,
  link: Pick<DetectedTerminalLink, 'index' | 'displayLength'>,
) {
  const startOffset = link.index
  const endOffset = link.index + link.displayLength - 1
  return {
    start: { x: (startOffset % columns) + 1, y: startLine + Math.floor(startOffset / columns) },
    end: { x: (endOffset % columns) + 1, y: startLine + Math.floor(endOffset / columns) },
  }
}

/** An OSC 8 hyperlink as the link menu sees it: the app chose the target, so it is used as is. */
export function oscHyperlink(uri: string): DetectedTerminalLink {
  return { text: uri, target: uri, index: 0, displayLength: uri.length, kind: 'url' }
}

/** Builds the xterm `ILink` for a detected link, wired to the link menu. */
export function makeXtermLink(
  match: TerminalLinkMatch,
  handlers: {
    openMenu: (event: MouseEvent, link: DetectedTerminalLink) => void
  },
): ILink {
  return {
    text: match.link.text,
    range: match.range,
    decorations: { pointerCursor: true, underline: true },
    activate: (event: MouseEvent) => handlers.openMenu(event, match.link),
  }
}
