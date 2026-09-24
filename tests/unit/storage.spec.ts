import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../../src/game/idb'
import type { SavedPosition } from '../../src/game/position'
import { deleteSlot, listSlots, loadSlot, saveSlot } from '../../src/game/storage'

async function clearStores(): Promise<void> {
  const db = await openDb()
  await Promise.all(
    ['saves', 'saveIndex', 'maps'].map(
      (name) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction(name, 'readwrite')
          tx.objectStore(name).clear()
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
        }),
    ),
  )
}

const position = (tick: number): SavedPosition => ({ version: 1, tick }) as unknown as SavedPosition

describe('position storage', () => {
  beforeEach(clearStores)

  it('saves, lists, loads and deletes slots', async () => {
    const result = await saveSlot('alpha', position(5))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect((await listSlots()).map((s) => s.name)).toEqual(['alpha'])
    expect((await loadSlot(result.slot.id))?.tick).toBe(5)

    await deleteSlot(result.slot.id)
    expect(await listSlots()).toEqual([])
    expect(await loadSlot(result.slot.id)).toBeNull()
  })

  it('overwrites a same-named slot instead of duplicating it', async () => {
    const first = await saveSlot('alpha', position(5))
    const second = await saveSlot('alpha', position(9))
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return

    expect(second.slot.id).toBe(first.slot.id)
    expect(await listSlots()).toHaveLength(1)
    expect((await loadSlot(second.slot.id))?.tick).toBe(9)
  })

  it('falls back to a generated name for a blank slot name', async () => {
    const result = await saveSlot('   ', position(12))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.slot.name).toContain('12')
  })

  it('reports a write failure instead of throwing', async () => {
    // A function cannot be structured-cloned, so the write rejects.
    const broken = { version: 1, tick: 1, boom: () => 0 } as unknown as SavedPosition
    const result = await saveSlot('beta', broken)
    expect(result.ok).toBe(false)
  })

  it('saves the turn count for a full game and loads its history', async () => {
    const game = { ...position(7), turn: 7, history: [{ ticks: 40 }], cursor: 0 } as unknown as SavedPosition
    const result = await saveSlot('full', game)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.slot.turns).toBe(1)

    const loaded = await loadSlot(result.slot.id)
    expect(loaded?.history).toHaveLength(1)
    expect(loaded?.cursor).toBe(0)
  })

  it('falls back to a position-only save when storage rejects the history', async () => {
    // Only the history carries the non-cloneable value, so the retry succeeds.
    const game = {
      ...position(7),
      turn: 7,
      history: [{ ticks: 40, bomb: () => 0 }],
      cursor: 0,
    } as unknown as SavedPosition
    const result = await saveSlot('full', game)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warning).toContain('storage is full')
    expect(result.slot.turns).toBeUndefined()
    expect((await loadSlot(result.slot.id))?.history).toBeUndefined()
  })
})
