import { Fragment } from 'react'

import { useT } from '../../lib/i18n'
import type { McpView } from '../../stores/mcpStore'
import styles from './McpPanel.module.css'

type Props = {
  value: McpView
  projectAvailable: boolean
  onChange: (view: McpView) => void
}

/**
 * All first, then narrower buckets. Plugins get their own: they come from installed
 * plugins rather than a file the user wrote, and they cannot be edited here.
 */
const VIEWS: readonly McpView[] = ['all', 'project', 'global', 'plugins']

const LABEL_KEY = {
  all: 'mcp.scopeAll',
  project: 'mcp.scopeProject',
  global: 'mcp.scopeGlobal',
  plugins: 'mcp.scopePlugins',
} as const satisfies Record<McpView, string>

const HINT_KEY = {
  all: 'mcp.scopeAllHint',
  project: 'mcp.scopeProjectHint',
  global: 'mcp.scopeGlobalHint',
  plugins: 'mcp.scopePluginsHint',
} as const satisfies Record<McpView, string>

export function ScopeSwitch({ value, projectAvailable, onChange }: Props) {
  const t = useT()
  return (
    <span className={styles.scopeToggle} role="group" aria-label={t('mcp.scopeLabel')}>
      {VIEWS.map((view, index) => {
        const unavailable = view === 'project' && !projectAvailable
        return (
          // Fragment, not a wrapper element: `.scopeToggle` lays its children out as
          // a flex row, and an extra span would collapse the buttons into one cell.
          <Fragment key={view}>
            {index > 0 ? <i aria-hidden /> : null}
            <button
              type="button"
              aria-pressed={value === view}
              disabled={unavailable}
              onClick={() => onChange(view)}
              title={unavailable ? t('mcp.scopeProjectUnavailable') : t(HINT_KEY[view])}
            >
              {t(LABEL_KEY[view])}
            </button>
          </Fragment>
        )
      })}
    </span>
  )
}
