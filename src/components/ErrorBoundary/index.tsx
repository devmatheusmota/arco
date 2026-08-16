import { Component, type ErrorInfo, type ReactNode } from 'react'

import { getLocale, type MessageKey, translate } from '../../lib/i18n'
import { recordFrontendError } from '../../lib/tauri'
import styles from './ErrorBoundary.module.css'

type Props = {
  children: ReactNode
  /** Optional log label, such as "view" or "modals". */
  label?: string
}

type State = {
  error: Error | null
}

/** Convert render errors into a themed fallback and a persisted diagnostic log. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const kind = this.props.label ? `react:${this.props.label}` : 'react'
    if (import.meta.env.DEV) {
      console.groupCollapsed(`[Arco][${kind}] render error`)
      console.error(error)
      console.info('componentStack:', info.componentStack)
      console.info('location:', window.location.href)
      console.groupEnd()
    }
    void recordFrontendError(
      error.message || String(error),
      error.stack ?? info.componentStack ?? null,
      kind,
    )
  }

  private reset = () => this.setState({ error: null })
  private reload = () => window.location.reload()

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    // Class components cannot use hooks; translate() reads the locale from the store.
    const locale = getLocale()
    const tr = (key: MessageKey) => translate(locale, key)

    return (
      <div className={styles.wrap} role="alert">
        <div className={styles.card}>
          <h2 className={styles.title}>{tr('errorBoundary.title')}</h2>
          <p className={styles.body}>{tr('errorBoundary.body')}</p>
          {error.message ? <pre className={styles.detail}>{error.message}</pre> : null}
          <div className={styles.actions}>
            <button type="button" className={styles.btn} onClick={this.reset}>
              {tr('errorBoundary.retry')}
            </button>
            <button type="button" className={styles.btnPrimary} onClick={this.reload}>
              {tr('errorBoundary.reload')}
            </button>
          </div>
        </div>
      </div>
    )
  }
}
