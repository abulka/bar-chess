import { beforeEach, describe, expect, it } from 'vitest'
import { Health } from '../../src/ecs/components'
import type { SimContext } from '../../src/ecs/types'
import { createPiece } from '../../src/game/factory'
import { HEAL_RATE, HUMAN_HEAL_MULTIPLIER } from '../../src/game/healing'
import { PIECES } from '../../src/game/pieces'
import healing from '../../src/ecs/systems/healing'
import { clearComponents, makeContext } from '../helpers'

/** One tick of base-rate healing, so a max-HP piece gains `max * HEAL_RATE * dt`. */
const perTick = (max: number, dt: number) => max * HEAL_RATE * dt

/** A context whose teams are AI-controlled, so healing uses the base rate. */
function aiContext(): SimContext {
  const ctx = makeContext()
  ctx.teams.red.controller = 'ai'
  ctx.teams.blue.controller = 'ai'
  return ctx
}

describe('healing system — king aura regeneration', () => {
  beforeEach(() => clearComponents())

  it('heals a damaged same-team piece within two squares of the king', () => {
    const ctx = aiContext()
    createPiece(ctx, 'blue', PIECES.king, { x: 4, y: 4 })
    const pawn = createPiece(ctx, 'blue', PIECES.pawn, { x: 6, y: 6 }) // Chebyshev 2
    const health = ctx.world.require(pawn, Health)
    health.cur = 10

    healing.update(ctx)

    expect(health.cur).toBeCloseTo(10 + perTick(health.max, ctx.dt), 6)
  })

  it('leaves a piece outside the radius untouched', () => {
    const ctx = aiContext()
    createPiece(ctx, 'blue', PIECES.king, { x: 4, y: 4 })
    const pawn = createPiece(ctx, 'blue', PIECES.pawn, { x: 7, y: 7 }) // Chebyshev 3
    const health = ctx.world.require(pawn, Health)
    health.cur = 10

    healing.update(ctx)

    expect(health.cur).toBe(10)
  })

  it('never heals the enemy team', () => {
    const ctx = aiContext()
    createPiece(ctx, 'blue', PIECES.king, { x: 4, y: 4 })
    const enemy = createPiece(ctx, 'red', PIECES.pawn, { x: 5, y: 5 })
    const health = ctx.world.require(enemy, Health)
    health.cur = 10

    healing.update(ctx)

    expect(health.cur).toBe(10)
  })

  it('does not heal the king itself', () => {
    const ctx = aiContext()
    const king = createPiece(ctx, 'blue', PIECES.king, { x: 4, y: 4 })
    const health = ctx.world.require(king, Health)
    health.cur = 100

    healing.update(ctx)

    expect(health.cur).toBe(100)
  })

  it('still heals nearby pieces while the king itself stays damaged', () => {
    const ctx = aiContext()
    const king = createPiece(ctx, 'blue', PIECES.king, { x: 4, y: 4 })
    const kingHealth = ctx.world.require(king, Health)
    kingHealth.cur = 100
    const pawn = createPiece(ctx, 'blue', PIECES.pawn, { x: 5, y: 5 })
    const pawnHealth = ctx.world.require(pawn, Health)
    pawnHealth.cur = 10

    healing.update(ctx)

    expect(kingHealth.cur).toBe(100)
    expect(pawnHealth.cur).toBeCloseTo(10 + perTick(pawnHealth.max, ctx.dt), 6)
  })

  it('clamps healing at max health', () => {
    const ctx = aiContext()
    createPiece(ctx, 'blue', PIECES.king, { x: 4, y: 4 })
    const pawn = createPiece(ctx, 'blue', PIECES.pawn, { x: 5, y: 5 })
    const health = ctx.world.require(pawn, Health)
    health.cur = health.max - 0.001

    healing.update(ctx)

    expect(health.cur).toBe(health.max)
  })

  it('does not revive a piece at zero health', () => {
    const ctx = aiContext()
    createPiece(ctx, 'blue', PIECES.king, { x: 4, y: 4 })
    const pawn = createPiece(ctx, 'blue', PIECES.pawn, { x: 5, y: 5 })
    const health = ctx.world.require(pawn, Health)
    health.cur = 0

    healing.update(ctx)

    expect(health.cur).toBe(0)
  })

  it('does nothing for a king-less team', () => {
    const ctx = aiContext()
    const pawn = createPiece(ctx, 'blue', PIECES.pawn, { x: 5, y: 5 })
    ctx.world.require(pawn, Health).cur = 10

    expect(() => healing.update(ctx)).not.toThrow()
    expect(ctx.world.require(pawn, Health).cur).toBe(10)
  })

  it('heals a human-controlled team HUMAN_HEAL_MULTIPLIER times faster', () => {
    const ctx = makeContext()
    ctx.teams.red.controller = 'ai' // blue stays human
    createPiece(ctx, 'blue', PIECES.king, { x: 4, y: 4 })
    const blue = createPiece(ctx, 'blue', PIECES.pawn, { x: 5, y: 5 })
    createPiece(ctx, 'red', PIECES.king, { x: 0, y: 0 })
    const red = createPiece(ctx, 'red', PIECES.pawn, { x: 1, y: 1 })
    const blueHealth = ctx.world.require(blue, Health)
    const redHealth = ctx.world.require(red, Health)
    blueHealth.cur = 10
    redHealth.cur = 10

    healing.update(ctx)

    const blueGain = blueHealth.cur - 10
    const redGain = redHealth.cur - 10
    expect(redGain).toBeCloseTo(perTick(redHealth.max, ctx.dt), 6)
    expect(blueGain).toBeCloseTo(redGain * HUMAN_HEAL_MULTIPLIER, 6)
  })
})
