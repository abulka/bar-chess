import { describe, expect, it } from 'vitest'
import { findPath, reachableCells } from '../../src/game/pathfind'
import { PIECES, WEAPONS } from '../../src/game/pieces'
import { flatBoard, occupiedCells } from '../helpers'

const rook = WEAPONS.rookShell.geometry
const pawnMove = PIECES.pawn.move

describe('findPath', () => {
  it('treats a whole slide as one edge (a clear rook reaches the goal directly)', () => {
    const result = findPath(flatBoard(), { x: 0, y: 0 }, { x: 0, y: 3 }, rook, 'blue')
    expect(result.found).toBe(true)
    expect(result.cells).toEqual([{ x: 0, y: 3 }])
  })

  it('routes around an occupied cell', () => {
    const occ = occupiedCells([{ x: 0, y: 1 }])
    const result = findPath(flatBoard(), { x: 0, y: 0 }, { x: 0, y: 3 }, rook, 'blue', occ)
    expect(result.found).toBe(true)
    expect(result.cells).not.toContainEqual({ x: 0, y: 1 })
    expect(result.cells[result.cells.length - 1]).toEqual({ x: 0, y: 3 })
  })

  it('takes a two-square pawn first move as a single hop', () => {
    const result = findPath(flatBoard(8), { x: 3, y: 6 }, { x: 3, y: 4 }, pawnMove, 'blue')
    expect(result.found).toBe(true)
    expect(result.cells).toEqual([{ x: 3, y: 4 }])
  })

  it('returns a best-effort partial route when the goal is impossible', () => {
    // A pawn ordered to an off-file square marches up its own file.
    const result = findPath(flatBoard(), { x: 3, y: 7 }, { x: 4, y: 5 }, pawnMove, 'blue')
    expect(result.found).toBe(false)
    expect(result.cells[result.cells.length - 1]).toEqual({ x: 3, y: 5 })
  })

  it('cannot cross a complete wall', () => {
    const board = flatBoard()
    for (let y = 0; y < board.height; y++) board.setTerrain(3, y, 4)
    const result = findPath(board, { x: 0, y: 0 }, { x: 7, y: 0 }, rook, 'blue')
    expect(result.found).toBe(false)
    expect(result.cells[result.cells.length - 1]).toEqual({ x: 2, y: 0 })
  })
})

describe('reachableCells', () => {
  it('flood-fills the movement geometry, respecting colour and walls', () => {
    const seen = reachableCells(flatBoard(), { x: 4, y: 4 }, PIECES.bishop.move, 'blue')
    expect(seen[4 * 8 + 4]).toBe(1)
    expect(seen[0 * 8 + 0]).toBe(1)
    expect(seen[0 * 8 + 1]).toBe(0)
  })

  it('memoizes identical queries', () => {
    const board = flatBoard()
    const first = reachableCells(board, { x: 0, y: 0 }, PIECES.rook.move, 'blue')
    const second = reachableCells(board, { x: 0, y: 0 }, PIECES.rook.move, 'blue')
    expect(second).toBe(first)
  })

  it('invalidates when the terrain changes on the same board', () => {
    const board = flatBoard()
    const before = reachableCells(board, { x: 0, y: 0 }, PIECES.rook.move, 'blue')
    expect(before[1]).toBe(1)

    board.setTerrain(1, 0, 4)
    board.setTerrain(0, 1, 4)
    const after = reachableCells(board, { x: 0, y: 0 }, PIECES.rook.move, 'blue')

    expect(after).not.toBe(before)
    expect(after[1]).toBe(0)
  })

  it('does not leak between different boards', () => {
    const first = reachableCells(flatBoard(), { x: 0, y: 0 }, PIECES.rook.move, 'blue')
    const second = reachableCells(flatBoard(), { x: 0, y: 0 }, PIECES.rook.move, 'blue')
    expect(second).not.toBe(first)
  })
})
