import { describe, expect, it } from 'vitest'
import {
  CRITICAL_WOUND,
  HIT_STREAK_TRIGGER,
  preserveThreshold,
  recoverThreshold,
  selfPreservationThresholds,
} from '../../src/game/selfPreservation'

describe('self-preservation thresholds', () => {
  it('uses a per-piece retreat threshold', () => {
    expect(preserveThreshold('queen')).toBe(0.5)
    expect(preserveThreshold('king')).toBe(0.5)
    expect(preserveThreshold('rook')).toBe(0.45)
    expect(preserveThreshold('bishop')).toBe(0.4)
    expect(preserveThreshold('knight')).toBe(0.4)
    expect(preserveThreshold('pawn')).toBe(0.3)
  })

  it('heals to a recovery level above the retreat trigger', () => {
    expect(recoverThreshold('queen')).toBeCloseTo(0.7)
    expect(recoverThreshold('rook')).toBeCloseTo(0.65)
    expect(recoverThreshold('bishop')).toBeCloseTo(0.6)
    expect(recoverThreshold('pawn')).toBeCloseTo(0.5)
    for (const kind of ['queen', 'rook', 'bishop', 'knight', 'pawn']) {
      expect(recoverThreshold(kind)).toBeGreaterThan(preserveThreshold(kind))
      expect(recoverThreshold(kind)).toBeLessThanOrEqual(0.8)
    }
  })

  it('exposes the critical-wound and sustained-fire constants', () => {
    expect(CRITICAL_WOUND).toBe(0.2)
    expect(HIT_STREAK_TRIGGER).toBe(2)
  })

  it('bundles the three marks the panel draws', () => {
    expect(selfPreservationThresholds('rook')).toEqual({ preserve: 0.45, recover: 0.65, critical: 0.2 })
  })
})
