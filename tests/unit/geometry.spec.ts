import { describe, expect, it } from 'vitest'
import {
  attackApproachCells,
  containsCell,
  fireCells,
  lineClear,
  moveDestinations,
} from '../../src/game/geometry'
import { PIECES, WEAPONS } from '../../src/game/pieces'
import { flatBoard, occupiedCells } from '../helpers'

const rook = WEAPONS.rookShell.geometry
const knight = WEAPONS.knightBomb.geometry
const pawn = WEAPONS.pawnShot.geometry
const pawnMove = PIECES.pawn.move

describe('moveDestinations', () => {
  it('slides stop at the board edge (and never include the origin)', () => {
    const moves = moveDestinations(flatBoard(), { x: 4, y: 4 }, rook, 'blue')
    expect(moves).toHaveLength(14)
    expect(moves).toContainEqual({ x: 7, y: 4 })
    expect(moves).not.toContainEqual({ x: 4, y: 4 })
  })

  it('a piece blocks a slide, and cells beyond it are excluded', () => {
    const occ = occupiedCells([{ x: 6, y: 4 }])
    const moves = moveDestinations(flatBoard(), { x: 4, y: 4 }, rook, 'blue', occ)
    expect(moves).toContainEqual({ x: 5, y: 4 })
    expect(moves).not.toContainEqual({ x: 6, y: 4 })
    expect(moves).not.toContainEqual({ x: 7, y: 4 })
  })

  it('ignoreOccupancy lets planning routes pass through pieces', () => {
    const occ = occupiedCells([{ x: 6, y: 4 }])
    const moves = moveDestinations(flatBoard(), { x: 4, y: 4 }, rook, 'blue', occ, true)
    expect(moves).toContainEqual({ x: 7, y: 4 })
  })

  it('leaps are filtered only by bounds and passability', () => {
    const moves = moveDestinations(flatBoard(), { x: 0, y: 0 }, knight, 'blue')
    expect(moves).toEqual(expect.arrayContaining([{ x: 1, y: 2 }, { x: 2, y: 1 }]))
    expect(moves).toHaveLength(2)
  })

  it('pawn steps flip with the team', () => {
    expect(moveDestinations(flatBoard(), { x: 3, y: 3 }, pawnMove, 'blue')).toEqual([{ x: 3, y: 2 }])
    expect(moveDestinations(flatBoard(), { x: 3, y: 3 }, pawnMove, 'red')).toEqual([{ x: 3, y: 4 }])
  })

  it('a pawn may take a two-square first move from its home rank', () => {
    const board = flatBoard(8)
    // Blue home is rank 2 (y = 6); red home is rank 7 (y = 1).
    expect(moveDestinations(board, { x: 3, y: 6 }, pawnMove, 'blue')).toEqual([
      { x: 3, y: 5 },
      { x: 3, y: 4 },
    ])
    expect(moveDestinations(board, { x: 3, y: 1 }, pawnMove, 'red')).toEqual([
      { x: 3, y: 2 },
      { x: 3, y: 3 },
    ])
  })

  it('the pawn double step is stopped by a piece on the first square', () => {
    const occ = occupiedCells([{ x: 3, y: 5 }])
    expect(moveDestinations(flatBoard(8), { x: 3, y: 6 }, pawnMove, 'blue', occ)).toEqual([])
  })

  it('an off-home pawn only advances one square', () => {
    expect(moveDestinations(flatBoard(8), { x: 3, y: 5 }, pawnMove, 'blue')).toEqual([{ x: 3, y: 4 }])
  })

  it('walls stop slides', () => {
    const board = flatBoard()
    board.setTerrain(4, 2, 4)
    const moves = moveDestinations(board, { x: 4, y: 4 }, rook, 'blue')
    expect(moves).toContainEqual({ x: 4, y: 3 })
    expect(moves).not.toContainEqual({ x: 4, y: 2 })
  })
})

describe('fireCells', () => {
  it('includes the first piece as a hittable target, but nothing beyond', () => {
    const occ = occupiedCells([{ x: 3, y: 0 }])
    const fires = fireCells(flatBoard(), { x: 0, y: 0 }, rook, 'blue', occ)
    expect(fires).toContainEqual({ x: 3, y: 0 })
    expect(fires).not.toContainEqual({ x: 4, y: 0 })
  })

  it('walls block vision and are not themselves targeting cells', () => {
    const board = flatBoard()
    board.setTerrain(2, 0, 4)
    const fires = fireCells(board, { x: 0, y: 0 }, rook, 'blue')
    expect(fires).toContainEqual({ x: 1, y: 0 })
    expect(fires).not.toContainEqual({ x: 2, y: 0 })
  })

  it('leaps ignore blockers', () => {
    const fires = fireCells(flatBoard(), { x: 0, y: 0 }, knight, 'blue', occupiedCells([{ x: 0, y: 1 }]))
    expect(fires).toContainEqual({ x: 1, y: 2 })
    expect(fires).toContainEqual({ x: 2, y: 1 })
  })

  it('a pawn fires its two forward diagonals', () => {
    const fires = fireCells(flatBoard(), { x: 3, y: 3 }, pawn, 'blue')
    expect(fires).toEqual(expect.arrayContaining([{ x: 4, y: 2 }, { x: 2, y: 2 }]))
    expect(fires).toHaveLength(2)
  })
})

describe('lineClear', () => {
  it('is clear with an empty line and blocked by walls/pieces', () => {
    const board = flatBoard()
    expect(lineClear(board, { x: 0, y: 0 }, { x: 3, y: 0 })).toBe(true)
    expect(lineClear(board, { x: 0, y: 0 }, { x: 3, y: 0 }, occupiedCells([{ x: 1, y: 0 }]))).toBe(false)
    board.setTerrain(2, 0, 4)
    expect(lineClear(board, { x: 0, y: 0 }, { x: 3, y: 0 })).toBe(false)
  })

  it('ignores occupancy on the end cell unless includeEnds is set', () => {
    const occ = occupiedCells([{ x: 3, y: 0 }])
    expect(lineClear(flatBoard(), { x: 0, y: 0 }, { x: 3, y: 0 }, occ)).toBe(true)
    expect(lineClear(flatBoard(), { x: 0, y: 0 }, { x: 3, y: 0 }, occ, true)).toBe(false)
  })
})

describe('attackApproachCells', () => {
  it('returns the cells from which the weapon covers the target', () => {
    const cells = attackApproachCells(flatBoard(), { x: 4, y: 4 }, rook, 'blue')
    expect(cells).toEqual(
      expect.arrayContaining([{ x: 3, y: 4 }, { x: 5, y: 4 }, { x: 4, y: 3 }, { x: 4, y: 5 }]),
    )
  })

  it('approaches a pawn target from the side it fires toward', () => {
    const cells = attackApproachCells(flatBoard(), { x: 4, y: 4 }, pawn, 'blue')
    expect(cells).toEqual(expect.arrayContaining([{ x: 3, y: 5 }, { x: 5, y: 5 }]))
    expect(cells).toHaveLength(2)
  })
})

describe('containsCell', () => {
  it('matches by exact coordinates', () => {
    expect(containsCell([{ x: 1, y: 2 }], 1, 2)).toBe(true)
    expect(containsCell([{ x: 1, y: 2 }], 2, 1)).toBe(false)
  })
})
