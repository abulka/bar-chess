import { beforeEach, describe, expect, it } from 'vitest'
import { Cell, Health, Weapon } from '../../src/ecs/components'
import type { SimContext } from '../../src/ecs/types'
import {
  advantageDetail,
  advantageFraction,
  advantageLabel,
  describeAdvantage,
  evaluatePosition,
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
