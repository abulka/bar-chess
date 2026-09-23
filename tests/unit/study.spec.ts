import { beforeEach, describe, expect, it } from 'vitest'
import { Game } from '../../src/game/game'
import { Recorder } from '../../src/game/record'
import { StudyController } from '../../src/game/study'
import type { StudyOptions } from '../../src/game/study'
import { clearComponents } from '../helpers'

function options(overrides: Partial<StudyOptions> = {}): StudyOptions {
  return {
    games: 2,
    size: 8,
    mode: 'ai-vs-ai',
    seedBase: 1,
    maxTurns: 60,
    policy: 'none',
    autoPreserve: true,
    captureAdvance: false,
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

  it('records scripted human orders in human-vs-ai games', () => {
    clearComponents()
    const human = new Game(8, 'human-vs-ai', 3)
    const controller = new StudyController(human, new Recorder(human))
    controller.start(options({ games: 1, mode: 'human-vs-ai', policy: 'focus', maxTurns: 6 }))
    pump(controller, human)

    const result = controller.state.results[0]
    expect(result.record.turns.length).toBeGreaterThan(0)
    expect(result.record.turns.reduce((n, t) => n + t.intents.length, 0)).toBeGreaterThan(0)
    controller.dispose()
  })
})
