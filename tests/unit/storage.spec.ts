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
})
