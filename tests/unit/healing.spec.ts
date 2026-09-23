import { beforeEach, describe, expect, it } from 'vitest'
import { Health } from '../../src/ecs/components'
import { EventBus } from '../../src/ecs/events'
import type { SimContext, TeamRuntime } from '../../src/ecs/types'
import { World } from '../../src/ecs/world'
import { PATH_BUDGET_PER_TICK } from '../../src/game/constants'
import { createPiece } from '../../src/game/factory'
import { HEAL_RATE } from '../../src/game/healing'
import { PIECES } from '../../src/game/pieces'
import { Rng } from '../../src/game/rng'
import healing from '../../src/ecs/systems/healing'
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
    captureAdvance: false,
  }
}

/** One tick of healing, so a max-HP piece gains `max * HEAL_RATE * dt`. */
const perTick = (max: number, dt: number) => max * HEAL_RATE * dt

describe('healing system — king aura regeneration', () => {
  beforeEach(() => clearComponents())

  it('heals a damaged same-team piece within two squares of the king', () => {
    const ctx = makeContext()
    createPiece(ctx, 'blue', PIECES.king, { x: 4, y: 4 })
    const pawn = createPiece(ctx, 'blue', PIECES.pawn, { x: 6, y: 6 }) // Chebyshev 2
    const health = ctx.world.require(pawn, Health)
    health.cur = 10

    healing.update(ctx)

    expect(health.cur).toBeCloseTo(10 + perTick(health.max, ctx.dt), 6)
  })

  it('leaves a piece outside the radius untouched', () => {
    const ctx = makeContext()
    createPiece(ctx, 'blue', PIECES.king, { x: 4, y: 4 })
    const pawn = createPiece(ctx, 'blue', PIECES.pawn, { x: 7, y: 7 }) // Chebyshev 3
    const health = ctx.world.require(pawn, Health)
    health.cur = 10

    healing.update(ctx)

    expect(health.cur).toBe(10)
  })

  it('never heals the enemy team', () => {
    const ctx = makeContext()
    createPiece(ctx, 'blue', PIECES.king, { x: 4, y: 4 })
    const enemy = createPiece(ctx, 'red', PIECES.pawn, { x: 5, y: 5 })
    const health = ctx.world.require(enemy, Health)
    health.cur = 10

    healing.update(ctx)

    expect(health.cur).toBe(10)
  })

  it('heals the king itself', () => {
    const ctx = makeContext()
    const king = createPiece(ctx, 'blue', PIECES.king, { x: 4, y: 4 })
    const health = ctx.world.require(king, Health)
    health.cur = 100

    healing.update(ctx)

    expect(health.cur).toBeCloseTo(100 + perTick(health.max, ctx.dt), 6)
  })

  it('clamps healing at max health', () => {
    const ctx = makeContext()
    createPiece(ctx, 'blue', PIECES.king, { x: 4, y: 4 })
    const pawn = createPiece(ctx, 'blue', PIECES.pawn, { x: 5, y: 5 })
    const health = ctx.world.require(pawn, Health)
    health.cur = health.max - 0.001

    healing.update(ctx)

    expect(health.cur).toBe(health.max)
  })

  it('does not revive a piece at zero health', () => {
    const ctx = makeContext()
    createPiece(ctx, 'blue', PIECES.king, { x: 4, y: 4 })
    const pawn = createPiece(ctx, 'blue', PIECES.pawn, { x: 5, y: 5 })
    const health = ctx.world.require(pawn, Health)
    health.cur = 0

    healing.update(ctx)

    expect(health.cur).toBe(0)
  })

  it('does nothing for a king-less team', () => {
    const ctx = makeContext()
    const pawn = createPiece(ctx, 'blue', PIECES.pawn, { x: 5, y: 5 })
    ctx.world.require(pawn, Health).cur = 10

    expect(() => healing.update(ctx)).not.toThrow()
    expect(ctx.world.require(pawn, Health).cur).toBe(10)
  })
})
