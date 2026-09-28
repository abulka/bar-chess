import { beforeEach, describe, expect, it } from 'vitest'
import { Health } from '../../src/ecs/components'
import { defendedMap, friendlyCoverageCells, isDefended } from '../../src/game/defended'
import { createPiece } from '../../src/game/factory'
import { buildOccupancy } from '../../src/game/occupancy'
import { PIECES } from '../../src/game/pieces'
import { clearComponents, makeContext } from '../helpers'
import type { SimContext } from '../../src/ecs/types'

function occupied(ctx: SimContext) {
  return buildOccupancy(ctx.world, ctx.board)
}

describe('defended squares', () => {
  beforeEach(() => clearComponents())

  it('marks a square inside a friendly slide weapon as defended', () => {
    const ctx = makeContext()
    createPiece(ctx, 'blue', PIECES.rook, { x: 4, y: 4 })
    const pawn = createPiece(ctx, 'blue', PIECES.pawn, { x: 5, y: 4 })

    expect(isDefended(ctx.board, ctx.world, occupied(ctx), 'blue', pawn)).toBe(true)
  })

  it('does not defend a square off every friendly line', () => {
    const ctx = makeContext()
    createPiece(ctx, 'blue', PIECES.rook, { x: 4, y: 4 })
    const pawn = createPiece(ctx, 'blue', PIECES.pawn, { x: 5, y: 6 })

    expect(isDefended(ctx.board, ctx.world, occupied(ctx), 'blue', pawn)).toBe(false)
  })

  it('never counts the enemy team as a defender', () => {
    const ctx = makeContext()
    createPiece(ctx, 'red', PIECES.rook, { x: 4, y: 4 })
    const pawn = createPiece(ctx, 'blue', PIECES.pawn, { x: 5, y: 4 })

    expect(isDefended(ctx.board, ctx.world, occupied(ctx), 'blue', pawn)).toBe(false)
  })

  it('blocks a slide defender when a third piece stands in the way', () => {
    const ctx = makeContext()
    createPiece(ctx, 'blue', PIECES.rook, { x: 4, y: 4 })
    createPiece(ctx, 'blue', PIECES.pawn, { x: 4, y: 3 }) // first blocker up the file
    const onRank = createPiece(ctx, 'blue', PIECES.pawn, { x: 5, y: 4 })
    const behind = createPiece(ctx, 'blue', PIECES.king, { x: 4, y: 1 })

    const occ = occupied(ctx)
    expect(isDefended(ctx.board, ctx.world, occ, 'blue', onRank)).toBe(true)
    expect(isDefended(ctx.board, ctx.world, occ, 'blue', behind)).toBe(false)
  })

  it('covers a square with a knight leap and a pawn diagonal', () => {
    const ctx = makeContext()
    createPiece(ctx, 'blue', PIECES.knight, { x: 4, y: 4 })
    const leapTarget = createPiece(ctx, 'blue', PIECES.pawn, { x: 6, y: 5 })
    expect(isDefended(ctx.board, ctx.world, occupied(ctx), 'blue', leapTarget)).toBe(true)

    const pawn = createPiece(ctx, 'blue', PIECES.pawn, { x: 0, y: 6 }) // blue pawn fires up-diagonals
    const diagTarget = createPiece(ctx, 'blue', PIECES.pawn, { x: 1, y: 5 })
    expect(isDefended(ctx.board, ctx.world, occupied(ctx), 'blue', diagTarget)).toBe(true)
  })

  it('does not credit a piece with defending the square it is about to leave', () => {
    const ctx = makeContext()
    // A lone queen: with herself excluded the board has no defender at all.
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 4, y: 4 })
    const covered = friendlyCoverageCells(ctx.board, ctx.world, occupied(ctx), 'blue', queen)
    expect(covered.has(ctx.board.cellIndex(4, 4))).toBe(false)
    expect(covered.size).toBe(0)
  })

  it('never lists the king as a defended target', () => {
    const ctx = makeContext()
    const king = createPiece(ctx, 'blue', PIECES.king, { x: 4, y: 4 })
    createPiece(ctx, 'blue', PIECES.rook, { x: 4, y: 3 }) // covers the king's square

    const map = defendedMap(ctx.board, ctx.world, occupied(ctx), 'blue')
    expect(map.has(king)).toBe(false)
  })

  it('reports mutual support for two adjacent pieces', () => {
    const ctx = makeContext()
    const a = createPiece(ctx, 'blue', PIECES.rook, { x: 4, y: 4 })
    const b = createPiece(ctx, 'blue', PIECES.rook, { x: 5, y: 4 })
    const occ = occupied(ctx)

    const map = defendedMap(ctx.board, ctx.world, occ, 'blue')
    expect(map.get(a)).toEqual([b])
    expect(map.get(b)).toEqual([a])
  })

  it('does not count a piece at zero health as a defender', () => {
    const ctx = makeContext()
    const rook = createPiece(ctx, 'blue', PIECES.rook, { x: 4, y: 4 })
    const pawn = createPiece(ctx, 'blue', PIECES.pawn, { x: 5, y: 4 })
    ctx.world.require(rook, Health).cur = 0

    expect(isDefended(ctx.board, ctx.world, occupied(ctx), 'blue', pawn)).toBe(false)
  })
})
