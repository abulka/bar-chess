import { beforeEach, describe, expect, it } from 'vitest'
import { Cell, Health, Order, Projectile, Target, Weapon } from '../../src/ecs/components'
import type { SimContext } from '../../src/ecs/types'
import { createPiece } from '../../src/game/factory'
import { Game } from '../../src/game/game'
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
    // Order history names the square, never the entity id.
    expect(game.world.require(queen, Order).log.map((n) => n.text)).toContain('chess kill → e3')

    game.runTicks(1)
    expect(game.world.has(pawn, Cell)).toBe(false)
    expect(game.teams.red.losses).toBe(1)

    game.runTicks(1)
    const notes = game.world.require(queen, Order).log.map((n) => n.text)
    expect(notes).toContain('target at e3 lost — attack abandoned')
    expect(notes.every((t) => !/#\d+/.test(t))).toBe(true)
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
