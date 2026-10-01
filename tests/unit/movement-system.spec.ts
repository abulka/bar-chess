import { beforeEach, describe, expect, it } from 'vitest'
import { Cell, Health, Motion, Order } from '../../src/ecs/components'
import type { MotionData } from '../../src/ecs/components'
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

describe('movement system — refuses hops into lethal fire', () => {
  beforeEach(() => clearComponents())

  /** A red rook on a6 whose next hop (a7) is covered fatally by a blue rook on a8. */
  function setup(controller: 'ai' | 'human', intent: 'engage' | 'order') {
    const ctx = makeContext()
    ctx.teams.red.controller = controller
    const rook = createPiece(ctx, 'red', PIECES.rook, { x: 0, y: 2 }) // a6
    createPiece(ctx, 'blue', PIECES.rook, { x: 0, y: 0 }) // a8, 20 damage down the a-file
    ctx.world.require(rook, Health).cur = 10 // one rook hit is fatal
    const motion = ctx.world.require(rook, Motion)
    motion.intent = intent
    motion.goal = { x: 0, y: 1 }
    motion.path = [{ x: 0, y: 1 }]
    motion.cooldown = 0
    return { ctx, rook, motion }
  }

  it('holds an AI piece rather than stepping into a fatal line', () => {
    const { ctx, rook, motion } = setup('ai', 'engage')
    run(ctx)
    expect(motion.moving).toBe(false)
    expect(motion.path).toEqual([])
    expect(motion.blocked).toBe(true)
    expect(ctx.world.require(rook, Cell)).toEqual({ x: 0, y: 2 })
  })

  it('holds an explicit player order rather than stepping into a firing line', () => {
    const { ctx, motion } = setup('human', 'order')
    run(ctx)
    expect(motion.moving).toBe(false)
    expect(motion.path).toEqual([])
    expect(motion.blocked).toBe(true)
  })

  it('carries the order through when the player insists (Alt-click)', () => {
    const { ctx, rook, motion } = setup('human', 'order')
    ctx.world.require(rook, Order).noPreserve = true
    run(ctx)
    expect(motion.moving).toBe(true)
    expect(motion.reserved).toEqual({ x: 0, y: 1 })
  })

  it('holds an explicit order rather than stepping beside the enemy king', () => {
    const ctx = makeContext()
    ctx.teams.red.controller = 'human'
    const rook = createPiece(ctx, 'red', PIECES.rook, { x: 0, y: 2 }) // a6
    createPiece(ctx, 'blue', PIECES.king, { x: 1, y: 0 }) // b8: its guard covers a7
    const motion = ctx.world.require(rook, Motion)
    motion.intent = 'order'
    motion.goal = { x: 0, y: 1 }
    motion.path = [{ x: 0, y: 1 }]
    motion.cooldown = 0
    run(ctx)
    // A guard hit is a heavy but survivable fraction of max HP; the hop is still
    // refused, so a piece no longer parks in the enemy king's kill zone.
    expect(motion.moving).toBe(false)
    expect(motion.path).toEqual([])
    expect(motion.blocked).toBe(true)
  })
})

describe('movement system — checkmate freezes movement', () => {
  beforeEach(() => clearComponents())

  function marcher(checkmate: boolean): { ctx: SimContext; motion: MotionData } {
    const ctx = makeContext()
    const rook = createPiece(ctx, 'red', PIECES.rook, { x: 0, y: 2 })
    const motion = ctx.world.require(rook, Motion)
    motion.intent = 'rally'
    motion.goal = { x: 0, y: 0 }
    motion.path = [{ x: 0, y: 1 }]
    motion.cooldown = 0
    ctx.checkmate.red = checkmate
    return { ctx, motion }
  }

  it('starts a hop when no king is trapped', () => {
    const { ctx, motion } = marcher(false)
    run(ctx)
    expect(motion.moving).toBe(true)
    expect(motion.reserved).toEqual({ x: 0, y: 1 })
  })

  it('refuses a new hop while either king is checkmated', () => {
    const { ctx, motion } = marcher(true)
    run(ctx)
    expect(motion.moving).toBe(false)
    expect(motion.reserved).toBeNull()
    expect(motion.path).toEqual([{ x: 0, y: 1 }])
  })

  it('still finishes a hop already in flight', () => {
    const { ctx, motion } = marcher(true)
    motion.moving = true
    motion.fromX = 0
    motion.fromY = 96
    motion.toX = 0
    motion.toY = 48
    motion.travel = 0.01
    motion.elapsed = 1
    motion.reserved = { x: 0, y: 1 }
    run(ctx)
    expect(motion.moving).toBe(false)
  })
})
