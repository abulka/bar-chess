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
    autoPreserve: true,
  }
}

function run(ctx: SimContext): void {
  ctx.occupancy = buildOccupancy(ctx.world, ctx.board)
  orders.update(ctx)
}

describe('orders system — low-HP retreat (auto-preserve off)', () => {
  beforeEach(() => clearComponents())

  /** A flat board with back ranks so `retreatHome` has a target. */
  function context(): SimContext {
    const ctx = makeContext()
    ctx.autoPreserve = false
    ctx.board.data.lanes.red = [{ x: 3, y: 0 }]
    ctx.board.data.lanes.blue = [{ x: 3, y: 7 }]
    return ctx
  }

  it('escapes the shooter covering it, not just the target', () => {
    const ctx = context()
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 3, y: 3 })
    const rook = createPiece(ctx, 'red', PIECES.rook, { x: 3, y: 0 }) // c-file
    ctx.world.require(queen, Stance).mode = 'attack'
    ctx.world.require(queen, Health).cur = 20
    ctx.world.require(queen, Target).entity = rook

    run(ctx)

    const goal = ctx.world.require(queen, Motion).goal
    expect(goal).not.toBeNull()
    // Steps off the file the rook covers.
    expect(goal!.x).not.toBe(3)
  })

  it('seeks nearby cover instead of charging or fleeing home (h5 regression)', () => {
    const ctx = context()
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 7, y: 4 }) // h5
    const bishop = createPiece(ctx, 'red', PIECES.bishop, { x: 2, y: 3 }) // far, not shooting
    createPiece(ctx, 'red', PIECES.king, { x: 7, y: 6 }) // near, but cannot reach the queen
    ctx.world.require(queen, Stance).mode = 'attack'
    ctx.world.require(queen, Health).cur = Math.floor(PIECES.queen.hp * 0.33)
    ctx.world.require(queen, Target).entity = bishop

    run(ctx)

    const goal = ctx.world.require(queen, Motion).goal
    expect(goal).not.toBeNull()
    // Never the old h6 blunder; it backs away from the nearby king.
    expect(goal).not.toEqual({ x: 7, y: 5 })
    const before = Math.hypot(7 - 7, 4 - 6)
    expect(Math.hypot(goal!.x - 7, goal!.y - 6)).toBeGreaterThan(before)
  })

  it('does not step into a nearby enemy\'s firing line', () => {
    const ctx = context()
    const pawn = createPiece(ctx, 'blue', PIECES.pawn, { x: 4, y: 4 })
    // The knight cannot hit the pawn where it stands, but it does cover the
    // pawn's only forward square (4,3).
    const knight = createPiece(ctx, 'red', PIECES.knight, { x: 6, y: 4 })
    ctx.world.require(pawn, Stance).mode = 'attack'
    ctx.world.require(pawn, Health).cur = 10
    ctx.world.require(pawn, Target).entity = knight

    run(ctx)

    expect(ctx.world.require(pawn, Motion).goal).toBeNull()
  })

  it('holds when hurt with no enemy nearby', () => {
    const ctx = context()
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 7, y: 0 })
    const knight = createPiece(ctx, 'red', PIECES.knight, { x: 0, y: 7 }) // far, short reach
    ctx.world.require(queen, Stance).mode = 'attack'
    ctx.world.require(queen, Health).cur = Math.floor(PIECES.queen.hp * 0.33)
    ctx.world.require(queen, Target).entity = knight

    run(ctx)

    expect(ctx.world.require(queen, Motion).goal).toBeNull()
  })

  it('steps out of an actual shooter\'s line when one is present', () => {
    const ctx = context()
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 7, y: 4 }) // h5
    createPiece(ctx, 'red', PIECES.rook, { x: 7, y: 0 }) // h-file, covers h5
    const bishop = createPiece(ctx, 'red', PIECES.bishop, { x: 2, y: 3 })
    ctx.world.require(queen, Stance).mode = 'attack'
    ctx.world.require(queen, Health).cur = Math.floor(PIECES.queen.hp * 0.33)
    ctx.world.require(queen, Target).entity = bishop

    run(ctx)

    const goal = ctx.world.require(queen, Motion).goal
    expect(goal).not.toBeNull()
    expect(goal!.x).not.toBe(7) // steps off the rook's file
  })
})

