import { beforeEach, describe, expect, it } from 'vitest'
import { Health, Motion, Order, Stance, Target } from '../../src/ecs/components'
import type { SimContext } from '../../src/ecs/types'
import { buildOccupancy } from '../../src/game/occupancy'
import { createPiece } from '../../src/game/factory'
import { PIECES } from '../../src/game/pieces'
import orders from '../../src/ecs/systems/orders'
import { clearComponents, makeContext } from '../helpers'

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

  it("steps the king off a distant shooter's firing line", () => {
    const ctx = defenseContext()
    const king = createPiece(ctx, 'red', PIECES.king, { x: 4, y: 4 })
    createPiece(ctx, 'red', PIECES.pawn, { x: 0, y: 0 }) // a field piece, so not a lone king
    createPiece(ctx, 'blue', PIECES.rook, { x: 4, y: 0 }) // clear file, 4 cells away

    run(ctx)

    const goal = ctx.world.require(king, Motion).goal
    expect(goal).not.toBeNull()
    expect(goal!.x).not.toBe(4)
  })

  it('holds its post once it is the last piece', () => {
    const ctx = defenseContext()
    const king = createPiece(ctx, 'red', PIECES.king, { x: 4, y: 7 })
    createPiece(ctx, 'blue', PIECES.rook, { x: 4, y: 0 }) // covers the file

    run(ctx)

    // No field pieces left, so the king stops kiting and stands; dodging
    // forever was turning material wins into turn-cap draws.
    expect(ctx.world.require(king, Motion).goal).toBeNull()
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

  it('records one retreat entry per preserve episode, not per goal change', () => {
    const ctx = hurtContext(true)
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 4, y: 4 })
    const rook = createPiece(ctx, 'red', PIECES.rook, { x: 4, y: 0 }) // covers the c-file
    ctx.world.require(queen, Health).cur = Math.floor(PIECES.queen.hp * 0.45)
    fireOn(ctx, queen, rook)

    run(ctx)
    const order = ctx.world.require(queen, Order)
    expect(order.log).toHaveLength(1)
    expect(order.log[0].text).toMatch(/^self-preservation: retreating → /)
    const firstGoal = ctx.world.require(queen, Motion).goal

    // Add a second shooter covering the previous escape square: still preserving,
    // but the least-exposed escape square changes. That re-evaluation must not
    // add a second entry.
    createPiece(ctx, 'red', PIECES.rook, { x: 7, y: 0 })
    run(ctx)

    const motion = ctx.world.require(queen, Motion)
    expect(motion.intent).toBe('preserve')
    expect(motion.goal).not.toEqual(firstGoal)
    expect(order.log).toHaveLength(1)
  })

  it('logs when a latched piece is safe again', () => {
    const ctx = hurtContext(true)
    const bishop = createPiece(ctx, 'blue', PIECES.bishop, { x: 4, y: 4 })
    const rook = createPiece(ctx, 'red', PIECES.rook, { x: 4, y: 0 })
    ctx.world.require(bishop, Health).cur = 10 // below CRITICAL_WOUND: latches a hold
    fireOn(ctx, bishop, rook)

    run(ctx)
    const order = ctx.world.require(bishop, Order)
    expect(order.log.some((n) => n.text.startsWith('self-preservation: retreating'))).toBe(true)

    // Threat gone and the fire window elapsed: it reports safe and holds.
    ctx.world.destroy(rook)
    ctx.tick = 1000
    run(ctx)

    expect(order.log[order.log.length - 1].text).toBe('self-preservation: safe — holding')
  })

  it('closes the episode when the preserve gate stops acting (the stale-entry bug)', () => {
    const ctx = hurtContext(true)
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 4, y: 4 })
    const rook = createPiece(ctx, 'red', PIECES.rook, { x: 4, y: 0 }) // covers the c-file
    const bishop = createPiece(ctx, 'red', PIECES.bishop, { x: 1, y: 1 }) // a1-h8 diagonal through e4
    ctx.world.require(queen, Health).cur = Math.floor(PIECES.queen.hp * 0.58) // above the 0.5 gate
    const order = ctx.world.require(queen, Order)

    run(ctx)
    expect(ctx.world.require(queen, Motion).intent).toBe('preserve')
    expect(order.log[order.log.length - 1].text).toMatch(/^self-preservation: retreating → /)

    // Drop one shooter: only one cover left, still above the HP gate, so the
    // preserve gate falls through and stops acting. The episode must be closed
    // out instead of leaving the last retreat as the newest entry.
    ctx.world.destroy(bishop)
    run(ctx)

    expect(ctx.world.require(queen, Motion).intent).not.toBe('preserve')
    expect(order.log[order.log.length - 1].text).toBe('self-preservation: no longer needed — holding')
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

  it('lets a non-pawn flee when a single shooter would kill it', () => {
    const ctx = hurtContext(true)
    const bishop = createPiece(ctx, 'blue', PIECES.bishop, { x: 4, y: 4 })
    // Rook covers the rank; the bishop can step off it, and 15 HP vs 20 damage
    // means it is outgunned.
    const rook = createPiece(ctx, 'red', PIECES.rook, { x: 0, y: 4 })
    ctx.world.require(bishop, Health).cur = 15
    fireOn(ctx, bishop, rook)

    run(ctx)

    expect(ctx.world.require(bishop, Motion).goal).not.toBeNull()
  })

  it('never flees a pawn, even outgunned: it holds instead', () => {
    const ctx = hurtContext(true)
    const pawn = createPiece(ctx, 'blue', PIECES.pawn, { x: 4, y: 4 })
    const rook = createPiece(ctx, 'red', PIECES.rook, { x: 0, y: 4 })
    ctx.world.require(pawn, Health).cur = 15
    fireOn(ctx, pawn, rook)

    run(ctx)

    expect(ctx.world.require(pawn, Motion).goal).toBeNull()
  })

  it('keeps a hurt pawn firing at an in-range ordered target instead of fleeing', () => {
    const ctx = hurtContext(true)
    const pawn = createPiece(ctx, 'blue', PIECES.pawn, { x: 3, y: 3 }) // d5
    const knight = createPiece(ctx, 'red', PIECES.knight, { x: 2, y: 2 }) // c6, diagonal
    createPiece(ctx, 'red', PIECES.rook, { x: 1, y: 3 }) // b5, covers d5 on rank 5
    createPiece(ctx, 'red', PIECES.queen, { x: 3, y: 7 }) // d8, covers the d-file
    ctx.world.require(pawn, Health).cur = 5
    const order = ctx.world.require(pawn, Order)
    order.kind = 'attack'
    order.target = knight
    order.reachable = true
    fireOn(ctx, pawn, knight)

    run(ctx)

    expect(ctx.world.require(pawn, Motion).goal).toBeNull()
  })

  it('pulls a valuable piece out of a two-shooter crossfire before it is hit', () => {
    const ctx = hurtContext(true)
    const knight = createPiece(ctx, 'blue', PIECES.knight, { x: 3, y: 6 }) // d7
    createPiece(ctx, 'red', PIECES.queen, { x: 2, y: 6 }) // c7: covers the rank
    createPiece(ctx, 'red', PIECES.knight, { x: 5, y: 5 }) // f6: knight-hits d7
    // Above the knight's 40% bail threshold, not yet hit, and no explicit order,
    // so only the automatic pre-emptive bail can move it.
    ctx.world.require(knight, Health).cur = Math.floor(PIECES.knight.hp * 0.45)

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

  it('overrides a standing attack order when badly hurt', () => {
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

  it('disengages an attack order when focused by several shooters (c6 knight)', () => {
    const ctx = makeContext()
    const knight = createPiece(ctx, 'blue', PIECES.knight, { x: 2, y: 2 }) // c6
    const queen = createPiece(ctx, 'red', PIECES.queen, { x: 3, y: 0 }) // d8
    createPiece(ctx, 'red', PIECES.rook, { x: 5, y: 2 }) // f6, covers the rank
    createPiece(ctx, 'red', PIECES.bishop, { x: 3, y: 3 }) // d5, diagonal to c6
    createPiece(ctx, 'red', PIECES.pawn, { x: 3, y: 1 }) // d7, fires on c6
    const order = ctx.world.require(knight, Order)
    order.kind = 'attack'
    order.target = queen
    order.reachable = true

    run(ctx)

    // Three shooters cover c6, so it breaks off instead of charging the queen.
    const motion = ctx.world.require(knight, Motion)
    expect(motion.intent).toBe('preserve')
    expect(motion.goal).not.toBeNull()
  })

  it('retreats a moving piece while in danger, then resumes the move when safe', () => {
    const ctx = hurtContext(true)
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 4, y: 4 })
    const rook = createPiece(ctx, 'red', PIECES.rook, { x: 4, y: 0 })
    ctx.world.require(queen, Health).cur = Math.floor(PIECES.queen.hp * 0.45)
    const order = ctx.world.require(queen, Order)
    order.kind = 'goto'
    order.dest = { x: 7, y: 4 }
    fireOn(ctx, queen, rook)

    run(ctx)
    // Danger present: it dodges instead of walking the route. With no king aura
    // anywhere it does not latch a recovery hold (it could never heal it off).
    expect(ctx.world.require(queen, Motion).intent).toBe('preserve')
    expect(ctx.world.require(queen, Motion).holdUntilHp).toBe(0)
    expect(ctx.world.require(queen, Motion).goal).not.toEqual({ x: 7, y: 4 })

    // Danger gone (medium wound, no full-heal hold): it resumes the move.
    ctx.world.destroy(rook)
    run(ctx)
    expect(ctx.world.require(queen, Motion).goal).toEqual({ x: 7, y: 4 })
  })

  it('holds a badly wounded mover until fully healed, then resumes the move', () => {
    const ctx = hurtContext(true)
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 4, y: 4 })
    const rook = createPiece(ctx, 'red', PIECES.rook, { x: 4, y: 0 })
    const hp = ctx.world.require(queen, Health)
    hp.cur = Math.floor(hp.max * 0.15) // below the critical-wound line
    const order = ctx.world.require(queen, Order)
    order.kind = 'goto'
    order.dest = { x: 7, y: 4 }
    fireOn(ctx, queen, rook)

    run(ctx)
    // It latches a safe-hold and retreats.
    expect(ctx.world.require(queen, Motion).holdUntilHp).toBe(hp.max)
    expect(ctx.world.require(queen, Motion).intent).toBe('preserve')

    // Danger gone but still wounded: it holds, it does not resume.
    ctx.world.destroy(rook)
    run(ctx)
    expect(ctx.world.require(queen, Motion).goal).toBeNull()

    // Fully healed: the hold releases and the move resumes.
    hp.cur = hp.max
    run(ctx)
    expect(ctx.world.require(queen, Motion).goal).toEqual({ x: 7, y: 4 })
  })

  it('holds a badly wounded attacker until fully healed, then resumes the attack', () => {
    const ctx = hurtContext(true)
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 4, y: 4 })
    // Target out of the queen's lines so it cannot itself keep her in danger.
    const knight = createPiece(ctx, 'red', PIECES.knight, { x: 1, y: 0 })
    const rook = createPiece(ctx, 'red', PIECES.rook, { x: 4, y: 0 })
    const hp = ctx.world.require(queen, Health)
    hp.cur = Math.floor(hp.max * 0.15)
    const order = ctx.world.require(queen, Order)
    order.kind = 'attack'
    order.target = knight
    fireOn(ctx, queen, rook)

    run(ctx)
    expect(ctx.world.require(queen, Motion).intent).toBe('preserve')

    // Still wounded after the danger clears: the attack does not auto-resume.
    ctx.world.destroy(rook)
    run(ctx)
    expect(ctx.world.require(queen, Motion).goal).toBeNull()

    // Fully healed: it resumes pursuing the ordered target.
    hp.cur = hp.max
    run(ctx)
    expect(ctx.world.require(queen, Motion).goal).not.toBeNull()
  })

  it('presses an insta-kill even when badly wounded (suicide kill allowed)', () => {
    const ctx = hurtContext(true)
    const bishop = createPiece(ctx, 'blue', PIECES.bishop, { x: 4, y: 4 })
    const pawn = createPiece(ctx, 'red', PIECES.pawn, { x: 5, y: 5 })
    const rook = createPiece(ctx, 'red', PIECES.rook, { x: 4, y: 0 })
    const hp = ctx.world.require(bishop, Health)
    hp.cur = Math.floor(hp.max * 0.1) // below CRITICAL_WOUND
    const order = ctx.world.require(bishop, Order)
    order.kind = 'attack'
    order.target = pawn
    order.chessKill = pawn
    fireOn(ctx, bishop, rook)

    run(ctx)

    // The insta-kill outranks self-preservation: no retreat, no safe-hold, and
    // the lethal damage is queued in the same pass.
    const motion = ctx.world.require(bishop, Motion)
    expect(motion.intent).not.toBe('preserve')
    expect(motion.holdUntilHp).toBe(0)
    expect(order.chessKill).toBeNull()
    expect(ctx.cmds.damage.some((d) => d.target === pawn && d.lethal)).toBe(true)
  })

  /** A context with a blue king on e1 so a healing goal can be computed. */
  function auraContext(): SimContext {
    const ctx = makeContext()
    createPiece(ctx, 'blue', PIECES.king, { x: 4, y: 7 }) // e1
    return ctx
  }

  /** A latched, badly wounded blue rook parked on a3 (far outside the aura). */
  function latchedRook(ctx: SimContext) {
    const rook = createPiece(ctx, 'blue', PIECES.rook, { x: 0, y: 5 }) // a3
    const hp = ctx.world.require(rook, Health)
    hp.cur = 8
    const motion = ctx.world.require(rook, Motion)
    motion.holdUntilHp = hp.max
    return { rook, motion, hp }
  }

  it('routes a latched piece outside the aura toward the king to heal', () => {
    const ctx = auraContext()
    const { motion } = latchedRook(ctx)

    run(ctx)

    expect(motion.intent).toBe('preserve')
    expect(motion.goal).not.toBeNull()
    // The goal sits inside the king's aura (Chebyshev <= 2 of e1).
    expect(Math.max(Math.abs(motion.goal!.x - 4), Math.abs(motion.goal!.y - 7))).toBeLessThanOrEqual(2)
  })

  it("honours a latched piece's explicit move order into the aura", () => {
    const ctx = auraContext()
    const { rook, motion } = latchedRook(ctx)
    const order = ctx.world.require(rook, Order)
    order.kind = 'goto'
    order.dest = { x: 3, y: 7 } // d1, adjacent to the king

    run(ctx)

    expect(motion.goal).toEqual({ x: 3, y: 7 })
    expect(motion.intent).toBe('order')
  })

  it("redirects a latched piece's non-aura move order toward the king", () => {
    const ctx = auraContext()
    const { rook, motion } = latchedRook(ctx)
    const order = ctx.world.require(rook, Order)
    order.kind = 'goto'
    order.dest = { x: 7, y: 7 } // h1, far outside the aura

    run(ctx)

    expect(motion.intent).toBe('preserve')
    expect(motion.goal).not.toEqual({ x: 7, y: 7 })
    expect(Math.max(Math.abs(motion.goal!.x - 4), Math.abs(motion.goal!.y - 7))).toBeLessThanOrEqual(2)
  })

  it('holds a latched piece that is already inside the aura', () => {
    const ctx = auraContext()
    const rook = createPiece(ctx, 'blue', PIECES.rook, { x: 4, y: 6 }) // e2, inside the aura
    const hp = ctx.world.require(rook, Health)
    hp.cur = 8
    const motion = ctx.world.require(rook, Motion)
    motion.holdUntilHp = hp.max

    run(ctx)

    expect(motion.goal).toBeNull()
    expect(motion.intent).toBe('none')
  })

  it('sends a wounded, boxed-in piece home to heal when no step is safer', () => {
    const ctx = auraContext()
    const knight = createPiece(ctx, 'blue', PIECES.knight, { x: 2, y: 1 }) // c7
    const rook = createPiece(ctx, 'red', PIECES.rook, { x: 1, y: 0 }) // b8 (adjacent)
    createPiece(ctx, 'red', PIECES.bishop, { x: 2, y: 0 }) // c8 (adjacent)
    createPiece(ctx, 'red', PIECES.queen, { x: 3, y: 4 }) // d4, covers d5
    createPiece(ctx, 'red', PIECES.king, { x: 4, y: 0 }) // e8, occupies the last open hop
    const hp = ctx.world.require(knight, Health)
    hp.cur = 22 // wounded (23%), but above the critical latch
    const target = ctx.world.require(knight, Target)
    target.lastAttacker = rook
    target.underFireUntil = ctx.tick + 90

    run(ctx)

    const motion = ctx.world.require(knight, Motion)
    // Every knight step is covered, so it does not stand in the fire: it heads
    // for the king's aura to heal, latching a recovery hold (60% of 95) so it
    // does not walk straight back out the moment it crosses its retreat trigger.
    expect(motion.intent).toBe('preserve')
    expect(motion.goal).not.toBeNull()
    expect(Math.max(Math.abs(motion.goal!.x - 4), Math.abs(motion.goal!.y - 7))).toBeLessThanOrEqual(2)
    expect(motion.holdUntilHp).toBeCloseTo(57, 6)
  })

  it('holds in the aura until recovered, then resumes the order', () => {
    const ctx = auraContext()
    const rook = createPiece(ctx, 'blue', PIECES.rook, { x: 4, y: 6 }) // e2, inside the aura
    const hp = ctx.world.require(rook, Health)
    hp.cur = 60 // 43%, wounded but above the critical latch
    const order = ctx.world.require(rook, Order)
    order.kind = 'goto'
    order.dest = { x: 7, y: 7 } // h1, far outside the aura

    run(ctx)
    const motion = ctx.world.require(rook, Motion)
    // Already in the aura: it holds and latches recovery at 65% of 140.
    expect(motion.goal).toBeNull()
    expect(motion.holdUntilHp).toBeCloseTo(91, 6)

    // Above the retreat trigger but below the recovery latch: still holding.
    hp.cur = 80
    run(ctx)
    expect(motion.holdUntilHp).toBeCloseTo(91, 6)
    expect(motion.goal).toBeNull()

    // Recovered to the latch: the hold releases and the move resumes.
    hp.cur = 91
    run(ctx)
    expect(motion.holdUntilHp).toBe(0)
    expect(motion.goal).toEqual({ x: 7, y: 7 })
  })

  it('sends a wounded piece home to heal instead of a one-step dodge', () => {
    const ctx = auraContext()
    const rook = createPiece(ctx, 'blue', PIECES.rook, { x: 0, y: 0 }) // a8, far outside the aura
    const shooter = createPiece(ctx, 'red', PIECES.rook, { x: 0, y: 4 }) // a4, covers the file
    const hp = ctx.world.require(rook, Health)
    hp.cur = 40 // wounded, but above the critical latch
    const target = ctx.world.require(rook, Target)
    target.lastAttacker = shooter
    target.underFireUntil = ctx.tick + 90

    run(ctx)

    const motion = ctx.world.require(rook, Motion)
    expect(motion.intent).toBe('preserve')
    expect(motion.goal).not.toBeNull()
    // The goal is inside the king's aura, not merely local cover beside a8.
    expect(Math.max(Math.abs(motion.goal!.x - 4), Math.abs(motion.goal!.y - 7))).toBeLessThanOrEqual(2)
  })
})

