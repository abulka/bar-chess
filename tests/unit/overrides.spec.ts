// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearAllOverrides,
  clearOverride,
  formatAllOverrides,
  formatEntry,
  getOverride,
  hasLocalOverride,
  overrideCount,
  overrideSource,
  reloadOverrides,
  resolveSpec,
  setOverride,
  subscribeOverrides,
} from '../../src/audio/overrides'
import { VOICE_OVERRIDES, type VoiceSpec } from '../../src/audio/voices'

const builtin: VoiceSpec = [{ type: 'sine', from: 440, duration: 0.1, gain: 0.2 }]
const other: VoiceSpec = [{ type: 'square', from: 220, duration: 0.2, gain: 0.3 }]
const TEST_ID = 'shot.test'

beforeEach(() => {
  localStorage.clear()
  clearAllOverrides()
  delete VOICE_OVERRIDES[TEST_ID]
})

describe('sound overrides store', () => {
  it('sets, reads and clears overrides', () => {
    setOverride(TEST_ID, builtin)
    expect(hasLocalOverride(TEST_ID)).toBe(true)
    expect(getOverride(TEST_ID)).toEqual(builtin)
    expect(overrideCount()).toBe(1)
    clearOverride(TEST_ID)
    expect(hasLocalOverride(TEST_ID)).toBe(false)
    expect(overrideCount()).toBe(0)
  })

  it('persists to localStorage and reloads', () => {
    setOverride(TEST_ID, builtin)
    const raw = JSON.parse(localStorage.getItem('bar-chess.soundOverrides')!) as {
      overrides: Record<string, VoiceSpec>
    }
    expect(raw.overrides[TEST_ID]).toEqual(builtin)

    clearAllOverrides()
    localStorage.setItem(
      'bar-chess.soundOverrides',
      JSON.stringify({ version: 1, overrides: { [TEST_ID]: other } }),
    )
    reloadOverrides()
    expect(getOverride(TEST_ID)).toEqual(other)
  })

  it('resolves local over code over built-in', () => {
    VOICE_OVERRIDES[TEST_ID] = builtin
    const fallback: VoiceSpec = [{ type: 'triangle', from: 1, duration: 1, gain: 1 }]
    expect(resolveSpec(TEST_ID, fallback)).toEqual(builtin)
    expect(overrideSource(TEST_ID)).toBe('code')

    setOverride(TEST_ID, other)
    expect(resolveSpec(TEST_ID, fallback)).toEqual(other)
    expect(overrideSource(TEST_ID)).toBe('local')
  })

  it('drops malformed stored specs', () => {
    localStorage.setItem(
      'bar-chess.soundOverrides',
      JSON.stringify({ version: 1, overrides: { bad: 'nope', [TEST_ID]: builtin } }),
    )
    reloadOverrides()
    expect(getOverride('bad')).toBeUndefined()
    expect(getOverride(TEST_ID)).toEqual(builtin)
  })

  it('notifies subscribers and stops after unsubscribe', () => {
    const listener = vi.fn()
    const off = subscribeOverrides(listener)
    setOverride(TEST_ID, builtin)
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    clearAllOverrides()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('formats entries and the full pasteable block', () => {
    setOverride(TEST_ID, builtin)
    expect(formatEntry(TEST_ID, builtin)).toContain(`"${TEST_ID}":`)
    const all = formatAllOverrides()
    expect(all).toContain('export const VOICE_OVERRIDES: Record<string, VoiceSpec> =')
    expect(all).toContain(`"${TEST_ID}"`)
  })
})
