import { beforeEach, describe, expect, it } from 'vitest'
import { Projectile, Target, Weapon } from '../../src/ecs/components'
import type { SimContext } from '../../src/ecs/types'
import { buildOccupancy } from '../../src/game/occupancy'
import { createPiece } from '../../src/game/factory'
import { PIECES } from '../../src/game/pieces'
import combat from '../../src/ecs/systems/combat'
import { clearComponents, makeContext } from '../helpers'

function run(ctx: SimContext): void {
  ctx.occupancy = buildOccupancy(ctx.world, ctx.board)
  combat.update(ctx)
}

describe('combat system — checkmate focus fire', () => {
  beforeEach(() => clearComponents())

  it('shoots the trapped king even when the standing target is elsewhere', () => {
    const ctx = makeContext()
    const bishop = createPiece(ctx, 'blue', PIECES.bishop, { x: 6, y: 6 }) // g2
    const king = createPiece(ctx, 'red', PIECES.king, { x: 0, y: 0 }) // a8, on the long diagonal
    const pawn = createPiece(ctx, 'red', PIECES.pawn, { x: 2, y: 4 }) // c4, off the bishop's line
    ctx.world.require(bishop, Weapon).left = 0
    ctx.world.require(bishop, Target).entity = pawn
    ctx.checkmate.red = true

    run(ctx)

    const shots = ctx.world.query(Projectile)
    expect(shots).toHaveLength(1)
    expect(ctx.world.get(shots[0], Projectile)?.target).toBe(king)
    // The visible target is updated so the UI shows the focus.
    expect(ctx.world.require(bishop, Target).entity).toBe(king)
  })

  it('keeps the standing target when no king is checkmated', () => {
    const ctx = makeContext()
    const bishop = createPiece(ctx, 'blue', PIECES.bishop, { x: 6, y: 6 })
    createPiece(ctx, 'red', PIECES.king, { x: 0, y: 0 })
    const pawn = createPiece(ctx, 'red', PIECES.pawn, { x: 5, y: 5 }) // f3, on the diagonal
    ctx.world.require(bishop, Weapon).left = 0
    ctx.world.require(bishop, Target).entity = pawn

    run(ctx)

    const shots = ctx.world.query(Projectile)
    expect(shots).toHaveLength(1)
    expect(ctx.world.get(shots[0], Projectile)?.target).toBe(pawn)
  })
})
