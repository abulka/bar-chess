import { beforeEach, describe, expect, it } from 'vitest'
import { Cell, Motion, Order, PieceType, Position, Stance, Team } from '../../src/ecs/components'
import type { SimContext } from '../../src/ecs/types'
import { createPiece } from '../../src/game/factory'
import { PIECES } from '../../src/game/pieces'
import advance from '../../src/ecs/systems/advance'
import cleanup from '../../src/ecs/systems/cleanup'
import damage from '../../src/ecs/systems/damage'
import death from '../../src/ecs/systems/death'
import movement from '../../src/ecs/systems/movement'
import { clearComponents, makeContext } from '../helpers'

describe('advance system — chess-style capture step', () => {
  beforeEach(() => clearComponents())

  const context = (): SimContext => makeContext({ captureAdvance: true })

  /** Kill `victim` (remove it) and queue the killer-to-victim-cell intent. */
  function kill(ctx: SimContext, killer: number, victim: number): void {
    ctx.world.require(killer, Stance).mode = 'attack'
    const vcell = { ...ctx.world.require(victim, Cell) }
    ctx.world.destroy(victim)
    ctx.cmds.advance.push({ killer, victim, cell: vcell })
  }

  function cellOf(ctx: SimContext, e: number): { x: number; y: number } {
    return { ...ctx.world.require(e, Cell) }
  }

  /** Run the movement system until the acceptance glide has landed. */
  function settle(ctx: SimContext, maxTicks = 200): void {
    for (let i = 0; i < maxTicks; i++) {
      const moving = [...ctx.world.query(Motion)].some((e) => ctx.world.get(e, Motion)?.moving)
      if (!moving) return
      movement.update(ctx)
    }
  }

  it('glides an idle killer onto the victim square it shot along', () => {
    const ctx = context()
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 0, y: 0 })
    const victim = createPiece(ctx, 'red', PIECES.pawn, { x: 0, y: 4 })
    kill(ctx, queen, victim)

    advance.update(ctx)

    // The cell stays put until arrival; the destination is reserved and a slow,
    // eased tween is in flight.
    expect(cellOf(ctx, queen)).toEqual({ x: 0, y: 0 })
    const motion = ctx.world.require(queen, Motion)
    expect(motion.moving).toBe(true)
    expect(motion.ease).toBe(true)
    expect(motion.freeAdvance).toBe(true)
    expect(motion.reserved).toEqual({ x: 0, y: 4 })
    expect(motion.travel).toBeGreaterThan(0.5)
    // No settling beat: the glide starts the same tick as the blast.
    expect(motion.elapsed).toBe(0)

    settle(ctx)

    expect(cellOf(ctx, queen)).toEqual({ x: 0, y: 4 })
    expect(ctx.world.require(queen, Position)).toEqual(ctx.board.cellCenter(0, 4))
  })

  it('does not advance when the firing line is blocked', () => {
    const ctx = context()
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 0, y: 0 })
    const victim = createPiece(ctx, 'red', PIECES.pawn, { x: 0, y: 4 })
    createPiece(ctx, 'red', PIECES.pawn, { x: 0, y: 2 }) // stands between them
    kill(ctx, queen, victim)

    advance.update(ctx)

    expect(cellOf(ctx, queen)).toEqual({ x: 0, y: 0 })
    expect(ctx.world.require(queen, Motion).moving).toBe(false)
  })

  it('leaves an occupied destination alone', () => {
    const ctx = context()
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 0, y: 0 })
    const victim = createPiece(ctx, 'red', PIECES.pawn, { x: 0, y: 4 })
    const blocker = createPiece(ctx, 'red', PIECES.pawn, { x: 1, y: 4 })
    kill(ctx, queen, victim)
    // Move the blocker onto the vacated square after the intent was queued.
    const bc = ctx.world.require(blocker, Cell)
    bc.x = 0
    bc.y = 4

    advance.update(ctx)

    expect(cellOf(ctx, queen)).toEqual({ x: 0, y: 0 })
  })

  it('still captures when the killer held an attack order on the victim', () => {
    const ctx = context()
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 0, y: 0 })
    const victim = createPiece(ctx, 'red', PIECES.pawn, { x: 0, y: 4 })
    const order = ctx.world.require(queen, Order)
    order.kind = 'attack'
    order.target = victim
    kill(ctx, queen, victim)

    advance.update(ctx)
    settle(ctx)

    expect(cellOf(ctx, queen)).toEqual({ x: 0, y: 4 })
  })

  it('does not advance a piece that is busy with an order or hop', () => {
    const ctx = context()
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 0, y: 0 })
    const victim = createPiece(ctx, 'red', PIECES.pawn, { x: 0, y: 4 })
    const motion = ctx.world.require(queen, Motion)
    motion.path = [{ x: 1, y: 0 }]
    const order = ctx.world.require(queen, Order)
    order.kind = 'goto'
    kill(ctx, queen, victim)

    advance.update(ctx)

    expect(cellOf(ctx, queen)).toEqual({ x: 0, y: 0 })
  })

  it('lets a leaping knight capture over a blocker', () => {
    const ctx = context()
    const knight = createPiece(ctx, 'blue', PIECES.knight, { x: 0, y: 0 })
    const victim = createPiece(ctx, 'red', PIECES.pawn, { x: 1, y: 2 })
    createPiece(ctx, 'red', PIECES.pawn, { x: 0, y: 1 }) // does not block a leap
    kill(ctx, knight, victim)

    advance.update(ctx)
    settle(ctx)

    expect(cellOf(ctx, knight)).toEqual({ x: 1, y: 2 })
  })

  it('records the intent through damage/death/cleanup for a direct leaping kill', () => {
    const ctx = context()
    ctx.captureAdvance = true
    const knight = createPiece(ctx, 'blue', PIECES.knight, { x: 6, y: 3 }) // g5
    const pawn = createPiece(ctx, 'red', PIECES.pawn, { x: 5, y: 1 }) // f7
    ctx.world.require(knight, Stance).mode = 'attack'
    ctx.cmds.damage.push({ target: pawn, source: knight, amount: 999, kind: 'projectile', direct: true })

    damage.update(ctx)
    death.update(ctx)
    cleanup.update(ctx)
    advance.update(ctx)

    expect(cellOf(ctx, knight)).toEqual({ x: 6, y: 3 })
    expect(ctx.world.require(knight, Motion).moving).toBe(true)
    settle(ctx)
    expect(cellOf(ctx, knight)).toEqual({ x: 5, y: 1 })
  })

  it('never capture-advances a passive (none/move) killer', () => {
    const ctx = context()
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 0, y: 0 })
    const victim = createPiece(ctx, 'red', PIECES.pawn, { x: 0, y: 4 })
    // kill() defaults the killer to Attack; drop it back to a passive stance.
    const vcell = { ...ctx.world.require(victim, Cell) }
    ctx.world.destroy(victim)
    ctx.world.require(queen, Stance).mode = 'none'
    ctx.cmds.advance.push({ killer: queen, victim, cell: vcell })

    advance.update(ctx)

    expect(cellOf(ctx, queen)).toEqual({ x: 0, y: 0 })
  })

  it('ignores a killer that died in the same tick', () => {
    const ctx = context()
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 0, y: 0 })
    const victim = createPiece(ctx, 'red', PIECES.pawn, { x: 0, y: 4 })
    kill(ctx, queen, victim)
    ctx.world.destroy(queen)

    advance.update(ctx)

    expect(ctx.cmds.advance).toHaveLength(0)
  })
})
