import { beforeEach, describe, expect, it } from 'vitest'
import { Cell, Health, Motion, Order, Projectile, Stance, Target, Weapon } from '../../src/ecs/components'
import type { SimContext } from '../../src/ecs/types'
import { createPiece } from '../../src/game/factory'
import { Game } from '../../src/game/game'
import { hasInstaKill } from '../../src/game/instaKill'
import { PIECES } from '../../src/game/pieces'
import combat from '../../src/ecs/systems/combat'
import damage from '../../src/ecs/systems/damage'
import { clearComponents, makeContext } from '../helpers'

/** A bare Game with no pieces, plus a `createPiece` shim for placement. */
function emptyGame(): { game: Game; shim: SimContext } {
  const game = new Game(8)
  for (const e of [...game.world.query(Cell)]) game.world.destroy(e)
  const shim = { world: game.world, board: game.board, rng: game.rng } as unknown as SimContext
  return { game, shim }
}

describe('traditional chess kills', () => {
  beforeEach(() => clearComponents())

  it('kills a target already in capture range when attacked', () => {
    const { game, shim } = emptyGame()
    const queen = createPiece(shim, 'blue', PIECES.queen, { x: 4, y: 4 })
    const pawn = createPiece(shim, 'red', PIECES.pawn, { x: 4, y: 5 })
    game.chessKills = true
    game.selected = [queen]

    game.orderAt({ x: 4, y: 5 })

    // The pending kill lives on the order (world state), not the command queue.
    expect(game.world.require(queen, Order).chessKill).toBe(pawn)
    // Order history names the square and the immediate (insta-kill) nature.
    expect(game.world.require(queen, Order).log.map((n) => n.text)).toContain('immediate chess kill → e3')

    game.runTicks(1)
    expect(game.world.has(pawn, Cell)).toBe(false)
    expect(game.teams.red.losses).toBe(1)

    game.runTicks(1)
    const notes = game.world.require(queen, Order).log.map((n) => n.text)
    expect(notes).toContain('immediate chess kill lands → e3')
    expect(notes).toContain('target at e3 lost — attack abandoned')
    expect(notes.every((t) => !/#\d+/.test(t))).toBe(true)
  })

  it('reifies the insta-kill concept via hasInstaKill', () => {
    const { game, shim } = emptyGame()
    const queen = createPiece(shim, 'blue', PIECES.queen, { x: 4, y: 4 })
    createPiece(shim, 'red', PIECES.pawn, { x: 4, y: 5 })
    const order = game.world.require(queen, Order)
    expect(hasInstaKill(order)).toBe(false)

    game.chessKills = true
    game.selected = [queen]
    game.orderAt({ x: 4, y: 5 })
    expect(hasInstaKill(order)).toBe(true)

    // Consumed on the next tick: it is a one-shot, immediate concept.
    game.runTicks(1)
    expect(hasInstaKill(order)).toBe(false)
  })

  it('does not park an insta-kill for a queued attack behind an active order', () => {
    const { game, shim } = emptyGame()
    const queen = createPiece(shim, 'blue', PIECES.queen, { x: 4, y: 4 })
    createPiece(shim, 'red', PIECES.pawn, { x: 4, y: 5 })
    game.chessKills = true
    game.selected = [queen]

    // The move starts the active order, so the attack click is only queued.
    game.orderAt({ x: 0, y: 4 }, 'move')
    game.orderAt({ x: 4, y: 5 })

    const order = game.world.require(queen, Order)
    expect(order.chessKill).toBeNull()
    expect(order.queue).toHaveLength(1)
  })

  it('replays an order-time chess kill from the turn snapshot', () => {
    const { game } = emptyGame()
    const shim = { world: game.world, board: game.board, rng: game.rng } as unknown as SimContext
    const queen = createPiece(shim, 'blue', PIECES.queen, { x: 4, y: 4 })
    const pawn = createPiece(shim, 'red', PIECES.pawn, { x: 4, y: 5 })
    game.chessKills = true
    game.setCaptureAdvance(true)
    game.selected = [queen]
    game.orderAt({ x: 4, y: 5 })
    game.beginTurn()
    while (game.turnActive) game.runTicks(1)
    expect(game.world.has(pawn, Cell)).toBe(false)

    game.replayTurn()
    let guard = 0
    while (game.replaying && guard++ < 400) game.runTicks(1)
    // The kill (and its animation) reproduces on replay.
    expect(game.world.has(pawn, Cell)).toBe(false)
  })

  it('does nothing when the target is out of range at order time', () => {
    const { game, shim } = emptyGame()
    const knight = createPiece(shim, 'blue', PIECES.knight, { x: 0, y: 0 })
    createPiece(shim, 'red', PIECES.pawn, { x: 4, y: 4 })
    game.chessKills = true
    game.selected = [knight]

    game.orderAt({ x: 4, y: 4 })

    expect(game.world.require(knight, Order).chessKill).toBeNull()
  })

  it('respects the toggle being off', () => {
    const { game, shim } = emptyGame()
    const queen = createPiece(shim, 'blue', PIECES.queen, { x: 4, y: 4 })
    createPiece(shim, 'red', PIECES.pawn, { x: 4, y: 5 })
    game.chessKills = false
    game.selected = [queen]

    game.orderAt({ x: 4, y: 5 })

    expect(game.world.require(queen, Order).chessKill).toBeNull()
  })

  it('kills a target when ordered to move onto its square', () => {
    const { game, shim } = emptyGame()
    const queen = createPiece(shim, 'blue', PIECES.queen, { x: 4, y: 4 })
    const pawn = createPiece(shim, 'red', PIECES.pawn, { x: 4, y: 5 })
    game.chessKills = true
    game.selected = [queen]

    game.orderAt({ x: 4, y: 5 }, 'move')

    expect(game.world.require(queen, Order).chessKill).toBe(pawn)
    expect(game.world.require(queen, Order).kind).toBe('goto')
  })

  it('never lets a pawn capture straight ahead (not a chess capture)', () => {
    const { game, shim } = emptyGame()
    const pawn = createPiece(shim, 'blue', PIECES.pawn, { x: 4, y: 4 })
    createPiece(shim, 'red', PIECES.pawn, { x: 4, y: 5 })
    game.chessKills = true
    game.selected = [pawn]

    game.orderAt({ x: 4, y: 5 }, 'move')

    expect(game.world.require(pawn, Order).chessKill).toBeNull()
  })

  it('always pulls the killer onto the victim, even from a move order in Move stance', () => {
    const { game, shim } = emptyGame()
    const queen = createPiece(shim, 'blue', PIECES.queen, { x: 4, y: 4 })
    createPiece(shim, 'red', PIECES.pawn, { x: 4, y: 5 })
    game.chessKills = true
    game.setCaptureAdvance(true)
    game.world.require(queen, Stance).mode = 'move'
    game.selected = [queen]

    // A goto order (not an attack), which the ordinary advance would refuse.
    game.orderAt({ x: 4, y: 5 }, 'move')
    expect(game.world.require(queen, Order).kind).toBe('goto')

    game.runTicks(1)

    // The capture takes the square with a free advance, not the ordered step.
    const motion = game.world.require(queen, Motion)
    expect(motion.freeAdvance).toBe(true)
    expect(motion.moving).toBe(true)

    let guard = 0
    while (game.world.require(queen, Motion).moving && guard++ < 200) game.runTicks(1)
    expect(game.world.require(queen, Cell)).toEqual({ x: 4, y: 5 })
  })

  it('glides the killer onto a fatal chess capture, then wins, and replays it', () => {
    const { game, shim } = emptyGame()
    const queen = createPiece(shim, 'blue', PIECES.queen, { x: 4, y: 4 })
    const king = createPiece(shim, 'red', PIECES.king, { x: 4, y: 5 })
    game.chessKills = true
    game.setCaptureAdvance(true)
    game.selected = [queen]
    game.orderAt({ x: 4, y: 5 })
    expect(game.world.require(queen, Order).chessKill).toBe(king)

    game.beginTurn()
    let guard = 0
    while (game.turnActive && guard++ < 2000) game.runTicks(1)
    expect(guard).toBeLessThan(2000)

    // The win waits for the glide, so the queen finishes on the king's square.
    expect(game.winner).toBe('blue')
    expect(game.world.require(queen, Motion).moving).toBe(false)
    expect(game.world.require(queen, Cell)).toEqual({ x: 4, y: 5 })

    // The glide is part of the recorded turn, so a replay lands on the same state.
    game.replayTurn()
    guard = 0
    while (game.replaying && guard++ < 2000) game.runTicks(1)
    expect(game.winner).toBe('blue')
    expect(game.world.require(queen, Cell)).toEqual({ x: 4, y: 5 })
  })

  it('does not advance a chess kill when capture-advance is off', () => {
    const { game, shim } = emptyGame()
    const queen = createPiece(shim, 'blue', PIECES.queen, { x: 4, y: 4 })
    createPiece(shim, 'red', PIECES.king, { x: 4, y: 5 })
    game.chessKills = true
    game.setCaptureAdvance(false)
    game.selected = [queen]
    game.orderAt({ x: 4, y: 5 })

    game.beginTurn()
    let guard = 0
    while (game.turnActive && guard++ < 2000) game.runTicks(1)
    expect(guard).toBeLessThan(2000)

    // The king still dies, but the killer stays put: the toggle applies.
    expect(game.winner).toBe('blue')
    expect(game.world.require(queen, Cell)).toEqual({ x: 4, y: 4 })
  })
})

describe('lethal damage command', () => {
  beforeEach(() => clearComponents())

  it('drops the target to exactly 0 HP and queues a capture advance', () => {
    const ctx = makeContext({ captureAdvance: true })
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 0, y: 0 })
    const pawn = createPiece(ctx, 'red', PIECES.pawn, { x: 0, y: 4 })
    ctx.cmds.damage.push({ target: pawn, source: queen, amount: 999, kind: 'chess', direct: true, lethal: true })

    damage.update(ctx)

    expect(ctx.world.get(pawn, Health)?.cur).toBe(0)
    expect(ctx.cmds.advance).toHaveLength(1)
  })
})

describe('combat suppression against a pending chess kill', () => {
  beforeEach(() => clearComponents())

  it('does not fire a projectile at a target already marked lethal', () => {
    const ctx = makeContext()
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 0, y: 0 })
    const pawn = createPiece(ctx, 'red', PIECES.pawn, { x: 0, y: 4 })
    ctx.world.require(queen, Weapon).left = 0
    ctx.world.require(queen, Target).entity = pawn
    ctx.cmds.damage.push({ target: pawn, source: queen, amount: 42, kind: 'chess', direct: true, lethal: true })

    combat.update(ctx)

    expect(ctx.world.query(Projectile)).toHaveLength(0)
  })
})
