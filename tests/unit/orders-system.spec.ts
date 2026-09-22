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

/**
 * A low-HP (30/165) blue piece in Attack stance, auto-targeting a red threat.
 * Ignores the normal HP/geometry of the attacker so the low-HP rule is hit.
 */
function lowHp(
  attackerKind: string,
  attackerCell: { x: number; y: number },
  threatKind: string,
  threatCell: { x: number; y: number },
) {
  const ctx = makeContext()
  const attacker = createPiece(ctx, 'blue', PIECES[attackerKind], attackerCell)
  const threat = createPiece(ctx, 'red', PIECES[threatKind], threatCell)
  ctx.world.require(attacker, Stance).mode = 'attack'
  ctx.world.require(attacker, Health).cur = 30
  ctx.world.require(attacker, Target).entity = threat
  ctx.world.require(attacker, Order).kind = 'none'
  return { ctx, attacker, threat }
}

function run(ctx: SimContext): void {
  ctx.occupancy = buildOccupancy(ctx.world, ctx.board)
  orders.update(ctx)
}

/** Rook-style coverage: an orthogonal line from `from` to `to`. */
function ortho(from: { x: number; y: number }, to: { x: number; y: number }): boolean {
  return from.x === to.x || from.y === to.y
}

describe('orders system — low-HP Attack stance', () => {
  beforeEach(() => clearComponents())

  it('holds and fires when the target is already in firing geometry', () => {
    const { ctx, attacker } = lowHp('queen', { x: 3, y: 3 }, 'knight', { x: 4, y: 4 })
    run(ctx)
    expect(ctx.world.require(attacker, Motion).goal).toBeNull()
  })

  it('retreats when the target is out of range', () => {
    const { ctx, attacker } = lowHp('queen', { x: 3, y: 3 }, 'knight', { x: 0, y: 1 })
    run(ctx)
    const goal = ctx.world.require(attacker, Motion).goal
    expect(goal).not.toBeNull()
    expect(Math.hypot(goal!.x - 0, goal!.y - 1)).toBeGreaterThan(Math.hypot(3 - 0, 3 - 1))
  })

  it('steps to the nearest cell that keeps the shot but escapes a rook threat', () => {
    // Red rook on the c-file can hit the queen on c4; a diagonal square cannot
    // be hit by the rook yet still fires back along a line.
    const { ctx, attacker } = lowHp('queen', { x: 3, y: 3 }, 'rook', { x: 3, y: 0 })
    run(ctx)

    const goal = ctx.world.require(attacker, Motion).goal
    expect(goal).not.toBeNull()
    // Escapes the rook's orthogonal lines...
    expect(ortho(goal!, { x: 3, y: 0 })).toBe(false)
    // ...while staying on a line that still fires at it.
    const aligned = goal!.x === 3 || goal!.y === 0 || Math.abs(goal!.x - 3) === Math.abs(goal!.y - 0)
    expect(aligned).toBe(true)
    // Nearest safe firing squares on this board.
    expect([
      { x: 0, y: 3 },
      { x: 6, y: 3 },
    ]).toContainEqual(goal)
  })

  it('holds when no safer firing cell exists (symmetric rook duel)', () => {
    const { ctx, attacker } = lowHp('rook', { x: 3, y: 3 }, 'rook', { x: 3, y: 0 })
    run(ctx)
    expect(ctx.world.require(attacker, Motion).goal).toBeNull()
  })
})
