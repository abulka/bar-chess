import { beforeEach, describe, expect, it } from 'vitest'
import { Game } from '../../src/game/game'
import { DEFAULT_SEED } from '../../src/game/rng'
import { clearComponents } from '../helpers'

function playTurns(game: Game, turns: number): void {
  for (let i = 0; i < turns; i++) {
    game.beginTurn()
    let guard = 0
    while (game.turnActive && guard++ < 2000) game.runTicks(1)
  }
}

describe('seed control', () => {
  beforeEach(() => clearComponents())

  it('exposes the seed on the game, snapshot and exported position', () => {
    const game = new Game(8, 'ai-vs-ai')
    expect(game.seed).toBe(DEFAULT_SEED)
    expect(game.snapshot().seed).toBe(DEFAULT_SEED)
    expect(game.exportPosition().seed).toBe(DEFAULT_SEED)
  })

  it('reproduces the same battle for the same seed', () => {
    const a = new Game(8, 'ai-vs-ai', 7)
    playTurns(a, 6)
    const first = JSON.stringify(a.toDebugJson())

    clearComponents()
    const b = new Game(8, 'ai-vs-ai', 7)
    playTurns(b, 6)
    expect(JSON.stringify(b.toDebugJson())).toBe(first)
  })

  it('diverges for a different seed', () => {
    const a = new Game(8, 'ai-vs-ai', 1)
    playTurns(a, 6)
    const first = JSON.stringify(a.toDebugJson())

    clearComponents()
    const b = new Game(8, 'ai-vs-ai', 2)
    playTurns(b, 6)
    expect(JSON.stringify(b.toDebugJson())).not.toBe(first)
  })

  it('reset reuses the current seed', () => {
    const game = new Game(8, 'ai-vs-ai', 99)
    playTurns(game, 3)
    const before = JSON.stringify(game.toDebugJson())

    game.reset()
    expect(game.seed).toBe(99)
    playTurns(game, 3)
    expect(JSON.stringify(game.toDebugJson())).toBe(before)
  })
})
