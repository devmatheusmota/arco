export const ARCO_FILE_DRAG_TYPE = 'application/x-arco-file'

export type ArcoFileDragPayload = {
  projectId: string
  path: string
}

export function writeFileDragPayload(
  dataTransfer: DataTransfer,
  payload: ArcoFileDragPayload,
): void {
  dataTransfer.effectAllowed = 'copy'
  dataTransfer.setData(ARCO_FILE_DRAG_TYPE, JSON.stringify(payload))
  dataTransfer.setData('text/plain', payload.path)
}

export function readFileDragPayload(dataTransfer: DataTransfer): ArcoFileDragPayload | null {
  const raw = dataTransfer.getData(ARCO_FILE_DRAG_TYPE)
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<ArcoFileDragPayload>
    if (typeof value.projectId !== 'string' || typeof value.path !== 'string') return null
    const projectId = value.projectId.trim()
    const path = value.path.trim()
    return projectId && path ? { projectId, path } : null
  } catch {
    return null
  }
}

export function hasFileDragPayload(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(ARCO_FILE_DRAG_TYPE)
}
