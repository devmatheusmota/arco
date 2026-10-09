import type { PaneGroup } from './types'

/**
 * The name a front takes when nobody typed one: `base`, then `base 2`,
 * `base 3`… — the lowest number no front of the project already uses, so
 * closing "Main 2" lets the next unnamed front take that name back.
 */
export function nextDefaultGroupName(groups: readonly Pick<PaneGroup, 'name'>[], base: string) {
  const taken = new Set(groups.map((group) => group.name.trim()))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base} ${n}`)) n += 1
  return `${base} ${n}`
}
