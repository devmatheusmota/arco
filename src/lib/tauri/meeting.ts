import { invoke } from '@tauri-apps/api/core'

export type MeetingStatus = {
  /** Whether `meetscribe` is installed on this machine. */
  available: boolean
  recording: boolean
  /** The transcript being written, or the last one after stopping. */
  file: string | null
  /** Audio blocks still queued in the model. */
  pending: number
  /** Trouble `meetscribe` reports about the capture itself. */
  warning?: string
}

export async function meetingStatus(): Promise<MeetingStatus> {
  return invoke<MeetingStatus>('meeting_status')
}

/** Records the system output and, unless `mic` is false, the microphone too. */
export async function meetingStart(mic = true): Promise<MeetingStatus> {
  return invoke<MeetingStatus>('meeting_start', { mic })
}

/** Stops the capture, waits for the transcription to drain, names the file. */
export async function meetingStop(): Promise<{ file: string | null }> {
  return invoke<{ file: string | null }>('meeting_stop')
}