describe('orders system — attack orders', () => {
  beforeEach(() => clearComponents())

  it('approaches a positionally unreachable target as close as it can get', () => {
    const ctx = makeContext()
    const bishop = createPiece(ctx, 'blue', PIECES.bishop, { x: 5, y: 3 }) // f5 (light)
    const king = createPiece(ctx, 'red', PIECES.king, { x: 3, y: 0 }) // d8 (dark)
    const order = ctx.world.require(bishop, Order)
    order.kind = 'attack'
    order.target = king
    order.reachable = false

    run(ctx)

    // Best-effort: it still routes toward the target rather than freezing, so the
    // overlay can show the route followed by the unreachable firing line. The
    // goal is the closest reachable empty square to d8, never d8 itself.
    const motion = ctx.world.require(bishop, Motion)
    expect(motion.goal).not.toBeNull()
    expect(motion.goal).not.toEqual({ x: 3, y: 0 })
  })

  it('parks on the closest square to an unreachable target instead of shuttling', () => {
    const ctx = makeContext()
    const bishop = createPiece(ctx, 'blue', PIECES.bishop, { x: 6, y: 2 }) // g6 (light)
    const king = createPiece(ctx, 'red', PIECES.king, { x: 7, y: 2 }) // h6 (dark)
    const order = ctx.world.require(bishop, Order)
    order.kind = 'attack'
    order.target = king
    order.reachable = false

    run(ctx)

    // g6 is already as close as any reachable square, so the goal is its own cell
    // (the tie-hold), not the equidistant h7 the old code shuffled to.
    const motion = ctx.world.require(bishop, Motion)
    expect(motion.goal).toEqual({ x: 6, y: 2 })
    expect(motion.path).toEqual([])
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

  it('routes a knight to the firing cell it can reach in fewest moves', () => {
    const ctx = makeContext()
    const knight = createPiece(ctx, 'blue', PIECES.knight, { x: 2, y: 5 }) // c3
    const pawn = createPiece(ctx, 'red', PIECES.pawn, { x: 3, y: 1 }) // d7
    createPiece(ctx, 'blue', PIECES.bishop, { x: 2, y: 3 }) // c5, blocks a firing cell
    createPiece(ctx, 'red', PIECES.pawn, { x: 5, y: 2 }) // f6, blocks a firing cell
    const order = ctx.world.require(knight, Order)
    order.kind = 'attack'
    order.target = pawn
    order.reachable = true

    run(ctx)

    // b6 is two knight hops away; the Euclidean-nearest firing cell e5 is four.
    expect(ctx.world.require(knight, Motion).goal).toEqual({ x: 1, y: 2 })
  })

  it('logs why an attack order was abandoned when its target is gone', () => {
    const ctx = makeContext()
    const knight = createPiece(ctx, 'blue', PIECES.knight, { x: 2, y: 2 })
    const queen = createPiece(ctx, 'red', PIECES.queen, { x: 3, y: 0 })
    const order = ctx.world.require(knight, Order)
    order.kind = 'attack'
    order.target = queen
    order.reachable = true
    ctx.world.destroy(queen)

    run(ctx)

    expect(order.kind).toBe('none')
    expect(order.log.some((entry) => entry.text.includes('attack target lost'))).toBe(true)
  })
})

describe('orders system — motion intent provenance', () => {
  beforeEach(() => clearComponents())

  /** A flat board with a blue rally lane so AI advances have a destination. */
  function context(): SimContext {
    const ctx = makeContext()
    ctx.board.data.lanes.blue = [{ x: 4, y: 7 }]
    return ctx
  }

  function fireOn(ctx: SimContext, piece: number, attacker: number): void {
    const target = ctx.world.require(piece, Target)
    target.lastAttacker = attacker
    target.underFireUntil = ctx.tick + 90
  }

  it('marks an explicit goto goal as an order', () => {
    const ctx = context()
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 4, y: 4 })
    const order = ctx.world.require(queen, Order)
    order.kind = 'goto'
    order.dest = { x: 7, y: 4 }

    run(ctx)

    expect(ctx.world.require(queen, Motion).intent).toBe('order')
  })

  it('marks a self-preservation retreat as preserve', () => {
    const ctx = context()
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 4, y: 4 })
    const rook = createPiece(ctx, 'red', PIECES.rook, { x: 4, y: 0 })
    ctx.world.require(queen, Health).cur = Math.floor(PIECES.queen.hp * 0.45)
    fireOn(ctx, queen, rook)

    run(ctx)

    const motion = ctx.world.require(queen, Motion)
    expect(motion.intent).toBe('preserve')
    expect(motion.goal).not.toBeNull()
  })

  it('holds instead of drifting when only non-shooting enemies are near', () => {
    const ctx = context()
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 4, y: 4 })
    // An a-file / rank-3 rook is inside the cover radius but does not cover d4.
    createPiece(ctx, 'red', PIECES.rook, { x: 0, y: 3 })
    ctx.world.require(queen, Health).cur = Math.floor(PIECES.queen.hp * 0.45)

    run(ctx)

    const motion = ctx.world.require(queen, Motion)
    expect(motion.goal).toBeNull()
    expect(motion.intent).toBe('none')
  })

  it('holds in the king aura against a stale attacker that cannot hit it', () => {
    const ctx = context()
    createPiece(ctx, 'blue', PIECES.king, { x: 4, y: 7 })
    const knight = createPiece(ctx, 'blue', PIECES.knight, { x: 4, y: 6 })
    // A red knight two files away cannot leap onto e2, but is flagged as the
    // recent attacker: the aura holds the piece rather than fleeing a ghost.
    const attacker = createPiece(ctx, 'red', PIECES.knight, { x: 6, y: 6 })
    ctx.world.require(knight, Health).cur = Math.floor(PIECES.knight.hp * 0.3)
    fireOn(ctx, knight, attacker)

    run(ctx)

    expect(ctx.world.require(knight, Motion).goal).toBeNull()
  })

  it('holds in the king aura against a non-lethal shooter', () => {
    const ctx = context()
    createPiece(ctx, 'blue', PIECES.king, { x: 4, y: 7 })
    const knight = createPiece(ctx, 'blue', PIECES.knight, { x: 4, y: 6 })
    createPiece(ctx, 'red', PIECES.rook, { x: 4, y: 0 }) // covers the e-file (20 dmg)
    ctx.world.require(knight, Health).cur = 30 // survives one rook volley

    run(ctx)

    // It stays on the healing square rather than being nudged out of the aura.
    expect(ctx.world.require(knight, Motion).goal).toBeNull()
  })

  it('dodges in the king aura when the volley would kill it', () => {
    const ctx = context()
    createPiece(ctx, 'blue', PIECES.king, { x: 4, y: 7 })
    const knight = createPiece(ctx, 'blue', PIECES.knight, { x: 4, y: 6 })
    createPiece(ctx, 'red', PIECES.rook, { x: 4, y: 0 }) // 20 dmg >= 15 hp
    ctx.world.require(knight, Health).cur = 15

    run(ctx)

    const motion = ctx.world.require(knight, Motion)
    expect(motion.intent).toBe('preserve')
    expect(motion.goal).not.toBeNull()
  })

  it('marks an AI advance as rally', () => {
    const ctx = context()
    ctx.teams.red.controller = 'ai'
    const rook = createPiece(ctx, 'red', PIECES.rook, { x: 0, y: 0 })

    run(ctx)

    expect(ctx.world.require(rook, Motion).intent).toBe('rally')
  })

  it('marks an AI king move as defense', () => {
    const ctx = context()
    ctx.teams.red.controller = 'ai'
    const king = createPiece(ctx, 'red', PIECES.king, { x: 4, y: 4 })
    createPiece(ctx, 'blue', PIECES.rook, { x: 4, y: 0 })

    run(ctx)

    expect(ctx.world.require(king, Motion).intent).toBe('defense')
  })

  it('marks an autonomous target pursuit as engage', () => {
    const ctx = context()
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 4, y: 4 })
    const rook = createPiece(ctx, 'red', PIECES.rook, { x: 1, y: 0 })
    ctx.world.require(queen, Stance).mode = 'attack'
    ctx.world.require(queen, Target).entity = rook

    run(ctx)

    expect(ctx.world.require(queen, Motion).intent).toBe('engage')
  })
})
