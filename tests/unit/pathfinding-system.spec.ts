import { beforeEach, describe, expect, it } from 'vitest'
import { Cell, Motion, Order } from '../../src/ecs/components'
import { EventBus } from '../../src/ecs/events'
import type { SimContext, TeamRuntime } from '../../src/ecs/types'
import { World } from '../../src/ecs/world'
import { buildOccupancy } from '../../src/game/occupancy'
import { createPiece } from '../../src/game/factory'
import { PATH_BUDGET_PER_TICK } from '../../src/game/constants'
import { PIECES } from '../../src/game/pieces'
import { Rng } from '../../src/game/rng'
import pathfinding from '../../src/ecs/systems/pathfinding'
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
    cmds: { damage: [], deploy: [], destroy: [] },
    teams: { red: runtime(), blue: runtime() },
    occupancy: new Map(),
    pathBudget: PATH_BUDGET_PER_TICK,
    verbosePhases: false,
    turnActive: false,
    autoPreserve: true,
  }
}

function run(ctx: SimContext): void {
  ctx.occupancy = buildOccupancy(ctx.world, ctx.board)
  pathfinding.update(ctx)
}

/** Queen at (0,0) ordered to fire on the red king at (4,0) from (3,0). */
function attackingQueen(blockers: Array<{ x: number; y: number }> = []): {
  ctx: SimContext
  queen: number
  king: number
} {
  const ctx = makeContext()
  const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 0, y: 0 })
  const king = createPiece(ctx, 'red', PIECES.king, { x: 4, y: 0 })
  for (const b of blockers) createPiece(ctx, 'blue', PIECES.pawn, b)

  const order = ctx.world.require(queen, Order)
  order.kind = 'attack'
  order.target = king
  order.dest = null
  ctx.world.require(queen, Motion).goal = { x: 3, y: 0 }
  return { ctx, queen, king }
}

describe('pathfinding system — adaptive attack routes', () => {
  beforeEach(() => clearComponents())

  it('routes around a friendly blocker using live occupancy', () => {
    const { ctx, queen } = attackingQueen([{ x: 1, y: 0 }])
    run(ctx)

    const motion = ctx.world.require(queen, Motion)
    expect(motion.path.length).toBeGreaterThan(0)
    expect(motion.path[0]).not.toEqual({ x: 1, y: 0 })
    expect(motion.path).not.toContainEqual({ x: 1, y: 0 })
    expect(motion.path[motion.path.length - 1]).toEqual({ x: 3, y: 0 })
    expect(motion.blocked).toBe(false)
  })

  it('recomputes a stale route that points through a now-blocked cell', () => {
    const { ctx, queen } = attackingQueen([{ x: 1, y: 0 }])
    const motion = ctx.world.require(queen, Motion)
    // The (stale) theoretical route planned when the order was issued.
    motion.path = [
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ]
    motion.blocked = true
    motion.replanAt = 0
    run(ctx)

    // The old route is not kept: it is re-derived against the live board.
    expect(motion.path).not.toContainEqual({ x: 1, y: 0 })
    expect(motion.path[motion.path.length - 1]).toEqual({ x: 3, y: 0 })
  })

  it('creeps along a best-effort partial route when the goal is not reachable', () => {
    // A wall of friendlies across x = 4 blocks the approach cell at (5,0).
    const wall = [0, 1, 2, 3, 4, 5, 6, 7].map((y) => ({ x: 4, y }))
    const { ctx, queen } = attackingQueen(wall)
    ctx.world.require(queen, Motion).goal = { x: 5, y: 0 }
    run(ctx)

    const motion = ctx.world.require(queen, Motion)
    // Best-effort partial: it still advances toward the goal...
    expect(motion.path.length).toBeGreaterThan(0)
    expect(motion.path[motion.path.length - 1]).toEqual({ x: 3, y: 0 })
    // ...but is flagged as (currently) blocked.
    expect(motion.blocked).toBe(true)
  })

  it('falls back to a fresh theoretical route when fully boxed in', () => {
    // A corner queen hemmed in by three friendlies cannot move at all.
    const { ctx, queen } = attackingQueen([
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ])
    ctx.world.require(queen, Motion).goal = { x: 5, y: 0 }
    run(ctx)

    const motion = ctx.world.require(queen, Motion)
    // No live move exists, so a fresh theoretical route is shown instead.
    expect(motion.path.length).toBeGreaterThan(0)
    expect(motion.path[motion.path.length - 1]).toEqual({ x: 5, y: 0 })
    expect(motion.blocked).toBe(true)
  })

  it('still plans a goto against live occupancy (queue waypoints unchanged)', () => {
    const { ctx, queen } = attackingQueen([{ x: 1, y: 0 }])
    const order = ctx.world.require(queen, Order)
    order.kind = 'goto'
    order.target = null
    order.dest = { x: 3, y: 0 }
    const motion = ctx.world.require(queen, Motion)
    motion.goal = { x: 3, y: 0 }
    motion.path = []
    motion.replanAt = 0
    run(ctx)

    // goto pathing uses live occupancy too, so the blocker is still avoided.
    expect(motion.path).not.toContainEqual({ x: 1, y: 0 })
    expect(motion.path[motion.path.length - 1]).toEqual({ x: 3, y: 0 })
  })
})