describe('orders system — AI king defense', () => {
  beforeEach(() => clearComponents())

  /** An AI-controlled red team on a flat board with a blue rally lane defined. */
  function defenseContext(): SimContext {
    const ctx = makeContext()
    ctx.teams.red.controller = 'ai'
    ctx.board.data.lanes.blue = [{ x: 4, y: 7 }]
    return ctx
  }

  it('steps the king off a distant shooter\'s firing line', () => {
    const ctx = defenseContext()
    const king = createPiece(ctx, 'red', PIECES.king, { x: 4, y: 4 })
    createPiece(ctx, 'blue', PIECES.rook, { x: 4, y: 0 }) // clear file, 4 cells away

    run(ctx)

    const goal = ctx.world.require(king, Motion).goal
    expect(goal).not.toBeNull()
    expect(goal!.x).not.toBe(4)
  })

  it('reacts to a last attacker even without a current line', () => {
    const ctx = defenseContext()
    const king = createPiece(ctx, 'red', PIECES.king, { x: 4, y: 4 })
    const rook = createPiece(ctx, 'blue', PIECES.rook, { x: 4, y: 0 })
    createPiece(ctx, 'red', PIECES.pawn, { x: 4, y: 2 }) // screens the king
    const target = ctx.world.require(king, Target)
    target.lastAttacker = rook
    target.underFireUntil = ctx.tick + 90

    run(ctx)

    const goal = ctx.world.require(king, Motion).goal
    expect(goal).not.toBeNull()
    expect(Math.hypot(goal!.x - 4, goal!.y - 0)).toBeGreaterThan(4)
  })

  it('sends a nearby piece to intercept the king\'s attacker', () => {
    const ctx = defenseContext()
    createPiece(ctx, 'red', PIECES.king, { x: 4, y: 0 })
    const rook = createPiece(ctx, 'blue', PIECES.rook, { x: 4, y: 4 })
    // The guard cannot reach the firing line in one step, so it engages instead.
    const guard = createPiece(ctx, 'red', PIECES.rook, { x: 0, y: 0 })
    const far = createPiece(ctx, 'red', PIECES.rook, { x: 7, y: 6 })

    run(ctx)

    expect(ctx.world.require(guard, Motion).goal).not.toBeNull()
    expect(ctx.world.require(guard, Target).entity).toBe(rook)
    // The distant piece keeps advancing on the rally lane, not defending.
    expect(ctx.world.require(far, Motion).goal).toEqual({ x: 4, y: 7 })
  })

  it('steps a guard onto the king\'s firing line to block the shot', () => {
    const ctx = defenseContext()
    createPiece(ctx, 'red', PIECES.king, { x: 4, y: 0 })
    createPiece(ctx, 'blue', PIECES.rook, { x: 4, y: 4 }) // covers the c-file
    const guard = createPiece(ctx, 'red', PIECES.knight, { x: 3, y: 3 })

    run(ctx)

    // The knight can reach (4,1), a square between the rook and the king.
    expect(ctx.world.require(guard, Motion).goal).toEqual({ x: 4, y: 1 })
  })

  it('keeps a guard planted once it is blocking the shot', () => {
    const ctx = defenseContext()
    createPiece(ctx, 'red', PIECES.king, { x: 4, y: 0 })
    createPiece(ctx, 'blue', PIECES.rook, { x: 4, y: 4 })
    const guard = createPiece(ctx, 'red', PIECES.rook, { x: 4, y: 1 }) // on the line

    run(ctx)

    expect(ctx.world.require(guard, Motion).goal).toBeNull()
  })
})

