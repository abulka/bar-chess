import { describe, expect, it, vi } from 'vitest'
import { pieceAudioCatalog } from '../../src/audio/catalog'
import {
  MISS_CAUSES,
  SOUND_CUES,
  cueIdForEvent,
  deathId,
  hitId,
  missId,
  shotId,
  soundCue,
} from '../../src/audio/sounds'
import type { EventRecord } from '../../src/ecs/events'
import { PIECE_LIST, WEAPONS } from '../../src/game/pieces'

function ev(type: EventRecord['type'], data: Record<string, unknown>): EventRecord {
  return { seq: 1, tick: 0, phase: 'tick', type, msg: type, data }
}

describe('sound cue ids', () => {
  it('formats ids', () => {
    expect(shotId('rookShell')).toBe('shot.rookShell')
    expect(hitId('pawn', 'rookShell')).toBe('hit.pawn.rookShell')
    expect(deathId('king')).toBe('death.king')
    expect(missId('wall')).toBe('miss.wall')
  })

  it('registers a fire, death and every hit pair for each piece', () => {
    for (const piece of PIECE_LIST) {
      expect(soundCue(shotId(piece.weapon))).toBeDefined()
      expect(soundCue(deathId(piece.key))).toBeDefined()
      for (const attacker of PIECE_LIST) {
        expect(soundCue(hitId(piece.key, attacker.weapon))).toBeDefined()
      }
    }
  })

  it('registers a cue for every weapon and miss cause', () => {
    for (const weapon of Object.keys(WEAPONS)) expect(SOUND_CUES.has(shotId(weapon))).toBe(true)
    for (const cause of MISS_CAUSES) expect(SOUND_CUES.has(missId(cause))).toBe(true)
  })

  it('maps events to cue ids', () => {
    expect(cueIdForEvent(ev('shot', { weapon: 'bishopLance' }))).toBe('shot.bishopLance')
    expect(cueIdForEvent(ev('hit', { kind: 'rook', weapon: 'pawnShot' }))).toBe('hit.rook.pawnShot')
    expect(cueIdForEvent(ev('explosion', { kind: 'queen' }))).toBe('death.queen')
    expect(cueIdForEvent(ev('miss', { cause: 'wall' }))).toBe('miss.wall')
  })

  it('returns null for an unknown-attacker hit and for non-combat events', () => {
    expect(cueIdForEvent(ev('hit', { kind: 'rook' }))).toBeNull()
    expect(cueIdForEvent(ev('info', {}))).toBeNull()
  })

  it('exposes a voice spec for every cue', () => {
    for (const piece of PIECE_LIST) {
      expect(soundCue(shotId(piece.weapon))?.builtin.length).toBeGreaterThan(0)
      expect(soundCue(deathId(piece.key))?.builtin.length).toBeGreaterThan(0)
      for (const attacker of PIECE_LIST) {
        expect(soundCue(hitId(piece.key, attacker.weapon))?.builtin.length).toBeGreaterThan(0)
      }
    }
  })

  it('applies VOICE_OVERRIDES over the built-in voice', async () => {
    vi.resetModules()
    const voices = await import('../../src/audio/voices')
    voices.VOICE_OVERRIDES['shot.bishopLance'] = [{ type: 'sine', from: 100, duration: 0.05, gain: 0.1 }]
    const sounds = await import('../../src/audio/sounds')
    expect(sounds.cueSpec('shot.bishopLance')).toEqual([{ type: 'sine', from: 100, duration: 0.05, gain: 0.1 }])
    vi.resetModules()
  })
})

describe('audio catalog', () => {
  it('lists every piece with a fire, death and six hit variants', () => {
    const catalog = pieceAudioCatalog()
    expect(catalog).toHaveLength(PIECE_LIST.length)
    for (const entry of catalog) {
      expect(entry.fireId).toBe(shotId(entry.weapon.key))
      expect(entry.deathId).toBe(deathId(entry.key))
      expect(entry.hitsFrom).toHaveLength(PIECE_LIST.length)
      for (const hit of entry.hitsFrom) {
        expect(soundCue(hit.id)).toBeDefined()
      }
    }
  })

  it('summarizes combat stats from code', () => {
    const rook = pieceAudioCatalog().find((p) => p.key === 'rook')
    expect(rook?.weapon.damage).toBe(WEAPONS.rookShell.damage)
    expect(rook?.weapon.rate).toBeCloseTo(1 / WEAPONS.rookShell.cooldown)
    expect(rook?.projectile.shape).toBe('shell')
    expect(rook?.move.text).toContain('range')
  })
})
