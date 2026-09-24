import type { SavedPosition } from './position'

const INDEX_KEY = 'bar-chess.positions.index'
const SLOT_PREFIX = 'bar-chess.positions.'

export interface SlotMeta {
  id: string
  name: string
  savedAt: number
  /** Turns of undo history stored with the slot (absent for position-only). */
  turns?: number
}

export type SaveResult =
  | { ok: true; slot: SlotMeta; warning?: string }
  | { ok: false; error: string }

function isSlotMeta(value: unknown): value is SlotMeta {
  if (!value || typeof value !== 'object') return false
  const s = value as Partial<SlotMeta>
  return (
    typeof s.id === 'string' &&
    typeof s.name === 'string' &&
    typeof s.savedAt === 'number' &&
    (s.turns === undefined || typeof s.turns === 'number')
  )
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
  // Count real turns, not the opening boundary (which has no recorded ticks).
  const recordedTurns = position.history?.filter((entry) => entry.ticks > 0).length ?? 0
  const hasHistory = recordedTurns > 0
  const fallbackLabel = hasHistory ? `game @ turn ${position.turn}` : `position @ tick ${position.tick}`
  const label = name.trim() || fallbackLabel
  const slots = readIndex()
  const existing = slots.find((s) => s.name === label)
  const id = existing ? existing.id : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const write = (data: SavedPosition, turns: number | undefined): SlotMeta => {
    const slot: SlotMeta = { id, name: label, savedAt: Date.now() }
    if (turns !== undefined) slot.turns = turns
    localStorage.setItem(SLOT_PREFIX + id, JSON.stringify(data))
    writeIndex([...slots.filter((s) => s.id !== id), slot])
    return slot
  }
  try {
    return { ok: true, slot: write(position, recordedTurns || undefined) }
  } catch (error) {
    // Most likely the storage quota: the full history is large, so fall back to
    // a position-only save rather than losing the slot entirely.
    if (hasHistory) {
      try {
        const positionOnly: SavedPosition = { ...position }
        delete positionOnly.history
        delete positionOnly.cursor
        const slot = write(positionOnly, undefined)
        return { ok: true, slot, warning: 'saved position only — storage is full' }
      } catch {
        // Fall through to the original error below.
      }
    }
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
