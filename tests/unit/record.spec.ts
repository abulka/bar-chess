import { beforeEach, describe, expect, it } from 'vitest'
import { Cell, Health, Order, PieceType, Target, Team } from '../../src/ecs/components'
import { Game } from '../../src/game/game'
import { exportMap } from '../../src/game/map'
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

  it('replays a Shift-queued order sequence exactly', () => {
    const game = new Game(8, 'human-vs-ai', 77)
    const recorder = new Recorder(game)
    const rook = bluePieces(game).find((e) => {
      const cell = game.world.get(e, Cell)
      return cell?.x === 0 && cell.y === 7
    })
    expect(rook).toBeDefined()
    game.selected = [rook as number]
    game.orderAt({ x: 0, y: 5 })
    game.orderAt({ x: 0, y: 3 }, undefined, { queue: true })
    game.selected = []
    playTurns(game, 3)

    const before = JSON.stringify(game.toDebugJson())
    const record = recorder.finish({ turns: game.turn, ticks: game.tick })
    // The queued step is recorded with its explicit flag so replay re-queues it.
    const orderIntents = record.turns.flatMap((t) => t.intents).filter((i) => i.t === 'order')
    expect(orderIntents.some((i) => i.queue === true)).toBe(true)

    const replay = replayRecord(record)
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

  it('replays a forced (no-preserve) order', () => {
    const game = new Game(8, 'human-vs-ai', 42)
    const recorder = new Recorder(game)
    const [e] = bluePieces(game)
    const cell = game.world.require(e, Cell)
    game.selected = [e]
    game.orderAt({ x: cell.x, y: 0 }, 'move', { force: true })
    game.selected = []

    // The override rides the order and the command records that Alt was held.
    expect(game.world.require(e, Order).noPreserve).toBe(true)
    expect(recorder.record.turns[0].intents[0]).toMatchObject({ t: 'order', force: true })

    playTurns(game, 3)
    const before = JSON.stringify(game.toDebugJson())
    const record = recorder.finish({ turns: game.turn, ticks: game.tick })
    const replay = replayRecord(record)
    expect(JSON.stringify(replay.game.toDebugJson())).toBe(before)
  })

  it('replays a confirmed no-preserve prompt', () => {
    const game = new Game(8, 'human-vs-ai', 42)
    const [e] = bluePieces(game)
    const cell = game.world.require(e, Cell)
    // Wounded and under fire, so ordering it raises the override prompt. The
    // recorder is built after these edits so its baseline captures them.
    const hp = game.world.require(e, Health)
    hp.cur = Math.max(1, Math.floor(hp.max * 0.2))
    const enemy = [...game.world.query(Cell, Team)].find(
      (x) => game.world.require(x, Team) === 'red',
    )
    if (enemy === undefined) throw new Error('no enemy piece')
    const target = game.world.require(e, Target)
    target.lastAttacker = enemy
    target.underFireUntil = 9999

    const recorder = new Recorder(game)
    game.selected = [e]
    game.orderAt({ x: cell.x, y: 0 }, 'move')
    expect(game.snapshot().noPreservePrompt).not.toBeNull()
    game.confirmNoPreservePrompt()
    game.selected = []

    playTurns(game, 2)
    const before = JSON.stringify(game.toDebugJson())
    const record = recorder.finish({ turns: game.turn, ticks: game.tick })
    expect(record.turns.some((t) => t.intents.some((i) => i.t === 'no-preserve'))).toBe(true)
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

  it('rejects pre-v3 records that lack the explicit queue flag', () => {
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
    expect(validateRecord(legacy).ok).toBe(false)
    expect(validateRecord({ ...legacy, v: 2 }).ok).toBe(false)
  })
})

describe('recorder history cursor', () => {
  beforeEach(() => clearComponents())

  function turnsOf(recorder: Recorder): number[] {
    return recorder.record.turns.map((t) => t.turn)
  }

  it('keeps earlier beats across undo and redo so a redo still exports', () => {
    const game = new Game(8, 'ai-vs-ai', 5)
    const recorder = new Recorder(game)
    playTurns(game, 3)
    expect(turnsOf(recorder)).toEqual([1, 2, 3])

    game.undoTurn()
    recorder.rewindTo(game.turn)
    expect(turnsOf(recorder)).toEqual([1, 2])

    game.redoTurn()
    recorder.rewindTo(game.turn)
    expect(turnsOf(recorder)).toEqual([1, 2, 3])
  })

  it('drops the abandoned future when the timeline is forked', () => {
    const game = new Game(8, 'ai-vs-ai', 5)
    const recorder = new Recorder(game)
    playTurns(game, 3)

    game.undoTurn()
    recorder.rewindTo(game.turn)
    game.forkTurn()
    recorder.forkTo(game.turn)
    expect(turnsOf(recorder)).toEqual([1, 2])

    playTurns(game, 1)
    expect(turnsOf(recorder)).toEqual([1, 2, 3])
  })
})
