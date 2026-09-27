import { beforeEach, describe, expect, it } from 'vitest'
import { Cell, Motion } from '../../src/ecs/components'
import { createPiece } from '../../src/game/factory'
import { enemyCoverage, isInCheck } from '../../src/game/kingSafety'
import { buildOccupancy } from '../../src/game/occupancy'
import { PIECES } from '../../src/game/pieces'
import movement from '../../src/ecs/systems/movement'
import pathfinding from '../../src/ecs/systems/pathfinding'
import { clearComponents, makeContext } from '../helpers'
import type { SimContext } from '../../src/ecs/types'

function covers(ctx: SimContext, coverage: Set<number>, x: number, y: number): boolean {
  return coverage.has(ctx.board.cellIndex(x, y))
}

describe('king safety — enemy coverage', () => {
  beforeEach(() => clearComponents())

  it('covers the rook lines, including through the king’s own freed square', () => {
    const ctx = makeContext()
    const king = createPiece(ctx, 'red', PIECES.king, { x: 2, y: 1 })
    createPiece(ctx, 'blue', PIECES.rook, { x: 5, y: 1 })
    ctx.occupancy = buildOccupancy(ctx.world, ctx.board)

    const coverage = enemyCoverage(ctx.board, ctx.world, ctx.occupancy, king, 'red')

    expect(covers(ctx, coverage, 2, 1)).toBe(true) // the king's own square
    expect(covers(ctx, coverage, 1, 1)).toBe(true) // behind the king, once it vacates
    expect(covers(ctx, coverage, 4, 4)).toBe(false) // off the rank
  })

  it('covers bishop rays, knight leaps and pawn forward diagonals', () => {
    const ctx = makeContext()
    const king = createPiece(ctx, 'red', PIECES.king, { x: 4, y: 4 })
    createPiece(ctx, 'blue', PIECES.bishop, { x: 1, y: 1 }) // a1-h8 diagonal through e4
    createPiece(ctx, 'blue', PIECES.knight, { x: 5, y: 3 }) // leaps to (3,4)
    createPiece(ctx, 'blue', PIECES.pawn, { x: 3, y: 5 }) // blue pawn fires toward -y: (2,4)/(4,4)
    ctx.occupancy = buildOccupancy(ctx.world, ctx.board)

    const coverage = enemyCoverage(ctx.board, ctx.world, ctx.occupancy, king, 'red')

    expect(covers(ctx, coverage, 2, 2)).toBe(true) // bishop ray
    expect(covers(ctx, coverage, 3, 4)).toBe(true) // knight leap target
    expect(covers(ctx, coverage, 2, 4)).toBe(true) // pawn forward diagonal
    expect(isInCheck(ctx.board, ctx.world, ctx.occupancy, king, 'red')).toBe(true)
  })

  it('lets blockers hide squares behind them', () => {
    const ctx = makeContext()
    const king = createPiece(ctx, 'red', PIECES.king, { x: 0, y: 4 })
    createPiece(ctx, 'blue', PIECES.rook, { x: 0, y: 0 })
    createPiece(ctx, 'red', PIECES.pawn, { x: 0, y: 2 }) // blocker on the file
    ctx.occupancy = buildOccupancy(ctx.world, ctx.board)

    const coverage = enemyCoverage(ctx.board, ctx.world, ctx.occupancy, king, 'red')

    expect(covers(ctx, coverage, 0, 2)).toBe(true) // the blocker itself is hittable
    expect(covers(ctx, coverage, 0, 4)).toBe(false) // the king behind it is safe
    expect(isInCheck(ctx.board, ctx.world, ctx.occupancy, king, 'red')).toBe(false)
  })

  it('treats the enemy king’s ring as covered, so kings can never be adjacent', () => {
    const ctx = makeContext()
    const king = createPiece(ctx, 'red', PIECES.king, { x: 3, y: 2 })
    createPiece(ctx, 'blue', PIECES.king, { x: 3, y: 4 })
    ctx.occupancy = buildOccupancy(ctx.world, ctx.board)

    const coverage = enemyCoverage(ctx.board, ctx.world, ctx.occupancy, king, 'red')

    expect(covers(ctx, coverage, 3, 3)).toBe(true) // stepping into opposition
    expect(covers(ctx, coverage, 2, 4)).toBe(true) // another ring square
    expect(covers(ctx, coverage, 0, 0)).toBe(false)
  })
})

describe('king safety — movement and pathfinding', () => {
  beforeEach(() => clearComponents())

  it('refuses a step onto a covered square', () => {
    const ctx = makeContext()
    const king = createPiece(ctx, 'red', PIECES.king, { x: 4, y: 4 })
    createPiece(ctx, 'blue', PIECES.rook, { x: 4, y: 0 }) // covers the e-file
    ctx.occupancy = buildOccupancy(ctx.world, ctx.board)
    const motion = ctx.world.require(king, Motion)
    motion.cooldown = 0
    motion.path = [{ x: 4, y: 3 }]
    motion.goal = { x: 4, y: 3 }

    movement.update(ctx)

    expect(motion.moving).toBe(false)
    expect(motion.path).toHaveLength(0)
  })

  it('allows a step onto an uncovered square', () => {
    const ctx = makeContext()
    const king = createPiece(ctx, 'red', PIECES.king, { x: 4, y: 4 })
    createPiece(ctx, 'blue', PIECES.rook, { x: 4, y: 0 }) // covers the e-file
    ctx.occupancy = buildOccupancy(ctx.world, ctx.board)
    const motion = ctx.world.require(king, Motion)
    motion.cooldown = 0
    motion.path = [{ x: 3, y: 4 }]
    motion.goal = { x: 3, y: 4 }

    movement.update(ctx)

    expect(motion.moving).toBe(true)
  })

  it('routes a king around checked squares', () => {
    const ctx = makeContext()
    const king = createPiece(ctx, 'red', PIECES.king, { x: 0, y: 4 })
    createPiece(ctx, 'blue', PIECES.rook, { x: 2, y: 4 }) // covers rank 4
    ctx.occupancy = buildOccupancy(ctx.world, ctx.board)
    const motion = ctx.world.require(king, Motion)
    motion.goal = { x: 4, y: 4 } // straight through the rook's rank
    ctx.pathBudget = 64

    pathfinding.update(ctx)

    const covered = enemyCoverage(ctx.board, ctx.world, ctx.occupancy, king, 'red')
    expect(motion.path.length).toBeGreaterThan(0)
    for (const step of motion.path) {
      expect(covered.has(ctx.board.cellIndex(step.x, step.y))).toBe(false)
    }
  })
})
