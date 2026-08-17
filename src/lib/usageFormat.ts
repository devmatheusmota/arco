import { getLocale, translate } from './i18n'

/** Placeholder shown when a usage window has no known reset time. */
const UNKNOWN = '—'

/**
 * Format a millisecond delta until a usage window resets.
 * Non-finite deltas render as {@link UNKNOWN} instead of leaking `NaN` into the UI.
 */
export function formatResetDiff(diff: number): string {
  if (!Number.isFinite(diff)) return UNKNOWN
  if (diff <= 0) return translate(getLocale(), 'widget.resetting')
  const h = Math.floor(diff / 3_600_000)
  const m = Math.floor((diff % 3_600_000) / 60_000)
  if (h >= 24) {
    const d = Math.floor(h / 24)
    return `${d}d ${h % 24}h`
  }
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

/** Format the time until an ISO-8601 reset timestamp. Empty or unparseable input yields {@link UNKNOWN}. */
export function formatResetIso(resetsAt: string | null | undefined): string {
  if (!resetsAt) return UNKNOWN
  return formatResetDiff(new Date(resetsAt).getTime() - Date.now())
}

/** Format the time until an epoch-millisecond reset timestamp. Zero or invalid input yields {@link UNKNOWN}. */
export function formatResetMs(resetsAtMs: number | null | undefined): string {
  if (!resetsAtMs || !Number.isFinite(resetsAtMs)) return UNKNOWN
  return formatResetDiff(resetsAtMs - Date.now())
}
