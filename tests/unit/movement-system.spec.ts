import { beforeEach, describe, expect, it } from 'vitest'
import { Cell, Motion } from '../../src/ecs/components'
import type { SimContext } from '../../src/ecs/types'
import { buildOccupancy } from '../../src/game/occupancy'
import { createPiece } from '../../src/game/factory'
import { PIECES } from '../../src/game/pieces'
import movement from '../../src/ecs/systems/movement'
import { clearComponents, makeContext } from '../helpers'

function run(ctx: SimContext): void {
  ctx.occupancy = buildOccupancy(ctx.world, ctx.board)
  movement.update(ctx)
}

describe('movement system — self-preservation within the AI move budget', () => {
  beforeEach(() => clearComponents())

  it('serves a retreating piece before an autonomous advance when the allowance is one', () => {
    const ctx = makeContext()
    ctx.turnActive = true
    ctx.teams.red.controller = 'ai'
    ctx.teams.blue.controller = 'human'
    // The human makes no moves, so the AI gets its floor of one move.
    ctx.teams.blue.movesThisTurn = 0

    // Lower entity id: an ordinary autonomous advance (a rally goal).
    const bishop = createPiece(ctx, 'red', PIECES.bishop, { x: 0, y: 0 })
    const bishopMotion = ctx.world.require(bishop, Motion)
    bishopMotion.intent = 'rally'
    bishopMotion.goal = { x: 2, y: 2 }
    bishopMotion.path = [{ x: 1, y: 1 }]
    bishopMotion.cooldown = 0

    // Higher entity id: a wounded piece retreating on its own.
    const rook = createPiece(ctx, 'red', PIECES.rook, { x: 7, y: 0 })
    const rookMotion = ctx.world.require(rook, Motion)
    rookMotion.intent = 'preserve'
    rookMotion.goal = { x: 6, y: 0 }
    rookMotion.path = [{ x: 6, y: 0 }]
    rookMotion.cooldown = 0

    run(ctx)

    // The retreat takes the turn's only move...
    expect(rookMotion.moving).toBe(true)
    expect(rookMotion.reserved).toEqual({ x: 6, y: 0 })
    // ...and the advance is left for a later turn.
    expect(bishopMotion.moving).toBe(false)
    expect(bishopMotion.reserved).toBeNull()
    expect(ctx.world.require(bishop, Cell)).toEqual({ x: 0, y: 0 })
  })
})
