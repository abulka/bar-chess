import { describe, expect, it } from 'vitest'
import { Board, TERRAIN } from '../../src/game/board'
import { createBoardData, initialArmy } from '../../src/game/boards'
import { flatBoard } from '../helpers'

describe('Board', () => {
  it('reports bounds, passability and vision per terrain', () => {
    const board = flatBoard()
    expect(board.passable(0, 0)).toBe(true)
    expect(board.blocksVision(0, 0)).toBe(false)
    expect(board.inBounds(-1, 0)).toBe(false)
    expect(board.inBounds(0, 8)).toBe(false)

    board.setTerrain(1, 1, TERRAIN.wall)
    expect(board.passable(1, 1)).toBe(false)
    expect(board.blocksVision(1, 1)).toBe(true)

    board.setTerrain(2, 2, TERRAIN.water)
    expect(board.passable(2, 2)).toBe(false)
    expect(board.blocksVision(2, 2)).toBe(false)
  })

  it('converts between world pixels and cells', () => {
    const board = flatBoard()
    expect(board.tile).toBe(48)
    expect(board.cellCenter(0, 0)).toEqual({ x: 24, y: 24 })
    expect(board.worldToCell(board.tile * 3 + 1, board.tile * 2 + 1)).toEqual({ x: 3, y: 2 })
    expect(board.pixelWidth).toBe(384)
  })
})

describe('createBoardData / initialArmy', () => {
  it('builds a square map with the requested size', () => {
    const board = new Board(createBoardData(8))
    expect(board.width).toBe(8)
    expect(board.height).toBe(8)
    expect(board.laneCells('blue')).toHaveLength(8)
  })

  it('places a full army on passable cells', () => {
    const board = new Board(createBoardData(8))
    const army = initialArmy(8)
    expect(army.filter((p) => p.team === 'red')).toHaveLength(16)
    expect(army.filter((p) => p.team === 'blue')).toHaveLength(16)
    for (const p of army) {
      expect(board.inBounds(p.x, p.y)).toBe(true)
      expect(board.passable(p.x, p.y)).toBe(true)
    }
  })
})
