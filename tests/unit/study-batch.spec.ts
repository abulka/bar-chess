import { describe, expect, it } from 'vitest'
import { formatBatchSummary, summarizeBatch } from '../../src/game/analysis'
import { Game } from '../../src/game/game'
import { Recorder } from '../../src/game/record'
import { StudyController } from '../../src/game/study'
import type { StudyGameResult, StudyOptions } from '../../src/game/study'
import { clearComponents } from '../helpers'

/** The StudyPanel defaults used for the reference batch (seeds 1-5). */
function options(overrides: Partial<StudyOptions> = {}): StudyOptions {
  return {
    games: 5,
    size: 8,
    mode: 'ai-vs-ai',
    seedBase: 1,
    maxTurns: 120,
    policy: 'none',
    speed: 'fast',
    piecesPerTurn: 3,
    attackChance: 0.2,
    autoPreserve: true,
    captureAdvance: true,
    chessKills: false,
    promotion: true,
    finishPressure: true,
    ...overrides,
  }
}

function drainTurn(game: Game): void {
  let guard = 0
  while (game.turnActive && guard++ < 4000) game.runTicks(1)
}

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

function summaryOf(results: StudyGameResult[]) {
  return summarizeBatch(
    results.map((r) => ({
      seed: r.seed,
      winner: r.winner,
      turns: r.turns,
      partial: r.partial,
      analysis: r.analysis,
    })),
  )
}

describe('study batch reference', () => {
  it('resolves the reference 5-seed batch without long static sieges', () => {
    const results = runBatch(options())
    const summary = summaryOf(results)

    expect(results).toHaveLength(5)
    // Report for inspection when run with --silent=false.
    console.log(formatBatchSummary(summary))
    for (const r of results) {
      console.log(
        `seed ${r.seed}: ${r.winner ?? 'none'} ${r.turns}t partial=${r.partial} ` +
          `kingOnly=${r.analysis.kingOnlyTurns} check=${r.analysis.kingCheckTurns} ` +
          `kingShots=${r.analysis.kingShotsWhileAlone} osc=${r.analysis.oscillation.length} ` +
          `noProg=${r.analysis.noProgressTurns} ` +
          `held3=${r.analysis.heldUnderFire
            .filter((h) => h.maxStreak >= 3)
            .map((h) => `${h.piece}:${h.maxStreak}`)
            .join(',')}`,
      )
    }
    // At most one unresolved game, and no piece pinned under fire for a long run.
    expect(summary.timeouts).toBeLessThanOrEqual(1)
    expect(results.filter((r) => r.winner !== null).length).toBeGreaterThanOrEqual(4)
    const maxHoldStreak = Math.max(
      0,
      ...results.flatMap((r) => r.analysis.heldUnderFire.map((h) => h.maxStreak)),
    )
    expect(maxHoldStreak).toBeLessThanOrEqual(6)
    // A king trapped in check may legally have no escape and hold; mere beat
    // counts of reversals across a whole game are allowed, but not rapid dither.
    expect(summary.oscillationCount).toBeLessThanOrEqual(30)
    expect(summary.kingShotsWhileAlone).toBeGreaterThanOrEqual(3)
    expect(summary.noProgressTurns).toBeLessThanOrEqual(30)
  }, 180000)
})
