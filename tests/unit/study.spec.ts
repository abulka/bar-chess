import { beforeEach, describe, expect, it } from 'vitest'
import { Game } from '../../src/game/game'
import { Recorder } from '../../src/game/record'
import { StudyController } from '../../src/game/study'
import type { StudyGameResult, StudyOptions } from '../../src/game/study'
import { clearComponents } from '../helpers'

function options(overrides: Partial<StudyOptions> = {}): StudyOptions {
  return {
    games: 2,
    size: 8,
    mode: 'ai-vs-ai',
    seedBase: 1,
    maxTurns: 60,
    policy: 'none',
    speed: 'watch',
    piecesPerTurn: 3,
    attackChance: 0.2,
    autoPreserve: true,
    captureAdvance: false,
    chessKills: false,
    promotion: true,
    ...overrides,
  }
}

function drainTurn(game: Game): void {
  let guard = 0
  while (game.turnActive && guard++ < 4000) game.runTicks(1)
}

function pump(study: StudyController, game: Game, maxTurns = 500): void {
  let guard = 0
  while (study.state.running && guard++ < maxTurns * 4) {
    study.tick()
    drainTurn(game)
  }
}

/** Run a whole batch and return its results, driven at either speed. */
function runBatch(opts: StudyOptions): StudyGameResult[] {
  clearComponents()
  const game = new Game(opts.size, opts.mode, opts.seedBase)
  const controller = new StudyController(game, new Recorder(game))
  controller.start(opts)
  let guard = 0
  while (controller.state.running && guard++ < 200000) {
    controller.tick()
    drainTurn(game)
  }
  const results = controller.state.results
  controller.dispose()
  return results
}

function orderNotes(result: StudyGameResult): string[] {
  const notes: string[] = []
  for (const turn of result.trace) {
    for (const piece of turn.pieces) {
      for (const note of piece.orderLog) notes.push(note.text)
    }
  }
  return notes
}

describe('StudyController', () => {
  let game: Game
  let study: StudyController

  beforeEach(() => {
    clearComponents()
    game = new Game(8, 'ai-vs-ai', 1)
    study = new StudyController(game, new Recorder(game))
  })

  it('plays a batch to completion and records every game', () => {
    study.start(options({ games: 3, maxTurns: 40 }))
    pump(study, game)

    expect(study.state.running).toBe(false)
    expect(study.state.results).toHaveLength(3)
    for (const result of study.state.results) {
      expect(result.record.result).not.toBeNull()
      expect(result.transcript).toContain('# game board-8')
      expect(result.transcript).toContain('# pieces')
      expect(result.trace.length).toBeGreaterThan(0)
    }
    study.dispose()
  })

  it('records the seed of each game in order', () => {
    study.start(options({ games: 2, seedBase: 10, maxTurns: 20 }))
    pump(study, game)
    expect(study.state.results.map((r) => r.seed)).toEqual([10, 11])
    study.dispose()
  })

  it('keeps a partial recording when a game is stopped and moves on', () => {
    study.start(options({ games: 2, maxTurns: 200 }))
    for (let i = 0; i < 3; i++) {
      study.tick()
      drainTurn(game)
    }
    study.stopCurrent()

    expect(study.state.results).toHaveLength(1)
    expect(study.state.results[0].partial).toBe(true)
    expect(study.state.running).toBe(true)

    pump(study, game)
    expect(study.state.results).toHaveLength(2)
    study.dispose()
  })

  it('discards all recordings on cancel', () => {
    study.start(options({ games: 3, maxTurns: 200 }))
    study.tick()
    drainTurn(game)
    study.cancel()

    expect(study.state.running).toBe(false)
    expect(study.state.results).toHaveLength(0)
    study.dispose()
  })

  it('records random human orders in human-vs-ai games', () => {
    clearComponents()
    const human = new Game(8, 'human-vs-ai', 3)
    const controller = new StudyController(human, new Recorder(human))
    controller.start(options({ games: 1, mode: 'human-vs-ai', policy: 'human', maxTurns: 8 }))
    pump(controller, human)

    const result = controller.state.results[0]
    expect(result.record.turns.length).toBeGreaterThan(0)
    expect(result.record.turns.reduce((n, t) => n + t.intents.length, 0)).toBeGreaterThan(0)
    expect(result.transcript).toContain('# study the human side is a scripted policy (human)')
    controller.dispose()
  })

  it('never issues a positionally unreachable attack', () => {
    const [result] = runBatch(
      options({ games: 1, mode: 'human-vs-ai', policy: 'human', maxTurns: 12 }),
    )
    const issued = orderNotes(result).filter(
      (text) => text.includes('attack ordered') || text.includes('queued attack'),
    )
    expect(issued.some((text) => text.includes('unreachable'))).toBe(false)
    expect(issued.length).toBeGreaterThan(0)
  })

  it('commands only a few pieces per turn', () => {
    const [result] = runBatch(
      options({
        games: 1,
        mode: 'human-vs-ai',
        policy: 'human',
        piecesPerTurn: 2,
        maxTurns: 12,
      }),
    )
    for (const turn of result.record.turns) {
      // Each chosen piece records a clear plus one order.
      expect(turn.intents.length).toBeLessThanOrEqual(4)
    }
  })

  it('fast mode reproduces watch mode exactly', () => {
    const opts = options({ games: 2, mode: 'human-vs-ai', policy: 'human', maxTurns: 20 })
    const watched = runBatch({ ...opts, speed: 'watch' })
    const fast = runBatch({ ...opts, speed: 'fast' })

    expect(fast).toHaveLength(watched.length)
    for (let i = 0; i < watched.length; i++) {
      expect(fast[i].winner).toBe(watched[i].winner)
      expect(fast[i].turns).toBe(watched[i].turns)
      expect(fast[i].ticks).toBe(watched[i].ticks)
      expect(fast[i].transcript).toBe(watched[i].transcript)
    }
  })
})
