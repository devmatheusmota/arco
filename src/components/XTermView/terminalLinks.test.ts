import { describe, expect, it } from 'vitest'

import {
  detectTerminalLinks,
  findTerminalLinks,
  getLogicalTerminalLine,
  terminalLinkRange,
} from './terminalLinks'

const PR_URL =
  'https://dev.azure.com/example-org/agentic-product-os/_git/emr-agent-skills/pullrequest/11350'

/** A buffer whose rows were written separately, the way Ink wraps text itself. */
function bufferOf(rows: Array<string | { value: string; isWrapped: boolean }>) {
  const lines = rows.map((row) =>
    typeof row === 'string' ? { value: row, isWrapped: false } : row,
  )
  return {
    length: lines.length,
    getLine: (index: number) => {
      const line = lines[index]
      return line ? { isWrapped: line.isWrapped, translateToString: () => line.value } : undefined
    },
  }
}

function targetsOnRow(buffer: ReturnType<typeof bufferOf>, row: number, columns: number) {
  return findTerminalLinks(buffer, row, columns).map((match) => match.link.target)
}

describe('terminal links', () => {
  it('ends URLs at whitespace while preserving spaces inside local paths', () => {
    expect(detectTerminalLinks('https://github.com/login/device in your browser...')).toEqual([
      expect.objectContaining({
        text: 'https://github.com/login/device',
        displayLength: 'https://github.com/login/device'.length,
      }),
    ])
    expect(detectTerminalLinks('(https://github.com/login/device in your browser)')[0].text).toBe(
      'https://github.com/login/device',
    )
    expect(detectTerminalLinks('D:\\public launch\\src\\file.ts')).toEqual([
      expect.objectContaining({ text: 'D:\\public launch\\src\\file.ts', kind: 'path' }),
    ])
    expect(
      detectTerminalLinks('"D:\\tmp\\shot-lab-strips\\ um PNG por shot, nome = slug."')[0],
    ).toEqual(
      expect.objectContaining({
        text: 'D:\\tmp\\shot-lab-strips\\',
        target: 'D:\\tmp\\shot-lab-strips\\',
        kind: 'path',
      }),
    )
  })

  it('detects mixed-case protocols and bare deployment domains', () => {
    const links = detectTerminalLinks(
      'Deploy em verzel-elite-dev-painel.vercel.app (Https://verzel-elite-dev-painel.vercel.app).',
    )

    expect(links).toEqual([
      expect.objectContaining({
        text: 'verzel-elite-dev-painel.vercel.app',
        target: 'https://verzel-elite-dev-painel.vercel.app',
        kind: 'url',
      }),
      expect.objectContaining({
        text: 'Https://verzel-elite-dev-painel.vercel.app',
        target: 'https://verzel-elite-dev-painel.vercel.app',
        kind: 'url',
      }),
    ])
    expect(detectTerminalLinks('localhost:5173/dashboard')[0]).toEqual(
      expect.objectContaining({ target: 'http://localhost:5173/dashboard', kind: 'url' }),
    )
  })

  it('reconstructs viewport-wrapped lines and creates a multiline range', () => {
    const values = [
      { value: 'go https:/', isWrapped: false },
      { value: '/example.c', isWrapped: true },
      { value: 'om/docs', isWrapped: true },
    ]
    const buffer = {
      length: values.length,
      getLine: (index: number) => {
        const line = values[index]
        return line ? { isWrapped: line.isWrapped, translateToString: () => line.value } : undefined
      },
    }

    const logicalLine = getLogicalTerminalLine(buffer, 2)
    expect(logicalLine).toEqual({ text: 'go https://example.com/docs', startLine: 1 })
    const [link] = detectTerminalLinks(logicalLine!.text)
    expect(terminalLinkRange(logicalLine!.startLine, 10, link)).toEqual({
      start: { x: 4, y: 1 },
      end: { x: 7, y: 3 },
    })
  })

  it('carries a URL across the row an app broke itself, from either row', () => {
    // Claude Code moves the cursor down instead of letting the terminal wrap.
    const head = `  ${PR_URL.slice(0, 57)}`
    const tail = `  ${PR_URL.slice(57)}`
    const buffer = bufferOf([head, tail, '', '  - Título: algo'])

    expect(findTerminalLinks(buffer, 1, head.length)).toEqual([
      {
        link: expect.objectContaining({ target: PR_URL }),
        range: { start: { x: 3, y: 1 }, end: { x: head.length, y: 1 } },
      },
    ])
    expect(findTerminalLinks(buffer, 2, head.length)).toEqual([
      {
        link: expect.objectContaining({ target: PR_URL }),
        range: { start: { x: 3, y: 2 }, end: { x: tail.length, y: 2 } },
      },
    ])
  })

  it('joins past written padding, a bullet, and a tail that starts with a slash', () => {
    const cut = PR_URL.indexOf('/_git')
    const bullet = `● ${PR_URL.slice(0, cut)}`
    const buffer = bufferOf([bullet, `  ${PR_URL.slice(cut)}                  `])
    expect(targetsOnRow(buffer, 1, bullet.length)).toEqual([PR_URL])
    // Alone, the tail used to read as a local path.
    expect(targetsOnRow(buffer, 2, bullet.length)).toEqual([PR_URL])

    const echo = bufferOf([`  ${PR_URL.slice(0, 57)} `, `  ${PR_URL.slice(57)}`])
    expect(targetsOnRow(echo, 2, 60)).toEqual([PR_URL])
  })

  it('follows a link over several broken rows and joins a broken path', () => {
    const rows = ['  https://example.com/aaaaaaaaaa', '  bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '  cccc']
    const buffer = bufferOf(rows)
    const target = 'https://example.com/aaaaaaaaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbcccc'
    expect(targetsOnRow(buffer, 3, 32)).toEqual([target])
    expect(targetsOnRow(buffer, 1, 32)).toEqual([target])

    const path = bufferOf([
      ' /tmp/arco-build/cache/5f0e2c1a-9b7d-4c3e-8a61-0f4b2e7d9c35/',
      ' repro/readme.md',
    ])
    expect(findTerminalLinks(path, 2, 61)[0].link).toEqual(
      expect.objectContaining({
        target: '/tmp/arco-build/cache/5f0e2c1a-9b7d-4c3e-8a61-0f4b2e7d9c35/repro/readme.md',
        fileKind: 'markdown',
      }),
    )
  })

  it('leaves the row below alone when it is not the rest of the link', () => {
    const head = `  ${PR_URL.slice(0, 57)}`
    const cut = PR_URL.slice(0, 57)
    expect(targetsOnRow(bufferOf([head, '  - Título: algo']), 1, head.length)).toEqual([cut])
    expect(targetsOnRow(bufferOf([head, '  https://outra.com/x']), 2, head.length)).toEqual([
      'https://outra.com/x',
    ])
    // Short of the edge, the next row is a new line of prose.
    expect(targetsOnRow(bufferOf(['  veja https://x.com/a', '  continua']), 1, 40)).toEqual([
      'https://x.com/a',
    ])
    expect(targetsOnRow(bufferOf(['  veja https://x.com/a', '  continua']), 2, 40)).toEqual([])
  })

  it('keeps escaped spaces in the visual range and unescapes the opened path', () => {
    const [link] = detectTerminalLinks('/tmp/my\\ file/readme.md')
    expect(link.text).toBe('/tmp/my file/readme.md')
    expect(link.displayLength).toBe('/tmp/my\\ file/readme.md'.length)
    expect(link.fileKind).toBe('markdown')
  })

  it('classifies path links by extension', () => {
    expect(detectTerminalLinks('/tmp/shot.png')[0].fileKind).toBe('image')
    expect(detectTerminalLinks('/tmp/main.ts:42:10')[0].fileKind).toBe('text')
    expect(detectTerminalLinks('/tmp/notes.md')[0].fileKind).toBe('markdown')
    expect(detectTerminalLinks('/tmp/trailer.mp4')[0].fileKind).toBe('video')
    expect(
      detectTerminalLinks(
        'Jogado em D:\\user\\Vaults\\Nostromo\\40-Conteudo\\youtube\\projecao-canal.md com as duas projeções',
      )[0].text,
    ).toBe('D:\\user\\Vaults\\Nostromo\\40-Conteudo\\youtube\\projecao-canal.md')
    expect(
      detectTerminalLinks('D:\\user\\Videos\\motion-kit-hype-video.mp4 e escuta')[0].text,
    ).toBe('D:\\user\\Videos\\motion-kit-hype-video.mp4')
    expect(detectTerminalLinks('https://example.com/x')[0].fileKind).toBeUndefined()
  })

  it('stops an extensionless path at the first space instead of eating the sentence', () => {
    const [link] = detectTerminalLinks(
      '/pt-br/vitrine-dupla/trajetoria — 5 variações de trajetória',
    )
    expect(link.text).toBe('/pt-br/vitrine-dupla/trajetoria')

    expect(detectTerminalLinks('/api/users retorna 401 quando o token expira')[0].text).toBe(
      '/api/users',
    )
    expect(detectTerminalLinks('~/projetos/arco roda em dev e em prod')[0].text).toBe(
      '~/projetos/arco',
    )
  })

  it('still crosses a space when a file extension is waiting on the other side', () => {
    expect(detectTerminalLinks('/tmp/my folder/readme.md')[0].text).toBe('/tmp/my folder/readme.md')
    expect(detectTerminalLinks('D:\\public launch\\src\\file.ts')[0].text).toBe(
      'D:\\public launch\\src\\file.ts',
    )
  })

  it('does not turn prose slashes into links', () => {
    expect(detectTerminalLinks('/ Zambia / India')).toEqual([])
    expect(detectTerminalLinks('IP residencial/mobile + UA')).toEqual([])
    expect(detectTerminalLinks('foo/bar')).toEqual([])
    expect(detectTerminalLinks('src/file.ts package.json user@example.com')).toEqual([])
  })
})
