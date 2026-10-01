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
    defendedHeal: true,
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
    // At most one turn-cap partial. Every other game must actually be decided —
    // a win, or a genuine kings-only draw (no winning material left) — and no
    // piece may sit under fire for a long run.
    expect(summary.timeouts).toBeLessThanOrEqual(1)
    expect(summary.redWins + summary.blueWins + summary.draws).toBeGreaterThanOrEqual(4)
    const maxHoldStreak = Math.max(
      0,
      ...results.flatMap((r) => r.analysis.heldUnderFire.map((h) => h.maxStreak)),
    )
    // A study run stops the moment mate is called, so the long holds of the old
    // shoot-the-king-to-death finish are gone; only ordinary fire holds remain.
    expect(maxHoldStreak).toBeLessThanOrEqual(7)
    // A king trapped in check may legally have no escape and hold; mere beat
    // counts of reversals across a whole game are allowed, but not rapid dither.
    // Retreats that route around the enemy king's kill zone rather than through
    // it let wounded pieces survive and heal, and pieces now reposition out of
    // enemy firing positions rather than standing in them, so they change square
    // more often. The batch is still decisive with no stalls (noProgressTurns=0,
    // timeouts=0), so the reversal budget is raised to match the safer movement.
    expect(summary.oscillationCount).toBeLessThanOrEqual(50)
    // A checkmate now finishes mid-battle, so this batch rarely grinds all the
    // way down to the lone-king phase where a cornered king trades fire. The
    // trapped-king count confirms the checkmate mechanic is genuinely exercised;
    // the lone-king logic itself is covered directly in `endgame.spec.ts`.
    expect(summary.kingCheckTurns).toBeGreaterThan(0)
    expect(summary.noProgressTurns).toBeLessThanOrEqual(30)
  }, 180000)
})
