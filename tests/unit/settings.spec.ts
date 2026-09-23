// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Game } from '../../src/game/game'
import { clearSettings, loadSettings, saveSettings } from '../../src/game/settings'
import { clearComponents } from '../helpers'

describe('settings persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    clearComponents()
  })

  it('round-trips game settings through storage', () => {
    const game = new Game(8)
    game.applySettings({
      overlays: { rangeArcs: true, grid: false, myOrders: false, reload: false },
      hudVisible: true,
      railsVisible: false,
      speed: 2,
      gameMode: 'ai-vs-ai',
      autoPreserve: false,
      captureAdvance: true,
      soundEnabled: true,
      bottomFraction: 0.4,
    })
    saveSettings(game.settings())

    const restored = new Game(8)
    restored.applySettings(loadSettings() ?? {})

    expect(restored.overlays.rangeArcs).toBe(true)
    expect(restored.overlays.grid).toBe(false)
    expect(restored.overlays.myOrders).toBe(false)
    expect(restored.overlays.reload).toBe(false)
    expect(restored.overlays.moveCells).toBe(true)
    expect(restored.hudVisible).toBe(true)
    expect(restored.railsVisible).toBe(false)
    expect(restored.speed).toBe(2)
    expect(restored.gameMode).toBe('ai-vs-ai')
    expect(restored.autoPreserve).toBe(false)
    expect(restored.captureAdvance).toBe(true)
    expect(restored.soundEnabled).toBe(true)
    expect(restored.bottomFraction).toBe(0.4)
    expect(restored.teams.red.controller).toBe('ai')
  })

  it('returns null when nothing is stored and on malformed data', () => {
    expect(loadSettings()).toBeNull()
    localStorage.setItem('bar-chess.settings', '{not json')
    expect(loadSettings()).toBeNull()
    localStorage.setItem('bar-chess.settings', '"nope"')
    expect(loadSettings()).toBeNull()
  })

  it('drops invalid or out-of-range stored values', () => {
    localStorage.setItem(
      'bar-chess.settings',
      JSON.stringify({
        overlays: { rangeArcs: true, bogus: 'yes', grid: 3 },
        hudVisible: 'true',
        railsVisible: 'yes',
        speed: 99,
        gameMode: 'nonsense',
        autoPreserve: 'yes',
        captureAdvance: 'yes',
        soundEnabled: 'yes',
        bottomFraction: 2,
      }),
    )
    const loaded = loadSettings()
    expect(loaded).not.toBeNull()
    expect(loaded?.overlays).toEqual({ rangeArcs: true })
    expect(loaded?.hudVisible).toBeUndefined()
    expect(loaded?.railsVisible).toBeUndefined()
    expect(loaded?.speed).toBeUndefined()
    expect(loaded?.gameMode).toBeUndefined()
    expect(loaded?.autoPreserve).toBeUndefined()
    expect(loaded?.captureAdvance).toBeUndefined()
    expect(loaded?.soundEnabled).toBeUndefined()
    expect(loaded?.bottomFraction).toBeUndefined()
  })

  it('defaults auto-preserve on and honors an explicit off', () => {
    expect(new Game(8).autoPreserve).toBe(true)
    const game = new Game(8)
    game.applySettings({ autoPreserve: false })
    expect(game.autoPreserve).toBe(false)
  })

  it('defaults capture advance off and honors an explicit on', () => {
    expect(new Game(8).captureAdvance).toBe(false)
    const game = new Game(8)
    game.applySettings({ captureAdvance: true })
    expect(game.captureAdvance).toBe(true)
  })

  it('ignores invalid values in applySettings', () => {
    const game = new Game(8)
    game.applySettings({ speed: 99, gameMode: 'nope' as never })
    expect(game.speed).toBe(1)
    expect(game.gameMode).toBe('human-vs-ai')
  })

  it('does not throw when a storage write fails', () => {
    const spy = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    expect(() => saveSettings(new Game(8).settings())).not.toThrow()
    spy.mockRestore()
  })

  it('clears stored settings', () => {
    saveSettings(new Game(8).settings())
    clearSettings()
    expect(loadSettings()).toBeNull()
  })
})