describe('orders system — automatic self-preservation', () => {
  beforeEach(() => clearComponents())

  function hurtContext(autoPreserve: boolean): SimContext {
    const ctx = makeContext()
    ctx.autoPreserve = autoPreserve
    return ctx
  }

  function fireOn(ctx: SimContext, piece: number, attacker: number): void {
    const target = ctx.world.require(piece, Target)
    target.lastAttacker = attacker
    target.underFireUntil = ctx.tick + 90
  }

  it('makes an idle piece under fire back off on its own', () => {
    const ctx = hurtContext(true)
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 4, y: 4 })
    const rook = createPiece(ctx, 'red', PIECES.rook, { x: 4, y: 0 })
    ctx.world.require(queen, Health).cur = Math.floor(PIECES.queen.hp * 0.45)
    fireOn(ctx, queen, rook)

    run(ctx)

    expect(ctx.world.require(queen, Motion).goal).not.toBeNull()
  })

  it('does nothing when auto-preserve is switched off', () => {
    const ctx = hurtContext(false)
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 4, y: 4 })
    const rook = createPiece(ctx, 'red', PIECES.rook, { x: 4, y: 0 })
    ctx.world.require(queen, Health).cur = Math.floor(PIECES.queen.hp * 0.45)
    fireOn(ctx, queen, rook)

    run(ctx)

    expect(ctx.world.require(queen, Motion).goal).toBeNull()
  })

  it('lets cheap pieces hold where expensive ones bail', () => {
    const ctx = hurtContext(true)
    const pawn = createPiece(ctx, 'blue', PIECES.pawn, { x: 4, y: 4 })
    const rook = createPiece(ctx, 'red', PIECES.rook, { x: 4, y: 0 })
    // Hurt but not outgunned (20 < 35) and above the pawn threshold.
    ctx.world.require(pawn, Health).cur = 35
    fireOn(ctx, pawn, rook)

    run(ctx)

    expect(ctx.world.require(pawn, Motion).goal).toBeNull()
  })

  it('lets a cheap piece flee when a single shooter would kill it', () => {
    const ctx = hurtContext(true)
    const pawn = createPiece(ctx, 'blue', PIECES.pawn, { x: 4, y: 4 })
    // Rook covers the rank; the pawn can step off it, but 15 HP vs 20 damage
    // means it is outgunned, though still above its 30% HP threshold.
    const rook = createPiece(ctx, 'red', PIECES.rook, { x: 0, y: 4 })
    ctx.world.require(pawn, Health).cur = 15
    fireOn(ctx, pawn, rook)

    run(ctx)

    expect(ctx.world.require(pawn, Motion).goal).not.toBeNull()
  })

  it('pulls a valuable piece out of a two-shooter crossfire before it is hit', () => {
    const ctx = hurtContext(true)
    const knight = createPiece(ctx, 'blue', PIECES.knight, { x: 3, y: 6 }) // d7
    createPiece(ctx, 'red', PIECES.queen, { x: 2, y: 6 }) // c7: covers the rank
    createPiece(ctx, 'red', PIECES.knight, { x: 5, y: 5 }) // f6: knight-hits d7
    const king = createPiece(ctx, 'red', PIECES.king, { x: 1, y: 6 })
    // Above the knight's 40% bail threshold and not yet hit.
    ctx.world.require(knight, Health).cur = Math.floor(PIECES.knight.hp * 0.45)
    const order = ctx.world.require(knight, Order)
    order.kind = 'attack'
    order.target = king

    run(ctx)

    const goal = ctx.world.require(knight, Motion).goal
    expect(goal).not.toBeNull()
    // Off the queen's rank and out of the enemy knight's leap pattern.
    expect(goal!.y).not.toBe(6)
    const kdx = Math.abs(goal!.x - 5)
    const kdy = Math.abs(goal!.y - 5)
    expect((kdx === 1 && kdy === 2) || (kdx === 2 && kdy === 1)).toBe(false)
  })

  it('backs a valuable piece off when focused by two shooters, above the HP gate', () => {
    const ctx = hurtContext(true)
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 4, y: 4 })
    const rook = createPiece(ctx, 'red', PIECES.rook, { x: 4, y: 0 }) // c-file
    createPiece(ctx, 'red', PIECES.bishop, { x: 1, y: 1 }) // a1-h8 diagonal
    ctx.world.require(queen, Health).cur = Math.floor(PIECES.queen.hp * 0.58)
    fireOn(ctx, queen, rook)

    run(ctx)

    const goal = ctx.world.require(queen, Motion).goal
    expect(goal).not.toBeNull()
    // Escapes both shooters: off the rook's file and off the bishop's diagonal.
    expect(goal!.x).not.toBe(4)
    expect(goal!.x).not.toBe(goal!.y)
  })

  it('overrides an explicit attack order when badly hurt', () => {
    const ctx = hurtContext(true)
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 4, y: 4 })
    const knight = createPiece(ctx, 'red', PIECES.knight, { x: 5, y: 6 })
    ctx.world.require(queen, Health).cur = Math.floor(PIECES.queen.hp * 0.45)
    const order = ctx.world.require(queen, Order)
    order.kind = 'attack'
    order.target = knight
    fireOn(ctx, queen, knight)

    run(ctx)

    const goal = ctx.world.require(queen, Motion).goal
    expect(goal).not.toBeNull()
    // It retreats from the attacker rather than charging it.
    const before = Math.hypot(4 - 5, 4 - 6)
    expect(Math.hypot(goal!.x - 5, goal!.y - 6)).toBeGreaterThan(before)
  })
})

describe('orders system — attack orders', () => {
  beforeEach(() => clearComponents())

  it('holds instead of chasing a positionally unreachable target', () => {
    const ctx = makeContext()
    const bishop = createPiece(ctx, 'blue', PIECES.bishop, { x: 5, y: 3 }) // f5 (light)
    const king = createPiece(ctx, 'red', PIECES.king, { x: 3, y: 0 }) // d8 (dark)
    const order = ctx.world.require(bishop, Order)
    order.kind = 'attack'
    order.target = king
    order.reachable = false

    run(ctx)

    // Would otherwise route to the nearest reachable square — deep in enemy lines.
    expect(ctx.world.require(bishop, Motion).goal).toBeNull()
  })

  it('still pursues a reachable attack target', () => {
    const ctx = makeContext()
    const bishop = createPiece(ctx, 'blue', PIECES.bishop, { x: 5, y: 3 })
    const queen = createPiece(ctx, 'red', PIECES.queen, { x: 1, y: 5 })
    const order = ctx.world.require(bishop, Order)
    order.kind = 'attack'
    order.target = queen
    order.reachable = true

    run(ctx)

    expect(ctx.world.require(bishop, Motion).goal).not.toBeNull()
  })
})
