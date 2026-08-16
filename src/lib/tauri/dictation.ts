import { invoke } from '@tauri-apps/api/core'

export type DictationStatus = {
  /** Whether the on-device model was found in any of the searched directories. */
  modelFound: boolean
  modelDir: string | null
  /** Whether the model is already resident — a cold load reads 622 MB. */
  modelLoaded: boolean
  capturing: boolean
}

export async function dictationStatus(): Promise<DictationStatus> {
  return invoke<DictationStatus>('dictation_status')
}

/** Loads the model ahead of the first hold so speaking does not wait on disk. */
export async function dictationPreload(): Promise<void> {
  await invoke('dictation_preload')
}

export async function dictationStart(): Promise<void> {
  await invoke('dictation_start')
}

/** Stops capture and resolves with the transcript, empty when nothing was said. */
export async function dictationStop(): Promise<string> {
  return invoke<string>('dictation_stop')
}

/** Drops capture without transcribing. */
export async function dictationCancel(): Promise<void> {
  await invoke('dictation_cancel')
}
