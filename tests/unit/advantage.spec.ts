import { beforeEach, describe, expect, it } from 'vitest'
import { Cell, Health, Weapon } from '../../src/ecs/components'
import type { SimContext } from '../../src/ecs/types'
import {
  advantageDetail,
  advantageFraction,
  advantageLabel,
  describeAdvantage,
  evaluatePosition,
  smoothScore,
} from '../../src/game/advantage'
import { createPiece } from '../../src/game/factory'
import { Game } from '../../src/game/game'
import { PIECES } from '../../src/game/pieces'
import { clearComponents } from '../helpers'

function shim(game: Game): SimContext {
  return { world: game.world, board: game.board, rng: game.rng } as unknown as SimContext
}

function stripArmy(game: Game): void {
  for (const e of [...game.world.query(Cell)]) game.world.destroy(e)
}

function place(game: Game, kind: string, team: 'red' | 'blue', x: number, y: number): number {
  const e = createPiece(shim(game), team, PIECES[kind], { x, y })
  const weapon = game.world.get(e, Weapon)
  if (weapon) weapon.left = 0
  return e
}

describe('position evaluation', () => {
  beforeEach(() => clearComponents())

  it('reads the symmetric opening as even', () => {
    const game = new Game(8, 'ai-vs-ai')
    expect(Math.abs(evaluatePosition(game))).toBeLessThan(0.25)
    expect(game.snapshot().advantage).toBeCloseTo(evaluatePosition(game), 6)
  })

  it('puts the side with extra material ahead', () => {
    const game = new Game(8, 'ai-vs-ai')
    stripArmy(game)
    place(game, 'king', 'blue', 4, 7)
    place(game, 'king', 'red', 4, 0)
    expect(Math.abs(evaluatePosition(game))).toBeLessThan(0.25)

    place(game, 'queen', 'blue', 0, 7)
    // Blue is a whole queen up: advantage is negative (red behind).
    expect(evaluatePosition(game)).toBeLessThan(-7)
  })

  it('tracks a wounded king', () => {
    const game = new Game(8, 'ai-vs-ai')
    stripArmy(game)
    const redKing = place(game, 'king', 'red', 4, 0)
    place(game, 'king', 'blue', 4, 7)
    expect(Math.abs(evaluatePosition(game))).toBeLessThan(0.25)

    game.world.require(redKing, Health).cur = 24 // 10%
    // Red's king is nearly dead, so red is behind.
    expect(evaluatePosition(game)).toBeLessThan(0)
  })

  it('counts a piece that can hit the enemy king right now', () => {
    const game = new Game(8, 'ai-vs-ai')
    stripArmy(game)
    place(game, 'king', 'red', 4, 0)
    place(game, 'king', 'blue', 4, 7)
    const queen = place(game, 'queen', 'blue', 4, 4) // same file as the red king
    const inLine = evaluatePosition(game)

    const cell = game.world.require(queen, Cell)
    cell.x = 3 // off the file and not on a diagonal to the king
    const offLine = evaluatePosition(game)

    expect(inLine).toBeLessThan(offLine)
  })

  it('lets a nearly dead king outweigh a whole queen', () => {
    const game = new Game(8, 'ai-vs-ai')
    stripArmy(game)
    place(game, 'king', 'red', 4, 0)
    const blueKing = place(game, 'king', 'blue', 4, 7)
    place(game, 'queen', 'blue', 0, 7) // pure material edge, no line to the red king

    const healthy = evaluatePosition(game)
    expect(healthy).toBeLessThan(0) // blue's queen is worth more than a healthy king

    game.world.require(blueKing, Health).cur = 22 // 9%: one hit from death
    const wounded = evaluatePosition(game)
    expect(wounded).toBeGreaterThan(0)
    // The crisis term should move the score by well over a queen.
    expect(wounded - healthy).toBeGreaterThan(10)
  })

  it('counts a threat by the share of the king’s remaining life it removes', () => {
    const game = new Game(8, 'ai-vs-ai')
    stripArmy(game)
    const redKing = place(game, 'king', 'red', 4, 0)
    place(game, 'king', 'blue', 4, 7)
    place(game, 'rook', 'blue', 4, 4) // covers the red king's file

    const full = advantageDetail(game).pressure.blue
    game.world.require(redKing, Health).cur = 15
    const low = advantageDetail(game).pressure.blue

    expect(low).toBeGreaterThan(full)
    expect(advantageDetail(game).kingInLethal.red).toBe(true)
  })

  it('treats a trapped king as decisive whatever the material', () => {
    const game = new Game(8, 'ai-vs-ai')
    stripArmy(game)
    place(game, 'king', 'red', 0, 0) // a8
    place(game, 'king', 'blue', 1, 2) // b6: defends the queen and covers a7
    place(game, 'queen', 'blue', 1, 1) // b7: checks a8 and covers every escape

    const detail = advantageDetail(game)
    expect(detail.lost.red).toBe(true)
    expect(detail.score).toBeLessThan(-50)
    expect(describeAdvantage(detail)).toContain("Orange's king is trapped — checkmate")
    // The snapshot exposes the flag for the turn-bar checkmate badge.
    expect(game.snapshot().checkmate.red).toBe(true)
    expect(game.snapshot().checkmate.blue).toBe(false)
  })

  it('does not treat a safe king with blocked squares as lost', () => {
    const game = new Game(8, 'ai-vs-ai')
    stripArmy(game)
    place(game, 'king', 'red', 0, 0) // a8
    place(game, 'king', 'blue', 7, 7)
    place(game, 'queen', 'blue', 2, 1) // c7: does not check a8

    expect(advantageDetail(game).lost.red).toBe(false)
    expect(game.snapshot().checkmate.red).toBe(false)
  })

  it('does not let weapon reload phase flip the evaluation', () => {
    const game = new Game(8, 'ai-vs-ai')
    stripArmy(game)
    const redKing = place(game, 'king', 'red', 3, 0)
    const blueKing = place(game, 'king', 'blue', 4, 7)
    const redRook = place(game, 'rook', 'red', 4, 2) // covers the blue king
    const blueRook = place(game, 'rook', 'blue', 3, 5) // covers the red king
    game.world.require(redKing, Health).cur = 60
    game.world.require(blueKing, Health).cur = 60

    // A reloading weapon is still a threat: swapping whose weapon is ready must
    // not move the score (the old readiness factor flipped the bar each turn).
    game.world.require(redRook, Weapon).left = 0
    game.world.require(blueRook, Weapon).left = 1.9
    const redReady = evaluatePosition(game)
    game.world.require(redRook, Weapon).left = 1.9
    game.world.require(blueRook, Weapon).left = 0
    const blueReady = evaluatePosition(game)

    expect(redReady).toBeCloseTo(blueReady, 6)
    expect(Math.abs(redReady)).toBeLessThan(0.5)
  })

  it('damps per-turn bar oscillation', () => {
    expect(smoothScore(0, 8)).toBeCloseTo(2.8, 6)
    // Alternating end-to-end targets are attenuated to a small wobble around
    // the centre instead of slamming end to end.
    let score = 0
    for (let i = 0; i < 8; i++) score = smoothScore(score, i % 2 === 0 ? 8 : -8)
    expect(Math.abs(score)).toBeLessThan(2.5)
  })
})

