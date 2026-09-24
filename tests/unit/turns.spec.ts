import { beforeEach, describe, expect, it } from 'vitest'
import { Cell } from '../../src/ecs/components'
import { Game } from '../../src/game/game'
import { clearComponents } from '../helpers'

function runTurn(game: Game): void {
  game.beginTurn()
  let guard = 0
  while (game.turnActive && guard++ < 4000) game.runTicks(1)
  expect(guard).toBeLessThan(4000)
}

function runUntil(game: Game, pred: () => boolean, max = 8000): void {
  let guard = 0
  while (!pred() && guard++ < max) game.runTicks(1)
  expect(guard).toBeLessThan(max)
}

describe('turn list & history navigation', () => {
  beforeEach(() => clearComponents())

  it('summarizes every retained boundary', () => {
    const game = new Game(8, 'ai-vs-ai', 3)
    runTurn(game)
    runTurn(game)
    runTurn(game)

    const snap = game.snapshot()
    expect(snap.turns.length).toBe(4)
    expect(snap.historyIndex).toBe(3)
    expect(snap.historyLength).toBe(4)
    expect(snap.historyTrimmed).toBe(0)

    const opening = snap.turns[0]
    expect(opening.index).toBe(0)
    expect(opening.turn).toBe(0)
    expect(opening.replayable).toBe(false)
    expect(opening.pieces).toBe(32)

    const last = snap.turns[3]
    expect(last.turn).toBe(3)
    expect(last.replayable).toBe(true)
    expect(last.ticks).toBeGreaterThan(0)
    expect(last.pieces).toBeGreaterThan(0)
  })

  it('jumps straight to any retained boundary', () => {
    const game = new Game(8, 'ai-vs-ai', 14)
    runTurn(game)
    const afterFirst = JSON.stringify(game.toDebugJson())
    runTurn(game)
    runTurn(game)

    game.jumpToTurn(1)
    expect(game.snapshot().historyIndex).toBe(1)
    expect(JSON.stringify(game.toDebugJson())).toBe(afterFirst)
    expect(game.paused).toBe(true)
  })

  it('replays a beat in the redo branch and lands on its boundary', () => {
    const game = new Game(8, 'ai-vs-ai', 21)
    runTurn(game)
    runTurn(game)
    const afterSecond = JSON.stringify(game.toDebugJson())
    runTurn(game)

    game.undoTurn()
    game.undoTurn()
    expect(game.snapshot().canRedo).toBe(true)

    game.replayTurnAt(2)
    expect(game.snapshot().historyIndex).toBe(2)
    expect(game.snapshot().replaying).toBe(true)
    runUntil(game, () => !game.isReplaying)

    expect(game.snapshot().historyIndex).toBe(2)
    expect(JSON.stringify(game.toDebugJson())).toBe(afterSecond)
    // The redo branch is untouched by a replay.
    expect(game.snapshot().canRedo).toBe(true)
  })

  it('space replays forward without discarding the redo branch', () => {
    const game = new Game(8, 'ai-vs-ai', 33)
    runTurn(game)
    runTurn(game)
    runTurn(game)
    const latest = game.snapshot().historyLength - 1

    game.undoTurn()
    game.undoTurn()
    expect(game.snapshot().historyIndex).toBe(latest - 2)

    game.advance()
    expect(game.snapshot().replaying).toBe(true)
    expect(game.snapshot().historyIndex).toBe(latest - 1)
    runUntil(game, () => !game.isReplaying)
    expect(game.snapshot().canRedo).toBe(true)

    game.advance()
    runUntil(game, () => !game.isReplaying)
    expect(game.snapshot().historyIndex).toBe(latest)
    expect(game.snapshot().canRedo).toBe(false)

    // At the tip, space starts a real turn again.
    game.advance()
    expect(game.turnActive).toBe(true)
  })

  it('queues the second space press while replaying a historical beat', () => {
    const game = new Game(8, 'ai-vs-ai', 41)
    runTurn(game)
    runTurn(game)
    runTurn(game)

    game.undoTurn()
    game.undoTurn()
    expect(game.snapshot().historyIndex).toBe(1)
    game.advance()
    expect(game.snapshot().replaying).toBe(true)
    expect(game.snapshot().historyIndex).toBe(2)
    game.advance()
    expect(game.snapshot().queuedForward).toBe(1)
  })

  it('buffers a second turn while at the tip', () => {
    const game = new Game(8, 'ai-vs-ai', 42)
    game.advance()
    expect(game.turnActive).toBe(true)
    game.advance()
    expect(game.snapshot().queuedTurns).toBe(1)
  })

  it('explicitly forks and discards the redo branch', () => {
    const game = new Game(8, 'ai-vs-ai', 55)
    runTurn(game)
    runTurn(game)
    game.undoTurn()
    expect(game.snapshot().canRedo).toBe(true)

    game.forkTurn()
    expect(game.turnActive).toBe(true)
    runUntil(game, () => !game.turnActive)
    expect(game.snapshot().canRedo).toBe(false)
    expect(game.snapshot().historyIndex).toBe(game.snapshot().historyLength - 1)
  })

  it('play-forward runs the recorded beats then continues live at the tip', () => {
    const game = new Game(8, 'ai-vs-ai', 61)
    runTurn(game)
    runTurn(game)
    runTurn(game)
    const latest = game.snapshot().historyLength - 1

    game.undoTurn()
    game.undoTurn()
    game.requestPlay()
    runUntil(game, () => game.snapshot().playing)
    expect(game.snapshot().historyIndex).toBe(latest)

    game.togglePause()
    expect(game.snapshot().canRedo).toBe(false)
  })

  it('populates the turn list from an imported game and keeps the trimmed hint', () => {
    const source = new Game(8, 'ai-vs-ai', 7)
    runTurn(source)
    runTurn(source)
    const saved = JSON.parse(JSON.stringify(source.exportPosition({ history: true })))

    const loaded = new Game(8, 'ai-vs-ai')
    expect(loaded.importPosition(saved).ok).toBe(true)
    expect(loaded.snapshot().turns.length).toBe(3)
    expect(loaded.snapshot().historyTrimmed).toBe(0)
    expect(loaded.snapshot().turns[2].replayable).toBe(true)

    loaded.jumpToTurn(1)
    expect(loaded.snapshot().historyIndex).toBe(1)
  })

  it('counts beats dropped by the history cap', () => {
    const game = new Game(8, 'ai-vs-ai', 71)
    // An empty board keeps each turn at its minimum length (~1s of ticks).
    for (const e of [...game.world.query(Cell)]) game.world.destroy(e)
    for (let i = 0; i < 105; i++) runTurn(game)

    const snap = game.snapshot()
    expect(snap.historyLength).toBe(100)
    expect(snap.historyTrimmed).toBe(6)

    const saved = JSON.parse(JSON.stringify(game.exportPosition({ history: true })))
    const loaded = new Game(8, 'ai-vs-ai')
    expect(loaded.importPosition(saved).ok).toBe(true)
    expect(loaded.snapshot().historyTrimmed).toBe(6)
  })
})
