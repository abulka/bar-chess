import { beforeEach, describe, expect, it } from 'vitest'
import { Health } from '../../src/ecs/components'
import type { SimContext } from '../../src/ecs/types'
import { createPiece } from '../../src/game/factory'
import { HEAL_RATE } from '../../src/game/healing'
import { PIECES } from '../../src/game/pieces'
import healing from '../../src/ecs/systems/healing'
import { clearComponents, makeContext } from '../helpers'

/** One tick of healing, so a max-HP piece gains `max * HEAL_RATE * dt`. */
const perTick = (max: number, dt: number) => max * HEAL_RATE * dt

describe('healing system — king aura regeneration', () => {
  beforeEach(() => clearComponents())

  it('heals a damaged same-team piece within two squares of the king', () => {
    const ctx = makeContext()
    createPiece(ctx, 'blue', PIECES.king, { x: 4, y: 4 })
    const pawn = createPiece(ctx, 'blue', PIECES.pawn, { x: 6, y: 6 }) // Chebyshev 2
    const health = ctx.world.require(pawn, Health)
    health.cur = 10

    healing.update(ctx)

    expect(health.cur).toBeCloseTo(10 + perTick(health.max, ctx.dt), 6)
  })

  it('leaves a piece outside the radius untouched', () => {
    const ctx = makeContext()
    createPiece(ctx, 'blue', PIECES.king, { x: 4, y: 4 })
    const pawn = createPiece(ctx, 'blue', PIECES.pawn, { x: 7, y: 7 }) // Chebyshev 3
    const health = ctx.world.require(pawn, Health)
    health.cur = 10

    healing.update(ctx)

    expect(health.cur).toBe(10)
  })

  it('never heals the enemy team', () => {
    const ctx = makeContext()
    createPiece(ctx, 'blue', PIECES.king, { x: 4, y: 4 })
    const enemy = createPiece(ctx, 'red', PIECES.pawn, { x: 5, y: 5 })
    const health = ctx.world.require(enemy, Health)
    health.cur = 10

    healing.update(ctx)

    expect(health.cur).toBe(10)
  })

  it('heals the king itself', () => {
    const ctx = makeContext()
    const king = createPiece(ctx, 'blue', PIECES.king, { x: 4, y: 4 })
    const health = ctx.world.require(king, Health)
    health.cur = 100

    healing.update(ctx)

    expect(health.cur).toBeCloseTo(100 + perTick(health.max, ctx.dt), 6)
  })

  it('clamps healing at max health', () => {
    const ctx = makeContext()
    createPiece(ctx, 'blue', PIECES.king, { x: 4, y: 4 })
    const pawn = createPiece(ctx, 'blue', PIECES.pawn, { x: 5, y: 5 })
    const health = ctx.world.require(pawn, Health)
    health.cur = health.max - 0.001

    healing.update(ctx)

    expect(health.cur).toBe(health.max)
  })

  it('does not revive a piece at zero health', () => {
    const ctx = makeContext()
    createPiece(ctx, 'blue', PIECES.king, { x: 4, y: 4 })
    const pawn = createPiece(ctx, 'blue', PIECES.pawn, { x: 5, y: 5 })
    const health = ctx.world.require(pawn, Health)
    health.cur = 0

    healing.update(ctx)

    expect(health.cur).toBe(0)
  })

  it('does nothing for a king-less team', () => {
    const ctx = makeContext()
    const pawn = createPiece(ctx, 'blue', PIECES.pawn, { x: 5, y: 5 })
    ctx.world.require(pawn, Health).cur = 10

    expect(() => healing.update(ctx)).not.toThrow()
    expect(ctx.world.require(pawn, Health).cur).toBe(10)
  })
})
