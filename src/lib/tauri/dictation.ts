import { invoke } from '@tauri-apps/api/core'

export type DictationStatus = {
  /** Whether the on-device model was found in any of the searched directories. */
  modelFound: boolean
  modelDir: string | null
  /** Whether the model is already resident — a cold load reads 622 MB. */
  modelLoaded: boolean
  capturing: boolean
}

export async function dictationStatus(model: string): Promise<DictationStatus> {
  return invoke<DictationStatus>('dictation_status', { model })
}

/** Loads the model ahead of the first hold so speaking does not wait on disk. */
export async function dictationPreload(model: string): Promise<void> {
  await invoke('dictation_preload', { model })
}

export async function dictationStart(model: string): Promise<void> {
  await invoke('dictation_start', { model })
}

/** Stops capture and resolves with the transcript, empty when nothing was said. */
export async function dictationStop(model: string): Promise<string> {
  return invoke<string>('dictation_stop', { model })
}

/** Drops capture without transcribing. */
export async function dictationCancel(): Promise<void> {
  await invoke('dictation_cancel')
}

export type SpeechModel = {
  id: string
  label: string
  description: string
  language: string
  streaming: boolean
  recommended: boolean
  sizeBytes: number
  installed: boolean
  /** Bytes on disk, counting a partial download. */
  localBytes: number
}

export type DownloadProgress = {
  id: string
  received: number
  total: number
  file: string
  done: boolean
  error: string | null
}

export async function dictationModels(): Promise<SpeechModel[]> {
  return invoke<SpeechModel[]>('dictation_models')
}

export async function dictationDownload(id: string): Promise<void> {
  await invoke('dictation_download', { id })
}

export async function dictationDelete(id: string): Promise<void> {
  await invoke('dictation_delete', { id })
}
