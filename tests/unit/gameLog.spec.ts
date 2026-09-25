import { beforeEach, describe, expect, it } from 'vitest'
import { Cell, Team } from '../../src/ecs/components'
import { Game } from '../../src/game/game'
import { GameLog } from '../../src/game/gameLog'
import { Recorder } from '../../src/game/record'
import { LLM_PREAMBLE } from '../../src/game/shorthand'
import { buildGamePrompt, buildSnapshotPrompt, formatGameAnalysis } from '../../src/game/studyPrompt'
import { clearComponents } from '../helpers'

function playTurn(game: Game, log: GameLog): void {
  game.beginTurn()
  let guard = 0
  while (game.turnActive && guard++ < 4000) game.runTicks(1)
  log.tick()
}

function bluePieces(game: Game): number[] {
  const out: number[] = []
  for (const e of game.world.query(Cell, Team)) {
    if (game.world.require(e, Team) === 'blue') out.push(e)
  }
  return out
}

describe('GameLog & LLM game prompt', () => {
  beforeEach(() => clearComponents())

  it('samples a turn trace and buffers events', () => {
    const game = new Game(8, 'ai-vs-ai', 7)
    const log = new GameLog(game)
    log.begin()
    log.tick()
    playTurn(game, log)
    playTurn(game, log)

    expect(log.turnTrace[0].turn).toBe(0)
    expect(log.turnTrace.length).toBe(3)
    expect(log.eventStream.length).toBeGreaterThan(0)
    log.dispose()
  })

  it('samples every turn even when turns run back-to-back', () => {
    const game = new Game(8, 'ai-vs-ai', 7)
    const log = new GameLog(game)
    log.begin()
    game.beginTurn()
    game.queueTurn()
    game.queueTurn()
    let guard = 0
    while ((game.turnActive || game.queuedTurns > 0) && guard++ < 20000) game.runTicks(1)

    expect(log.turnTrace.map((t) => t.turn)).toEqual([0, 1, 2, 3])
    log.dispose()
  })

  it('samples a mega turn once, when it closes', () => {
    const game = new Game(8, 'ai-vs-ai', 7)
    const log = new GameLog(game)
    log.begin()
    log.tick()

    game.beginMegaTurn()
    game.runTicks(60)
    log.tick() // polling during play must not churn the trace
    expect(log.turnTrace.map((t) => t.turn)).toEqual([0])
    game.togglePause()
    expect(log.turnTrace.map((t) => t.turn)).toEqual([0, 1])
    log.dispose()
  })

  it('rewinds the trace to the restored turn on undo', () => {
    const game = new Game(8, 'ai-vs-ai', 7)
    const log = new GameLog(game)
    log.begin()
    playTurn(game, log)
    playTurn(game, log)
    playTurn(game, log)
    expect(log.turnTrace.map((t) => t.turn)).toEqual([0, 1, 2, 3])

    game.undoTurn()
    log.rewind(game.turn)
    expect(log.turnTrace.map((t) => t.turn)).toEqual([0, 1, 2])
    log.dispose()
  })

  it('keeps full detail across undo and redo', () => {
    const game = new Game(8, 'ai-vs-ai', 7)
    const recorder = new Recorder(game)
    const log = new GameLog(game)
    log.begin()
    playTurn(game, log)
    playTurn(game, log)
    playTurn(game, log)
    const before = log.finish(recorder.snapshot(), { boards: true }).transcript

    game.undoTurn()
    log.rewind(game.turn)
    game.redoTurn()
    log.rewind(game.turn)

    expect(log.turnTrace.map((t) => t.turn)).toEqual([0, 1, 2, 3])
    expect(log.finish(recorder.snapshot(), { boards: true }).transcript).toBe(before)
    log.dispose()
  })

  it('ignores replay events instead of duplicating the replayed turn', () => {
    const game = new Game(8, 'ai-vs-ai', 7)
    const recorder = new Recorder(game)
    const log = new GameLog(game)
    log.begin()
    playTurn(game, log)
    playTurn(game, log)

    const before = log.finish(recorder.snapshot()).transcript
    const eventsBefore = log.eventStream.length
    const turnsBefore = log.turnTrace.map((t) => t.turn)

    game.replayTurn()
    let guard = 0
    while (game.replaying && guard++ < 4000) game.runTicks(1)
    log.tick()

    expect(log.eventStream.length).toBe(eventsBefore)
    expect(log.turnTrace.map((t) => t.turn)).toEqual(turnsBefore)
    expect(log.finish(recorder.snapshot()).transcript).toBe(before)
    log.dispose()
  })

  it('drops an abandoned branch when a new turn is played after undo', () => {
    const game = new Game(8, 'ai-vs-ai', 7)
    const recorder = new Recorder(game)
    const log = new GameLog(game)
    log.begin()
    playTurn(game, log)
    playTurn(game, log)
    playTurn(game, log)

    game.undoTurn()
    log.rewind(game.turn)
    playTurn(game, log) // new turn 3 replaces the old one

    expect(log.turnTrace.map((t) => t.turn)).toEqual([0, 1, 2, 3])
    const text = log.finish(recorder.snapshot(), { boards: true }).transcript
    expect((text.match(/^T3:/gm) ?? []).length).toBe(1)
    log.dispose()
  })

  it('draws a board after each turn when asked', () => {
    const game = new Game(8, 'ai-vs-ai', 1)
    const recorder = new Recorder(game)
    const log = new GameLog(game)
    log.begin()
    playTurn(game, log)
    playTurn(game, log)

    const plain = log.finish(recorder.snapshot()).transcript
    const withBoards = log.finish(recorder.snapshot(), { boards: true }).transcript
    expect(withBoards.length).toBeGreaterThan(plain.length)
    expect(withBoards).toMatch(/T1: [^\n]*\n {2}a b c d e f g h/)
    log.dispose()
  })

  it('renders a transcript, analysis and a partial replay record', () => {
    const game = new Game(8, 'human-vs-ai', 42)
    const recorder = new Recorder(game)
    const log = new GameLog(game)
    log.begin()
    log.tick()

    for (let turn = 0; turn < 3 && game.winner === null; turn++) {
      for (const e of bluePieces(game)) {
        const cell = game.world.get(e, Cell)
        if (!cell) continue
        game.selected = [e]
        game.orderAt({ x: cell.x, y: 0 }, 'move')
      }
      game.selected = []
      playTurn(game, log)
    }

    const record = recorder.snapshot()
    expect(record.result?.partial).toBe(true)
    expect(recorder.record.result).toBeNull()

    const { transcript, analysis } = log.finish(record)
    const prompt = buildGamePrompt({ game, record, transcript, analysis })

    expect(prompt.startsWith(LLM_PREAMBLE.trimEnd())).toBe(true)
    expect(prompt).toContain('# transcript')
    expect(prompt).toContain('# analysis')
    expect(prompt).toContain('# replay record')
    expect(prompt).toContain(`seed=${record.seed}`)
    expect(prompt).toContain('partial')
    expect(prompt).toContain(JSON.stringify(record))
    log.dispose()
  })

  it('builds a snapshot with the last turn activity', () => {
    const game = new Game(8, 'ai-vs-ai', 1)
    const log = new GameLog(game)
    log.begin()
    log.tick()
    playTurn(game, log)

    const text = buildSnapshotPrompt({ game, trace: log.turnTrace, events: log.eventStream })
    expect(text).toContain('# board-8 8x8')
    expect(text).not.toContain('Bar Chess is a real-time')
    expect(text).toContain('# last turn')
    expect(text).toMatch(/T1: .+->/)
    log.dispose()
  })

  it('records why a player order changed in the transcript', () => {
    const game = new Game(8, 'human-vs-ai', 42)
    const recorder = new Recorder(game)
    const log = new GameLog(game)
    log.begin()
    const [e] = bluePieces(game)
    const cell = game.world.require(e, Cell)
    game.selected = [e]
    game.orderAt({ x: cell.x, y: 0 }, 'move')
    game.selected = []
    playTurn(game, log)

    const { transcript } = log.finish(recorder.snapshot())
    expect(transcript).toMatch(/order: move ordered/)
    log.dispose()
  })

  it('summarises analysis in one place', () => {
    const text = formatGameAnalysis({
      winner: null,
      turns: 5,
      partial: true,
      shots: 3,
      hits: 2,
      kills: 0,
      heldUnderFire: [{ piece: 'rP e2', turns: 'T1-T2', hitsTaken: 2, isPawn: true }],
      neverMovedUnderFire: [{ piece: 'rP e2', turns: 'T1-T2', hitsTaken: 2, isPawn: true }],
      neverMoved: ['bK e1'],
      neverFired: [],
      focusFire: [],
      noProgressTurns: 0,
      oscillation: [],
    })
    expect(text).toContain('winner=none turns=5 (partial)')
    expect(text).toContain('heldUnderFire: rP e2 T1-T2 (2 hits, pawn)')
    expect(text).toContain('neverMoved: bK e1')
  })
})
