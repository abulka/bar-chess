import { describe, expect, it } from 'vitest'
import { explosionVoice, fireVoice, hitVoice, isTone, missVoice } from '../../src/audio/voices'

describe('voice specs', () => {
  it('produces the documented bishopLance fire voice', () => {
    expect(fireVoice('bishopLance')).toEqual([
      {
        type: 'sawtooth',
        from: 1900,
        to: 280,
        duration: 0.18,
        gain: 0.12,
        filter: { type: 'highpass', from: 600, to: 300, q: 0.8 },
      },
    ])
  })

  it('returns a non-empty spec for every weapon and a fallback', () => {
    for (const weapon of ['pawnShot', 'knightBomb', 'bishopLance', 'rookShell', 'queenNova', 'kingGuard', 'unknown']) {
      expect(fireVoice(weapon).length).toBeGreaterThan(0)
    }
  })

  it('discriminates tones from noise layers', () => {
    const rook = fireVoice('rookShell')
    expect(isTone(rook[0])).toBe(true)
    expect(isTone(rook[1])).toBe(false)
  })

  it('builds hit, explosion and miss voices', () => {
    expect(hitVoice('pawn', 'shell', 20).length).toBeGreaterThan(0)
    expect(hitVoice('rook', 'dot', 7).length).toBeGreaterThan(0)
    expect(explosionVoice('king', 1.6).length).toBeGreaterThan(0)
    for (const cause of ['ground', 'wall', 'expired', 'target-lost', 'other']) {
      expect(missVoice(cause).length).toBeGreaterThan(0)
    }
  })
})
