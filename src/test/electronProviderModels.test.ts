import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

type Model = { id: string; label: string }

const require = createRequire(import.meta.url)
const { codexModels, opencodeModels } = require('../../electron/commands/platform.cjs') as {
  codexModels: (catalog: unknown) => Model[]
  opencodeModels: (stdout: unknown) => Model[]
}

describe('codexModels', () => {
  it('lists what the Codex picker lists, in its order', () => {
    const models = codexModels({
      models: [
        { slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', visibility: 'list', priority: 3 },
        { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', priority: 4 },
        { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', priority: 0 },
      ],
    })

    expect(models).toEqual([
      { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
      { id: 'gpt-6-sol', label: 'GPT-6-Sol' },
    ])
  })

  it('answers with nothing when the catalog was never cached', () => {
    expect(codexModels(null)).toEqual([])
  })
})

describe('opencodeModels', () => {
  it('keeps the provider/model lines and drops the rest', () => {
    const models = opencodeModels(
      'anthropic/claude-opus-5-5\n\nopenrouter/meta-llama/llama-3.3-70b:free\nError: offline\n',
    )

    expect(models.map((model) => model.id)).toEqual([
      'anthropic/claude-opus-5-5',
      'openrouter/meta-llama/llama-3.3-70b:free',
    ])
  })
})
