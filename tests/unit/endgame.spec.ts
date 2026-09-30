import { beforeEach, describe, expect, it } from 'vitest'
import { Cell, Health, Motion, Order, PieceType, Target } from '../../src/ecs/components'
import type { SimContext } from '../../src/ecs/types'
import { attackPlan } from '../../src/game/approach'
import { createPiece } from '../../src/game/factory'
import { Game } from '../../src/game/game'
import { chebyshev, NEVER } from '../../src/game/geometry'
import { PIECES, WEAPONS } from '../../src/game/pieces'
import { isKingOnlyDraw } from '../../src/game/study'
import { clearComponents, flatBoard, orderAttack } from '../helpers'

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

describe('endgame AI move budget and finish', () => {
  beforeEach(() => clearComponents())

  it('lets a second AI piece move once the finish is on', () => {
    const game = new Game(8, 'human-vs-ai', 5)
    stripArmy(game)
    // The queen begins off the king's lines, so it must spend a move to pursue.
    createPiece(shim(game), 'red', PIECES.queen, { x: 2, y: 2 })
    const king = createPiece(shim(game), 'red', PIECES.king, { x: 4, y: 0 })
    const blueKing = createPiece(shim(game), 'blue', PIECES.king, { x: 0, y: 3 })
    game.teams.red.alive = { queen: 1, king: 1 }
    game.teams.blue.alive = { king: 1 }
    game.world.require(blueKing, Health).cur = 11
    const before = { ...game.world.require(king, Cell) }

    game.beginTurn()
    let guard = 0
    while (game.turnActive && guard++ < 4000) game.runTicks(1)

    // The human side is down to its king, so the AI is in the finishing phase
    // and must not be rationed by the live move budget: queen AND king move.
    expect(game.teams.blue.kingOnlySince).toBeGreaterThanOrEqual(0)
    expect(game.teams.red.movesMade).toBe(2)
    const after = game.world.require(king, Cell)
    expect(after.x !== before.x || after.y !== before.y).toBe(true)
  })

  it('resolves the reported queen+king siege once the king joins', () => {
    const game = new Game(8, 'human-vs-ai', 7)
    stripArmy(game)
    createPiece(shim(game), 'red', PIECES.queen, { x: 2, y: 5 })
    const king = createPiece(shim(game), 'red', PIECES.king, { x: 4, y: 0 })
    const blueKing = createPiece(shim(game), 'blue', PIECES.king, { x: 0, y: 4 })
    game.teams.red.alive = { queen: 1, king: 1 }
    game.teams.blue.alive = { king: 1 }
    game.world.require(king, Health).cur = 8
    game.world.require(blueKing, Health).cur = 11

    for (let i = 0; i < 40 && game.winner === null; i++) {
      game.beginTurn()
      let guard = 0
      while (game.turnActive && guard++ < 4000) game.runTicks(1)
    }
    expect(game.winner).toBe('red')
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

describe('ordered attack against the enemy king kill zone', () => {
  beforeEach(() => clearComponents())

  /** Blue bishop c8 ordered at the opposite-colour red king a7. */
  function duel(): { game: Game; bishop: number; king: number } {
    const game = new Game(8, 'human-vs-ai')
    stripArmy(game)
    const bishop = createPiece(shim(game), 'blue', PIECES.bishop, { x: 2, y: 0 })
    const king = createPiece(shim(game), 'red', PIECES.king, { x: 0, y: 1 })
    game.teams.blue.alive = { bishop: 1 }
    game.teams.red.alive = { king: 1 }
    return { game, bishop, king }
  }

  it('holds a doomed ordered piece outside the lone king 3×3', () => {
    const { game, bishop, king } = duel()
    game.world.require(bishop, Health).cur = 40 // one guard hit (60) would kill it
    orderAttack(game, bishop, king, false)

    game.runTicks(1)

    // The best-effort approach still points at the king, but parks on the safe
    // c8 rather than the adjacent a8.
    expect(game.world.require(bishop, Motion).goal).toEqual({ x: 2, y: 0 })
  })

  it('lets an ordered piece that can survive a guard hit approach the ring', () => {
    const { game, bishop, king } = duel()
    // Full 75 hp > 0.8 × 75 = 60: it may take one hit, so it closes to a8.
    orderAttack(game, bishop, king, false)

    game.runTicks(1)

    expect(game.world.require(bishop, Motion).goal).toEqual({ x: 0, y: 0 })
  })

  it('keeps a tanky ordered piece out of the ring while the enemy still has field pieces', () => {
    const game = new Game(8, 'human-vs-ai')
    stripArmy(game)
    const queen = createPiece(shim(game), 'blue', PIECES.queen, { x: 4, y: 2 }) // e6
    const king = createPiece(shim(game), 'red', PIECES.king, { x: 5, y: 0 }) // f8
    createPiece(shim(game), 'red', PIECES.pawn, { x: 5, y: 1 }) // f7: a field piece
    game.teams.blue.alive = { queen: 1 }
    game.teams.red.alive = { king: 1, pawn: 1 }
    // 158 > 0.8 × 165, yet the finish is not on, so avoiding the ring wins.
    game.world.require(queen, Health).cur = 158
    orderAttack(game, queen, king, false)

    game.runTicks(1)

    const goal = game.world.require(queen, Motion).goal
    expect(goal).not.toBeNull()
    expect(chebyshev(goal!.x, goal!.y, 5, 0)).toBeGreaterThan(1)
  })

  it('lets an insisting player force the approach past the kill zone', () => {
    const { game, bishop, king } = duel()
    game.world.require(bishop, Health).cur = 40
    orderAttack(game, bishop, king, false)
    // Alt-click insist suspends the kill-zone avoidance for the window.
    game.world.require(bishop, Order).noPreserveUntil = game.turn + 3

    game.runTicks(1)

    expect(game.world.require(bishop, Motion).goal).toEqual({ x: 0, y: 0 })
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

describe('lone king under ranged check', () => {
  beforeEach(() => clearComponents())

  it('steps off the firing line instead of holding to death', () => {
    const game = new Game(8, 'human-vs-ai', 2654435769)
    stripArmy(game)
    // The reported position: red has only its king on f7, checked down the
    // h5–f7 diagonal by the blue queen, which also covers both closing squares.
    // The king cannot reach the queen, so it must step out of the line.
    const king = createPiece(shim(game), 'red', PIECES.king, { x: 5, y: 1 })
    createPiece(shim(game), 'blue', PIECES.queen, { x: 7, y: 3 })
    game.teams.red.alive = { king: 1 }
    game.teams.blue.alive = { queen: 1, king: 1 }

    game.beginTurn()
    let guard = 0
    while (game.turnActive && guard++ < 4000) game.runTicks(1)

    const after = game.world.require(king, Cell)
    expect(after.x !== 5 || after.y !== 1).toBe(true)
  })

  it('retreats out of check when the sideways escapes are covered', () => {
    const game = new Game(8, 'human-vs-ai', 2654435769)
    stripArmy(game)
    // The reported corner: f7 is checked by the queen (h5), the bishop (d4)
    // covers f6 and g7, and the rook (h8) covers f8/g8/e8 — leaving only e7/e6,
    // both farther from the queen. The king must still step out.
    const king = createPiece(shim(game), 'red', PIECES.king, { x: 5, y: 1 })
    createPiece(shim(game), 'blue', PIECES.queen, { x: 7, y: 3 })
    createPiece(shim(game), 'blue', PIECES.bishop, { x: 3, y: 4 })
    createPiece(shim(game), 'blue', PIECES.rook, { x: 7, y: 0 })
    game.teams.red.alive = { king: 1 }
    game.teams.blue.alive = { queen: 1, bishop: 1, rook: 1, king: 1 }

    game.beginTurn()
    let guard = 0
    while (game.turnActive && guard++ < 4000) game.runTicks(1)

    const after = game.world.require(king, Cell)
    expect(after.x !== 5 || after.y !== 1).toBe(true)
  })
})
