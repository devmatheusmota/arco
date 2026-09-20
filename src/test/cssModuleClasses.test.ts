import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Every `styles.foo` a component reads has to exist in the stylesheet it reads
 * it from.
 *
 * A CSS Module hands back `undefined` for a class nobody wrote, and `undefined`
 * in a `className` is silent: TypeScript sees a `Record<string, string>`, the
 * linter sees a property access, and the build has nothing to complain about.
 * The whole gate goes green while the layout collapses on screen — which is
 * exactly how a sidebar shipped with none of its rows styled.
 */

const SRC = resolve(process.cwd(), 'src')

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return walk(full)
    return full.endsWith('.tsx') || full.endsWith('.ts') ? [full] : []
  })
}

/** Class names a stylesheet defines, including those in grouped selectors. */
function definedClasses(cssPath: string): Set<string> {
  const css = readFileSync(cssPath, 'utf8')
  // Strip comments first, or a class named inside one counts as defined.
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '')
  return new Set([...body.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((match) => match[1]))
}

type Offender = { file: string; stylesheet: string; missing: string[] }

function findOffenders(): Offender[] {
  const offenders: Offender[] = []
  for (const file of walk(SRC)) {
    if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue
    const source = readFileSync(file, 'utf8')
    // Every stylesheet import, under whatever name it was given. Checking only
    // the one called `styles` is how a modal shipped with `controls.btn`
    // pointing at a sheet that has no buttons in it.
    const imports = [...source.matchAll(/import\s+(\w+)\s+from\s+'([^']+\.module\.css)'/g)]
    for (const [, alias, request] of imports) {
      const stylesheet = resolve(dirname(file), request)
      if (!existsSync(stylesheet)) {
        offenders.push({
          file: file.slice(SRC.length + 1),
          stylesheet: request,
          missing: ['<a folha não existe>'],
        })
        continue
      }
      const defined = definedClasses(stylesheet)
      // Without dropping the import lines first, `controls.module` inside
      // `'./controls.module.css'` reads as a class called `module`.
      const body = source.replace(/^\s*import[\s\S]*?from\s+'[^']*'\s*$/gm, '')
      const used = new Set(
        [...body.matchAll(new RegExp(`\\b${alias}\\.([a-zA-Z_]\\w*)`, 'g'))].map((m) => m[1]),
      )
      const missing = [...used].filter((name) => !defined.has(name)).sort()
      if (missing.length > 0) {
        offenders.push({
          file: file.slice(SRC.length + 1),
          stylesheet: stylesheet.slice(SRC.length + 1),
          missing,
        })
      }
    }
  }
  return offenders
}

describe('CSS Module classes', () => {
  it('are all defined in the stylesheet the component imports', () => {
    const offenders = findOffenders()
    const report = offenders
      .map((o) => `${o.file} → ${o.stylesheet}: ${o.missing.join(', ')}`)
      .join('\n')
    expect(report).toBe('')
  })

  it('actually looks at a meaningful number of components', () => {
    // A rewrite of the walk that quietly stops finding files would make the
    // check above pass by looking at nothing.
    const withStyles = walk(SRC).filter((file) =>
      /import\s+\w+\s+from\s+'[^']+\.module\.css'/.test(readFileSync(file, 'utf8')),
    )
    expect(withStyles.length).toBeGreaterThan(30)
  })
})
