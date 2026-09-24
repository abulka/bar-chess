import { beforeEach, describe, expect, it } from 'vitest'
import { Order, Stance, Target } from '../../src/ecs/components'
import type { SimContext } from '../../src/ecs/types'
import { createPiece } from '../../src/game/factory'
import { PIECES } from '../../src/game/pieces'
import targeting from '../../src/ecs/systems/targeting'
import { clearComponents, makeContext } from '../helpers'

describe('targeting system — Attack leash', () => {
  beforeEach(() => clearComponents())

  const context = (): SimContext => makeContext({ size: 16 })

  function run(ctx: SimContext): void {
    targeting.update(ctx)
  }

  it('acquires an enemy within the leash', () => {
    const ctx = context()
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 0, y: 0 })
    const enemy = createPiece(ctx, 'red', PIECES.knight, { x: 5, y: 0 })
    ctx.world.require(queen, Stance).mode = 'attack'

    run(ctx)

    expect(ctx.world.require(queen, Target).entity).toBe(enemy)
  })

  it('ignores an enemy beyond the leash instead of chasing board-wide', () => {
    const ctx = context()
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 0, y: 0 })
    createPiece(ctx, 'red', PIECES.knight, { x: 12, y: 0 })
    ctx.world.require(queen, Stance).mode = 'attack'

    run(ctx)

    expect(ctx.world.require(queen, Target).entity).toBeNull()
  })

  it('prefers an enemy it can actually shoot over a nearer off-line one', () => {
    const ctx = context()
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 3, y: 0 }) // d8
    const pawn = createPiece(ctx, 'red', PIECES.pawn, { x: 2, y: 6 }) // c2, closer but off the queen's lines
    const enemyQueen = createPiece(ctx, 'red', PIECES.queen, { x: 3, y: 7 }) // d1, on the open d-file
    ctx.world.require(queen, Stance).mode = 'attack'

    run(ctx)

    expect(ctx.world.require(queen, Target).entity).toBe(enemyQueen)
    expect(ctx.world.require(queen, Target).entity).not.toBe(pawn)
  })

  it('records why an attack order was abandoned when its target disappears', () => {
    const ctx = context()
    const knight = createPiece(ctx, 'blue', PIECES.knight, { x: 2, y: 2 })
    const queen = createPiece(ctx, 'red', PIECES.queen, { x: 3, y: 0 })
    const order = ctx.world.require(knight, Order)
    order.kind = 'attack'
    order.target = queen
    order.reachable = true
    ctx.world.destroy(queen)

    run(ctx)

    expect(order.kind).toBe('none')
    expect(order.log[order.log.length - 1].text).toContain('attack abandoned')
  })

  it('returns fire at the enemy shooting it over an equally-shootable one', () => {
    const ctx = context()
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 0, y: 0 })
    const other = createPiece(ctx, 'red', PIECES.rook, { x: 6, y: 0 }) // clear rank, dist 6
    const attacker = createPiece(ctx, 'red', PIECES.rook, { x: 0, y: 6 }) // clear file, dist 6
    const target = ctx.world.require(queen, Target)
    target.lastAttacker = attacker
    target.underFireUntil = 10
    ctx.world.require(queen, Stance).mode = 'attack'

    run(ctx)

    expect(ctx.world.require(queen, Target).entity).toBe(attacker)
    expect(ctx.world.require(queen, Target).entity).not.toBe(other)
  })
})
