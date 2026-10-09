import { describe, expect, it } from 'vitest'

import { nextDefaultGroupName } from './groupNames'

const named = (...names: string[]) => names.map((name) => ({ name }))

describe('nextDefaultGroupName', () => {
  it('uses the bare name while no front has it', () => {
    expect(nextDefaultGroupName(named('cpf opcional'), 'Main')).toBe('Main')
  })

  it('numbers from 2 once the bare name is taken', () => {
    expect(nextDefaultGroupName(named('Main'), 'Main')).toBe('Main 2')
    expect(nextDefaultGroupName(named('Main', 'Main 2'), 'Main')).toBe('Main 3')
  })

  it('takes back the lowest number a closed front left free', () => {
    expect(nextDefaultGroupName(named('Main', 'Main 3'), 'Main')).toBe('Main 2')
  })
})
