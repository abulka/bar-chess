import type { SavedPosition } from './position'
import {
  idbDelete,
  idbGet,
  idbGetAll,
  idbPut,
  newId,
  SAVES_STORE,
  SAVE_INDEX_STORE,
} from './idb'

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

interface SaveRecord {
  id: string
  data: SavedPosition
}

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

async function readIndex(): Promise<SlotMeta[]> {
  try {
    const all = await idbGetAll<unknown>(SAVE_INDEX_STORE)
    return all.filter(isSlotMeta)
  } catch {
    return []
  }
}

/** Saved slots, newest first. */
export async function listSlots(): Promise<SlotMeta[]> {
  return (await readIndex()).sort((a, b) => b.savedAt - a.savedAt)
}

export async function saveSlot(name: string, position: SavedPosition): Promise<SaveResult> {
  // Count real turns, not the opening boundary (which has no recorded ticks).
  const recordedTurns = position.history?.filter((entry) => entry.ticks > 0).length ?? 0
  const hasHistory = recordedTurns > 0
  const fallbackLabel = hasHistory ? `game @ turn ${position.turn}` : `position @ tick ${position.tick}`
  const label = name.trim() || fallbackLabel
  const slots = await readIndex()
  const existing = slots.find((s) => s.name === label)
  const id = existing ? existing.id : newId()
  const write = async (data: SavedPosition, turns: number | undefined): Promise<SlotMeta> => {
    const slot: SlotMeta = { id, name: label, savedAt: Date.now() }
    if (turns !== undefined) slot.turns = turns
    await idbPut<SaveRecord>(SAVES_STORE, { id, data })
    await idbPut<SlotMeta>(SAVE_INDEX_STORE, slot)
    return slot
  }
  try {
    return { ok: true, slot: await write(position, recordedTurns || undefined) }
  } catch (error) {
    // Most likely the storage quota: the full history is large, so fall back to
    // a position-only save rather than losing the slot entirely.
    if (hasHistory) {
      try {
        const positionOnly: SavedPosition = { ...position }
        delete positionOnly.history
        delete positionOnly.cursor
        const slot = await write(positionOnly, undefined)
        return { ok: true, slot, warning: 'saved position only — storage is full' }
      } catch {
        // Fall through to the original error below.
      }
    }
    return { ok: false, error: error instanceof Error ? error.message : 'could not save' }
  }
}

export async function loadSlot(id: string): Promise<SavedPosition | null> {
  try {
    const record = await idbGet<SaveRecord>(SAVES_STORE, id)
    return record ? record.data : null
  } catch {
    return null
  }
}

export async function deleteSlot(id: string): Promise<void> {
  try {
    await idbDelete(SAVES_STORE, id)
    await idbDelete(SAVE_INDEX_STORE, id)
  } catch {
    // Non-fatal: the index read filters missing records.
  }
}
