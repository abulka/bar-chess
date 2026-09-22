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
  // These exercise the Attack-stance fallback, not the auto-preserve pass.
  ctx.autoPreserve = false
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
