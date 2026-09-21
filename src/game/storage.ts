import type { SavedPosition } from './position'

const INDEX_KEY = 'bar-chess.positions.index'
const SLOT_PREFIX = 'bar-chess.positions.'

export interface SlotMeta {
  id: string
  name: string
  savedAt: number
}

export type SaveResult = { ok: true; slot: SlotMeta } | { ok: false; error: string }

function isSlotMeta(value: unknown): value is SlotMeta {
  if (!value || typeof value !== 'object') return false
  const s = value as Partial<SlotMeta>
  return typeof s.id === 'string' && typeof s.name === 'string' && typeof s.savedAt === 'number'
}

function readIndex(): SlotMeta[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isSlotMeta) : []
  } catch {
    return []
  }
}

function writeIndex(slots: SlotMeta[]): void {
  localStorage.setItem(INDEX_KEY, JSON.stringify(slots))
}

/** Saved slots, newest first. */
export function listSlots(): SlotMeta[] {
  return readIndex().sort((a, b) => b.savedAt - a.savedAt)
}

export function saveSlot(name: string, position: SavedPosition): SaveResult {
  const label = name.trim() || `position @ tick ${position.tick}`
  const slots = readIndex()
  const existing = slots.find((s) => s.name === label)
  const id = existing ? existing.id : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const slot: SlotMeta = { id, name: label, savedAt: Date.now() }
  try {
    localStorage.setItem(SLOT_PREFIX + id, JSON.stringify(position))
    writeIndex([...slots.filter((s) => s.id !== id), slot])
    return { ok: true, slot }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'could not save' }
  }
}

export function loadSlot(id: string): SavedPosition | null {
  try {
    const raw = localStorage.getItem(SLOT_PREFIX + id)
    return raw ? (JSON.parse(raw) as SavedPosition) : null
  } catch {
    return null
  }
}

export function deleteSlot(id: string): void {
  localStorage.removeItem(SLOT_PREFIX + id)
  writeIndex(readIndex().filter((s) => s.id !== id))
}
