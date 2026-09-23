import { beforeEach, describe, expect, it } from 'vitest'
import { Cell, Motion, Order, PieceType, Position, Team } from '../../src/ecs/components'
import { EventBus } from '../../src/ecs/events'
import type { SimContext, TeamRuntime } from '../../src/ecs/types'
import { World } from '../../src/ecs/world'
import { PATH_BUDGET_PER_TICK } from '../../src/game/constants'
import { createPiece } from '../../src/game/factory'
import { PIECES } from '../../src/game/pieces'
import { Rng } from '../../src/game/rng'
import advance from '../../src/ecs/systems/advance'
import cleanup from '../../src/ecs/systems/cleanup'
import damage from '../../src/ecs/systems/damage'
import death from '../../src/ecs/systems/death'
import { clearComponents, flatBoard } from '../helpers'

function runtime(): TeamRuntime {
  return {
    controller: 'human',
    cooldown: {},
    alive: {},
    kills: 0,
    losses: 0,
    supply: 0,
    deployed: 0,
    movesMade: 0,
    movesThisTurn: 0,
  }
}

function makeContext(): SimContext {
  return {
    world: new World(),
    bus: new EventBus(),
    board: flatBoard(8),
    rng: new Rng(1),
    tick: 0,
    turn: 0,
    dt: 1 / 30,
    cmds: { damage: [], deploy: [], destroy: [], advance: [] },
    teams: { red: runtime(), blue: runtime() },
    occupancy: new Map(),
    pathBudget: PATH_BUDGET_PER_TICK,
    verbosePhases: false,
    turnActive: false,
    autoPreserve: true,
    captureAdvance: true,
  }
}

describe('advance system — chess-style capture step', () => {
  beforeEach(() => clearComponents())

  /** Kill `victim` (remove it) and queue the killer-to-victim-cell intent. */
  function kill(ctx: SimContext, killer: number, victim: number): void {
    const vcell = { ...ctx.world.require(victim, Cell) }
    ctx.world.destroy(victim)
    ctx.cmds.advance.push({ killer, victim, cell: vcell })
  }

  function cellOf(ctx: SimContext, e: number): { x: number; y: number } {
    return { ...ctx.world.require(e, Cell) }
  }

  it('steps an idle killer onto the victim square it shot along', () => {
    const ctx = makeContext()
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 0, y: 0 })
    const victim = createPiece(ctx, 'red', PIECES.pawn, { x: 0, y: 4 })
    kill(ctx, queen, victim)

    advance.update(ctx)

    expect(cellOf(ctx, queen)).toEqual({ x: 0, y: 4 })
    const center = ctx.board.cellCenter(0, 4)
    expect(ctx.world.require(queen, Position)).toEqual(center)
  })

  it('does not advance when the firing line is blocked', () => {
    const ctx = makeContext()
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 0, y: 0 })
    const victim = createPiece(ctx, 'red', PIECES.pawn, { x: 0, y: 4 })
    createPiece(ctx, 'red', PIECES.pawn, { x: 0, y: 2 }) // stands between them
    kill(ctx, queen, victim)

    advance.update(ctx)

    expect(cellOf(ctx, queen)).toEqual({ x: 0, y: 0 })
  })

  it('leaves an occupied destination alone', () => {
    const ctx = makeContext()
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
    const ctx = makeContext()
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 0, y: 0 })
    const victim = createPiece(ctx, 'red', PIECES.pawn, { x: 0, y: 4 })
    const order = ctx.world.require(queen, Order)
    order.kind = 'attack'
    order.target = victim
    kill(ctx, queen, victim)

    advance.update(ctx)

    expect(cellOf(ctx, queen)).toEqual({ x: 0, y: 4 })
  })

  it('does not advance a piece that is busy with an order or hop', () => {
    const ctx = makeContext()
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
    const ctx = makeContext()
    const knight = createPiece(ctx, 'blue', PIECES.knight, { x: 0, y: 0 })
    const victim = createPiece(ctx, 'red', PIECES.pawn, { x: 1, y: 2 })
    createPiece(ctx, 'red', PIECES.pawn, { x: 0, y: 1 }) // does not block a leap
    kill(ctx, knight, victim)

    advance.update(ctx)

    expect(cellOf(ctx, knight)).toEqual({ x: 1, y: 2 })
  })

  it('records the intent through damage/death/cleanup for a direct leaping kill', () => {
    const ctx = makeContext()
    ctx.captureAdvance = true
    const knight = createPiece(ctx, 'blue', PIECES.knight, { x: 6, y: 3 }) // g5
    const pawn = createPiece(ctx, 'red', PIECES.pawn, { x: 5, y: 1 }) // f7
    ctx.cmds.damage.push({ target: pawn, source: knight, amount: 999, kind: 'projectile', direct: true })

    damage.update(ctx)
    death.update(ctx)
    cleanup.update(ctx)
    advance.update(ctx)

    expect(cellOf(ctx, knight)).toEqual({ x: 5, y: 1 })
  })

  it('ignores a killer that died in the same tick', () => {
    const ctx = makeContext()
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 0, y: 0 })
    const victim = createPiece(ctx, 'red', PIECES.pawn, { x: 0, y: 4 })
    kill(ctx, queen, victim)
    ctx.world.destroy(queen)

    advance.update(ctx)

    expect(ctx.cmds.advance).toHaveLength(0)
  })
})
