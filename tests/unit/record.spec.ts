import { beforeEach, describe, expect, it } from 'vitest'
import { Cell, Health, PieceType, Team } from '../../src/ecs/components'
import { Game } from '../../src/game/game'
import { exportMap } from '../../src/game/map'
import {
  Recorder,
  parseRecord,
  replayRecord,
  serializeRecord,
  validateRecord,
} from '../../src/game/record'
import type { GameRecord } from '../../src/game/record'
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

  it('an AI-vs-AI record carries no intents', () => {
    const game = new Game(8, 'ai-vs-ai', 5)
    const recorder = new Recorder(game)
    playTurns(game, 5)

    const before = JSON.stringify(game.toDebugJson())
    const record = recorder.finish({ turns: game.turn, ticks: game.tick })
    // No player intents, but every beat's mode/length is recorded so mixed
    // turn/mega games replay exactly.
    expect(record.turns.reduce((n, t) => n + t.intents.length, 0)).toBe(0)
    expect(record.turns.every((t) => t.mode === 'turn')).toBe(true)

    const replay = replayRecord(record)
    expect(JSON.stringify(replay.game.toDebugJson())).toBe(before)
  })

  it('replays a game that mixes turns and play bursts', () => {
    const game = new Game(8, 'human-vs-ai', 11)
    const recorder = new Recorder(game)

    // Beat 1: a serialized turn.
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

    // Beat 2: a continuous play burst.
    game.beginMegaTurn()
    game.runTicks(75)
    game.togglePause()

    // Beat 3: another serialized turn.
    game.beginTurn()
    guard = 0
    while (game.turnActive && guard++ < 2000) game.runTicks(1)

    const before = JSON.stringify(game.toDebugJson())
    const record = recorder.finish({ turns: game.turn, ticks: game.tick })
    expect(record.turns.some((t) => t.mode === 'mega')).toBe(true)
    expect(record.turns.some((t) => t.mode === 'turn')).toBe(true)

    const replay = replayRecord(record)
    expect(JSON.stringify(replay.game.toDebugJson())).toBe(before)
  })

  it('captures rule toggles per turn and replays them', () => {
    const game = new Game(8, 'human-vs-ai', 42)
    const recorder = new Recorder(game)

    game.setChessKills(true)
    const [e] = bluePieces(game)
    const cell = game.world.require(e, Cell)
    game.selected = [e]
    game.orderAt({ x: cell.x, y: 0 }, 'move')
    game.selected = []
    playTurns(game, 1)

    // Toggled off for the second turn.
    game.setChessKills(false)
    playTurns(game, 1)

    const before = JSON.stringify(game.toDebugJson())
    const record = recorder.finish({ turns: game.turn, ticks: game.tick })
    expect(record.turns[0].settings?.chessKills).toBe(true)
    expect(record.settings.chessKills).toBe(false)

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

  it('snapshots mid-battle without mutating the live recorder', () => {
    const game = new Game(8, 'ai-vs-ai', 3)
    const recorder = new Recorder(game)
    playTurns(game, 2)

    const copy = recorder.snapshot()
    expect(copy.result?.turns).toBe(2)
    expect(copy.result?.partial).toBe(true)
    expect(recorder.record.result).toBeNull()
  })

  it('replays a game started from a custom map exactly', () => {
    const template = new Game(8, 'human-vs-ai', 11)
    const map = exportMap(template, 'odd layout')
    map.placements = [
      { team: 'red', key: 'king', x: 3, y: 3 },
      { team: 'blue', key: 'king', x: 4, y: 4 },
      { team: 'red', key: 'rook', x: 0, y: 0 },
      { team: 'blue', key: 'knight', x: 7, y: 7 },
    ]

    const game = new Game(8, 'human-vs-ai', 11)
    game.loadMap(map, 11)
    const recorder = new Recorder(game)

    for (let turn = 0; turn < 4 && game.winner === null; turn++) {
      for (const e of bluePieces(game)) {
        const cell = game.world.require(e, Cell)
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
    expect(record.baseline).toBeDefined()

    const replay = replayRecord(record)
    expect(JSON.stringify(replay.game.toDebugJson())).toBe(before)
  })

  it('replays sandbox placements and removals', () => {
    const game = new Game(8, 'human-vs-ai', 3)
    const recorder = new Recorder(game)
    game.placePiece('red', 'queen', 4, 4)
    game.removePieceAt(0, 0)
    playTurns(game, 2)

    const before = JSON.stringify(game.toDebugJson())
    const record = recorder.finish({ turns: game.turn, ticks: game.tick })
    const replay = replayRecord(record)
    expect(JSON.stringify(replay.game.toDebugJson())).toBe(before)
  })

  it('still accepts version 1 records without a baseline', () => {
    const legacy = {
      v: 1,
      boardId: 'board-8',
      size: 8,
      mode: 'ai-vs-ai',
      playerTeam: 'blue',
      seed: 1,
      settings: { autoPreserve: true, captureAdvance: false, chessKills: false },
      turns: [],
      result: null,
    }
    expect(validateRecord(legacy).ok).toBe(true)
    const replay = replayRecord(legacy as unknown as GameRecord)
    expect(replay.game.board.width).toBe(8)
  })
})