describe('advantage bar mapping', () => {
  it('is bounded, centered at even and monotonic', () => {
    expect(advantageFraction(0)).toBe(0)
    expect(advantageFraction(100)).toBeCloseTo(1, 2)
    expect(advantageFraction(-100)).toBeCloseTo(-1, 2)
    expect(advantageFraction(3)).toBeGreaterThan(0)
    expect(advantageFraction(6)).toBeGreaterThan(advantageFraction(3))
    expect(advantageFraction(-3)).toBeLessThan(0)
  })

  it('labels the leader', () => {
    expect(advantageLabel(0)).toBe('even')
    expect(advantageLabel(3.24)).toBe('Orange +3.2')
    expect(advantageLabel(-1.5)).toBe('Blue +1.5')
  })

  it('describes the position specifically', () => {
    const game = new Game(8, 'ai-vs-ai')
    stripArmy(game)
    place(game, 'king', 'blue', 4, 7)
    place(game, 'king', 'red', 4, 0)
    const blueQueen = place(game, 'queen', 'blue', 4, 4)
    // A full queen plus a clear line to the red king.
    const text = describeAdvantage(advantageDetail(game))
    expect(text).toContain('Blue leads by')
    expect(text).toContain('Blue +1 queen')
    expect(text).toContain("Orange's king is under fire")

    // Material totals move with the queen's health.
    game.world.require(blueQueen, Health).cur = 1
    const detail = advantageDetail(game)
    expect(detail.material.blue).toBeLessThan(1)
    expect(detail.counts.blue.queen).toBe(1)
  })
})
