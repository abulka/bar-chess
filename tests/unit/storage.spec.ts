// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SavedPosition } from '../../src/game/position'
import { deleteSlot, listSlots, loadSlot, saveSlot } from '../../src/game/storage'

const position = (tick: number): SavedPosition => ({ version: 1, tick }) as unknown as SavedPosition

describe('position storage', () => {
  beforeEach(() => localStorage.clear())

  it('saves, lists, loads and deletes slots', () => {
    const result = saveSlot('alpha', position(5))
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(listSlots().map((s) => s.name)).toEqual(['alpha'])
    expect(loadSlot(result.slot.id)?.tick).toBe(5)

    deleteSlot(result.slot.id)
    expect(listSlots()).toEqual([])
    expect(loadSlot(result.slot.id)).toBeNull()
  })

  it('overwrites a same-named slot instead of duplicating it', () => {
    const first = saveSlot('alpha', position(5))
    const second = saveSlot('alpha', position(9))
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return

    expect(second.slot.id).toBe(first.slot.id)
    expect(listSlots()).toHaveLength(1)
    expect(loadSlot(second.slot.id)?.tick).toBe(9)
  })

  it('falls back to a generated name for a blank slot name', () => {
    const result = saveSlot('   ', position(12))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.slot.name).toContain('12')
  })

  it('reports a write failure instead of throwing', () => {
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    const result = saveSlot('beta', position(1))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('quota')
    spy.mockRestore()
  })

  it('saves the turn count for a full game and loads its history', () => {
    const game = { ...position(7), turn: 7, history: [{ ticks: 40 }], cursor: 0 } as unknown as SavedPosition
    const result = saveSlot('full', game)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.slot.turns).toBe(1)

    const loaded = loadSlot(result.slot.id)
    expect(loaded?.history).toHaveLength(1)
    expect(loaded?.cursor).toBe(0)
  })

  it('falls back to a position-only save when storage rejects the history', () => {
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation((_key, value) => {
      if (typeof value === 'string' && value.includes('"history"')) throw new Error('quota exceeded')
    })
    const game = { ...position(7), history: [{ ticks: 40 }], cursor: 0 } as unknown as SavedPosition
    const result = saveSlot('full', game)
    spy.mockRestore()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warning).toContain('storage is full')
    expect(result.slot.turns).toBeUndefined()
    expect(loadSlot(result.slot.id)?.history).toBeUndefined()
  })
})
