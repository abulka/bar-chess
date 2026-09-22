import { beforeEach, describe, expect, it } from 'vitest'
import { Health, Motion, Order, Stance, Target } from '../../src/ecs/components'
import { EventBus } from '../../src/ecs/events'
import type { SimContext, TeamRuntime } from '../../src/ecs/types'
import { World } from '../../src/ecs/world'
import { buildOccupancy } from '../../src/game/occupancy'
import { createPiece } from '../../src/game/factory'
import { PATH_BUDGET_PER_TICK } from '../../src/game/constants'
import { PIECES } from '../../src/game/pieces'
import { Rng } from '../../src/game/rng'
import orders from '../../src/ecs/systems/orders'
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
  }
}

/** A low-HP blue queen in Attack stance whose target is the red knight. */
function lowHpQueen(knightCell: { x: number; y: number }): {
  ctx: SimContext
  queen: number
  knight: number
} {
  const ctx = makeContext()
  const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 3, y: 3 })
  const knight = createPiece(ctx, 'red', PIECES.knight, knightCell)
  ctx.world.require(queen, Stance).mode = 'attack'
  ctx.world.require(queen, Health).cur = 30
  ctx.world.require(queen, Target).entity = knight
  ctx.world.require(queen, Order).kind = 'none'
  return { ctx, queen, knight }
}

function run(ctx: SimContext): void {
  ctx.occupancy = buildOccupancy(ctx.world, ctx.board)
  orders.update(ctx)
}

describe('orders system — low-HP Attack stance', () => {
  beforeEach(() => clearComponents())

  it('holds and fires when the target is already in firing geometry', () => {
    const { ctx, queen } = lowHpQueen({ x: 4, y: 4 })
    run(ctx)
    expect(ctx.world.require(queen, Motion).goal).toBeNull()
  })

  it('retreats when the target is out of range', () => {
    const { ctx, queen } = lowHpQueen({ x: 0, y: 1 })
    run(ctx)
    const goal = ctx.world.require(queen, Motion).goal
    expect(goal).not.toBeNull()
    const before = Math.hypot(3 - 0, 3 - 1)
    const after = Math.hypot(goal!.x - 0, goal!.y - 1)
    expect(after).toBeGreaterThan(before)
  })
})
