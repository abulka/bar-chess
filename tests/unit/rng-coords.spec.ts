import { describe, expect, it } from 'vitest'
import { coordName, fileLabel, rankLabel } from '../../src/game/coords'
import { Rng } from '../../src/game/rng'

describe('Rng', () => {
  it('is deterministic for a given seed', () => {
    const a = new Rng(123)
    const b = new Rng(123)
    expect(a.next()).toBe(b.next())
    expect(a.next()).toBe(b.next())
    expect(new Rng(1).next()).not.toBe(new Rng(2).next())
  })

  it('restores its exact stream via getState/setState', () => {
    const rng = new Rng(7)
    rng.next()
    const state = rng.getState()
    const next = rng.next()
    rng.setState(state)
    expect(rng.next()).toBe(next)
  })

  it('keeps int() within inclusive bounds', () => {
    const rng = new Rng(5)
    for (let i = 0; i < 200; i++) {
      const v = rng.int(2, 5)
      expect(v).toBeGreaterThanOrEqual(2)
      expect(v).toBeLessThanOrEqual(5)
    }
  })
})

describe('coords', () => {
  it('labels files a..z then aa..', () => {
    expect(fileLabel(0)).toBe('a')
    expect(fileLabel(25)).toBe('z')
    expect(fileLabel(26)).toBe('aa')
  })

  it('ranks from the bottom and composes square names', () => {
    expect(rankLabel(0, 8)).toBe('8')
    expect(rankLabel(7, 8)).toBe('1')
    expect(coordName(0, 0, 8)).toBe('a8')
    expect(coordName(7, 7, 8)).toBe('h1')
  })
})
