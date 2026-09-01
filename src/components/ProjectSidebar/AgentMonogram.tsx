import { type AgentType } from '../../lib/types'
import styles from './NormalProjectSidebar.module.css'

// Two letters instead of a logo, for the sidebar only.
//
// The row draws the agent at 14px inside a 15px box, and most of the icons are
// PNGs of detailed marks — at that size Claude, Codex and Antigravity all
// reduce to the same smudge. A monogram is legible at the size it is actually
// drawn, and it survives being the wrong color: someone who cannot tell the
// orange from the cyan still reads CC and CX. Every other surface draws the
// real icon at 16px and keeps it.

const MONOGRAMS: Record<AgentType, string> = {
  claude: 'CC',
  codex: 'CX',
  opencode: 'OC',
  copilot: 'GH',
  antigravity: 'AG',
  freebuff: 'FB',
  mimo: 'MI',
  shell: '>_',
}

export function AgentMonogram({ type }: { type: AgentType }) {
  return (
    <span className={styles.agentMonogram} data-agent={type} aria-hidden="true">
      {MONOGRAMS[type] ?? '??'}
    </span>
  )
}
