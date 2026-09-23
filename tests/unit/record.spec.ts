import { beforeEach, describe, expect, it } from 'vitest'
import { Cell, Health, PieceType, Team } from '../../src/ecs/components'
import { Game } from '../../src/game/game'
import {
  Recorder,
  parseRecord,
  replayRecord,
  serializeRecord,
  validateRecord,
} from '../../src/game/record'
import { clearComponents } from '../helpers'

function playTurns(game: Game, turns: number): void {
  for (let i = 0; i < turns; i++) {
    game.beginTurn()
    let guard = 0
    while (game.turnActive && guard++ < 2000) game.runTicks(1)
  }
}

function bluePieces(game: Game): number[] {
  const out: number[] = []
  for (const e of game.world.query(Cell, Team, PieceType, Health)) {
    if (game.world.require(e, Team) === 'blue') out.push(e)
  }
  return out
}

describe('game record', () => {
  beforeEach(() => clearComponents())

  it('replays a recorded human-vs-ai game exactly', () => {
    const game = new Game(8, 'human-vs-ai', 42)
    const recorder = new Recorder(game)

    for (let turn = 0; turn < 8 && game.winner === null; turn++) {
      for (const e of bluePieces(game)) {
        const cell = game.world.get(e, Cell)
        if (!cell) continue
        game.selected = [e]
        game.orderAt({ x: cell.x, y: 0 }, 'move')
      }
      game.selected = []
      game.beginTurn()
      let guard = 0
      while (game.turnActive && guard++ < 2000) game.runTicks(1)
    }

    const before = JSON.stringify(game.toDebugJson())
    const record = recorder.finish({ turns: game.turn, ticks: game.tick })
    expect(record.turns.length).toBeGreaterThan(0)
    expect(record.turns.reduce((n, t) => n + t.intents.length, 0)).toBeGreaterThan(0)

    const replay = replayRecord(record)
    expect(replay.game.winner).toBe(game.winner)
    expect(JSON.stringify(replay.game.toDebugJson())).toBe(before)
  })

  it('an AI-vs-AI record needs only the seed', () => {
    const game = new Game(8, 'ai-vs-ai', 5)
    const recorder = new Recorder(game)
    playTurns(game, 5)

    const before = JSON.stringify(game.toDebugJson())
    const record = recorder.finish({ turns: game.turn, ticks: game.tick })
    expect(record.turns).toEqual([])

    const replay = replayRecord(record)
    expect(JSON.stringify(replay.game.toDebugJson())).toBe(before)
  })

  it('validates and round-trips records', () => {
    const game = new Game(8, 'ai-vs-ai', 3)
    const recorder = new Recorder(game)
    playTurns(game, 2)
    const record = recorder.finish()

    expect(validateRecord(record).ok).toBe(true)
    expect(parseRecord(serializeRecord(record)).seed).toBe(3)
    expect(validateRecord({ v: 999 }).ok).toBe(false)
    expect(validateRecord(null).ok).toBe(false)
  })
})
