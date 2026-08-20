import { type ReactNode } from 'react'

import { colorFor, personaIconFor } from '../../lib/agentCanvasUtils'
import type { AgentTemplate } from '../../lib/agentLibrary'
import { useT } from '../../lib/i18n'
import styles from './AgentCanvasPOC.module.css'

export type AgentChipProps = {
  name: string
  cost?: AgentTemplate['cost']
  summary?: string
  installed?: boolean
  foreign?: boolean
  draggable?: boolean
  dragging?: boolean
  ghost?: boolean
  action: ReactNode
}

/** Agent chip with persona icon, name, cost, and install/remove action. */
export function AgentChip({
  name,
  cost,
  summary,
  installed = false,
  foreign = false,
  draggable = false,
  dragging = false,
  ghost = false,
  action,
}: AgentChipProps) {
  const t = useT()
  const Icon = personaIconFor(name)
  const costClass = cost === 'barato' ? styles.costCheap : styles.costExpensive
  return (
    <div
      className={[
        styles.agentChip,
        installed ? styles.agentChipInstalled : '',
        draggable ? styles.agentChipDraggable : '',
        ghost ? styles.agentChipGhost : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        ['--agent-color' as string]: colorFor(name),
        opacity: dragging ? 0.35 : undefined,
      }}
      title={summary}
    >
      <span className={styles.personaToken} aria-hidden="true">
        <Icon size={14} />
      </span>
      <span className={styles.agentChipName}>{name}</span>
      {cost ? <span className={costClass}>{cost}</span> : null}
      {foreign ? <span className={styles.chipForeign}>{t('ws.external')}</span> : null}
      <span className={styles.agentChipAction}>{action}</span>
    </div>
  )
}
