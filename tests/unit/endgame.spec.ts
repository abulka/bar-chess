import { beforeEach, describe, expect, it } from 'vitest'
import { Cell, Health, Motion, PieceType, Target } from '../../src/ecs/components'
import type { SimContext } from '../../src/ecs/types'
import { attackPlan } from '../../src/game/approach'
import { createPiece } from '../../src/game/factory'
import { Game } from '../../src/game/game'
import { chebyshev, NEVER } from '../../src/game/geometry'
import { PIECES, WEAPONS } from '../../src/game/pieces'
import { isKingOnlyDraw } from '../../src/game/study'
import { clearComponents, flatBoard } from '../helpers'

function shim(game: Game): SimContext {
  return { world: game.world, board: game.board, rng: game.rng } as unknown as SimContext
}

function stripArmy(game: Game): void {
  for (const e of [...game.world.query(Cell)]) game.world.destroy(e)
}

describe('range-1 acquisition', () => {
  beforeEach(() => clearComponents())

  it('lets an AI pawn acquire the forward diagonal its weapon covers', () => {
    const game = new Game(8, 'ai-vs-ai')
    stripArmy(game)
    const pawn = createPiece(shim(game), 'blue', PIECES.pawn, { x: 3, y: 3 }) // d5
    const enemy = createPiece(shim(game), 'red', PIECES.knight, { x: 4, y: 2 }) // e6, forward-right diagonal

    // The pawn's gun is a range-1 diagonal, so it must notice e6. A circular
    // vision radius of 1 used to reject it (distance sqrt(2)) and leave the pawn
    // unable to target the one square it can actually shoot.
    expect(WEAPONS[PIECES.pawn.weapon].geometry).toMatchObject({ kind: 'slide', range: 1 })
    game.runTicks(1)

    expect(game.world.require(pawn, Target).entity).toBe(enemy)
  })

  it('lets an AI king acquire a diagonal neighbour', () => {
    const game = new Game(8, 'ai-vs-ai')
    stripArmy(game)
    const king = createPiece(shim(game), 'blue', PIECES.king, { x: 4, y: 7 })
    const enemy = createPiece(shim(game), 'red', PIECES.knight, { x: 5, y: 6 }) // diagonal neighbour

    game.runTicks(1)

    expect(game.world.require(king, Target).entity).toBe(enemy)
  })
})

describe('endgame king targeting', () => {
  beforeEach(() => clearComponents())

  it('sends an idle AI piece with no target at the enemy king', () => {
    const game = new Game(8, 'ai-vs-ai')
    stripArmy(game)
    const pawn = createPiece(shim(game), 'blue', PIECES.pawn, { x: 0, y: 6 }) // a2
    createPiece(shim(game), 'red', PIECES.king, { x: 7, y: 0 }) // h8
    createPiece(shim(game), 'red', PIECES.pawn, { x: 1, y: 0 }) // still has field pieces
    game.teams.blue.alive = { pawn: 1 }
    game.teams.red.alive = { king: 1, pawn: 1 }

    game.runTicks(1)

    // The king is far outside the pawn's vision, so no target is acquired and
    // the fallback goal is the enemy king's square rather than a static midpoint.
    expect(game.world.require(pawn, Motion).goal).toEqual({ x: 7, y: 0 })
  })

  it('presses the finish instead of holding when the enemy is down to its king', () => {
    const game = new Game(8, 'ai-vs-ai')
    stripArmy(game)
    const rook = createPiece(shim(game), 'blue', PIECES.rook, { x: 3, y: 5 })
    createPiece(shim(game), 'blue', PIECES.king, { x: 4, y: 7 }) // healing aura
    createPiece(shim(game), 'red', PIECES.king, { x: 4, y: 0 })
    game.teams.blue.alive = { rook: 1, king: 1 }
    game.teams.red.alive = { king: 1 }
    // Wounded and latched: normally this would hold in the aura for the rest of
    // the game. With only the enemy king left, the rook must take the shot.
    game.world.require(rook, Health).cur = 40
    game.world.require(rook, Motion).holdUntilHp = 140

    game.runTicks(1)

    expect(game.world.require(rook, Motion).goal).not.toBeNull()
  })
})

describe('promotion', () => {
  beforeEach(() => clearComponents())

  function promotionSetup(): { game: Game; pawn: number } {
    const game = new Game(8, 'ai-vs-ai')
    stripArmy(game)
    const pawn = createPiece(shim(game), 'blue', PIECES.pawn, { x: 4, y: 0 }) // e8, enemy back rank
    createPiece(shim(game), 'red', PIECES.king, { x: 0, y: 0 }) // a8
    game.teams.blue.alive = { pawn: 1 }
    game.teams.red.alive = { king: 1 }
    return { game, pawn }
  }

  it('turns a pawn on the enemy back rank into a queen', () => {
    const { game, pawn } = promotionSetup()

    game.runTicks(1)

    expect(game.world.require(pawn, PieceType).kind).toBe('queen')
    expect(game.world.require(pawn, Health).max).toBe(PIECES.queen.hp)
    expect(game.teams.blue.alive.pawn).toBe(0)
    expect(game.teams.blue.alive.queen).toBe(1)
  })

  it('leaves the pawn alone when the rule is off', () => {
    const { game, pawn } = promotionSetup()
    game.promotion = false

    game.runTicks(1)

    expect(game.world.require(pawn, PieceType).kind).toBe('pawn')
  })
})

describe('king-adjacent danger', () => {
  beforeEach(() => clearComponents())

  it('prefers a firing cell outside the enemy king thrash zone', () => {
    const board = flatBoard(8)
    const target = { x: 4, y: 0 }
    // Avoid the enemy king's 3x3 (x3-5, y0-1).
    const avoid = (x: number, y: number) => x >= 3 && x <= 5 && y <= 1
    const plan = attackPlan(
      board,
      { x: 4, y: 4 },
      target,
      PIECES.queen.move,
      WEAPONS.queenNova.geometry,
      'blue',
      NEVER,
      avoid,
    )
    // Without `avoid` the nearest firing cell is d4/d3-adjacent (4,1); with it
    // the queen must stand at least two squares off the king.
    expect(chebyshev(plan.cell.x, plan.cell.y, target.x, target.y)).toBeGreaterThan(1)
  })

  it('still fires from an adjacent cell when no safe line exists', () => {
    const board = flatBoard(8)
    const target = { x: 4, y: 0 }
    // Avoid every approach cell: the planner must fall back rather than stall.
    const plan = attackPlan(
      board,
      { x: 4, y: 4 },
      target,
      PIECES.queen.move,
      WEAPONS.queenNova.geometry,
      'blue',
      NEVER,
      () => true,
    )
    expect(plan.cell).toBeTruthy()
  })
})

describe('king-only draw classification', () => {
  beforeEach(() => clearComponents())

  it('is a draw when neither side has a non-king piece', () => {
    const game = new Game(8, 'ai-vs-ai')
    stripArmy(game)
    createPiece(shim(game), 'blue', PIECES.king, { x: 4, y: 7 })
    createPiece(shim(game), 'red', PIECES.king, { x: 4, y: 0 })
    expect(isKingOnlyDraw(game)).toBe(true)

    createPiece(shim(game), 'red', PIECES.pawn, { x: 0, y: 0 })
    expect(isKingOnlyDraw(game)).toBe(false)
  })
})
