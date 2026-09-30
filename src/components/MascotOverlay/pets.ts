import claudinoUrl from '../../assets/pets/claudino.webp'
import gremlinUrl from '../../assets/pets/gremlin.webp'
import opencodeUrl from '../../assets/pets/opencode.webp'
import type { MascotPetId } from '../../lib/types'

// Animated WebP artwork from the Orca project (MIT) — see src/assets/pets/LICENSE.
// The browser plays these on its own; no per-frame JavaScript is involved.
export type BundledPet = {
  id: Exclude<MascotPetId, 'custom'>
  /** Proper names, identical in every locale. */
  label: string
  url: string
}

export const BUNDLED_PETS: readonly BundledPet[] = [
  { id: 'claudino', label: 'Claudino', url: claudinoUrl },
  { id: 'opencode', label: 'OpenCode', url: opencodeUrl },
  { id: 'gremlin', label: 'Gremlin', url: gremlinUrl },
]

export function resolvePetUrl(petId: MascotPetId, customImage: string): string {
  if (petId === 'custom' && customImage) return customImage
  const pet = BUNDLED_PETS.find((p) => p.id === petId)
  return (pet ?? BUNDLED_PETS[0]).url
}
