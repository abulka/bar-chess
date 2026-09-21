import { describe, expect, it } from 'vitest'
import { WEAPONS } from '../../src/game/pieces'
import { firingLine, routePolyline } from '../../src/render/overlays'
import { flatBoard, occupiedCells } from '../helpers'

const TILE = 48
const center = (x: number, y: number) => ({ x: (x + 0.5) * TILE, y: (y + 0.5) * TILE })

describe('routePolyline', () => {
  it('returns cell centres in path order', () => {
    const board = flatBoard()
    expect(routePolyline(board, [{ x: 4, y: 4 }, { x: 4, y: 5 }, { x: 5, y: 5 }])).toEqual([
      center(4, 4),
      center(4, 5),
      center(5, 5),
    ])
  })
})

describe('firingLine', () => {
  const queen = WEAPONS.queenNova.geometry
  const knight = WEAPONS.knightBomb.geometry

  it('clear shot: one solid segment from firing cell to target', () => {
    const board = flatBoard()
    const line = firingLine(board, { x: 4, y: 4 }, { x: 4, y: 6 }, queen, 'blue', true, occupiedCells([]))

    expect(line.kind).toBe('clear')
    expect(line.clear).toBe(true)
    expect(line.blocker).toBeNull()
    expect(line.segments).toEqual([{ from: center(4, 4), to: center(4, 6), dashed: false }])
  })

  it('blocked by a piece: solid up to the blocker, dashed beyond', () => {
    const board = flatBoard()
    const occ = occupiedCells([{ x: 4, y: 5 }])
    const line = firingLine(board, { x: 4, y: 4 }, { x: 4, y: 6 }, queen, 'blue', true, occ)

    expect(line.kind).toBe('blocked')
    expect(line.clear).toBe(false)
    expect(line.blocker).toEqual(center(4, 5))
    expect(line.segments).toEqual([
      { from: center(4, 4), to: center(4, 5), dashed: false },
      { from: center(4, 5), to: center(4, 6), dashed: true },
    ])
  })

  it('blocked by a wall: walls also pin the solid/dashed boundary', () => {
    const board = flatBoard()
    board.setTerrain(4, 5, 4)
    const line = firingLine(board, { x: 4, y: 4 }, { x: 4, y: 6 }, queen, 'blue', true, occupiedCells([]))

    expect(line.kind).toBe('blocked')
    expect(line.blocker).toEqual(center(4, 5))
    expect(line.segments.map((s) => s.dashed)).toEqual([false, true])
  })

  it('reachable but off-line (no straight blocker): a single dashed segment', () => {
    const board = flatBoard()
    const line = firingLine(board, { x: 0, y: 0 }, { x: 2, y: 1 }, queen, 'blue', true, occupiedCells([]))

    expect(line.kind).toBe('blocked')
    expect(line.blocker).toBeNull()
    expect(line.segments).toEqual([{ from: center(0, 0), to: center(2, 1), dashed: true }])
  })

  it('unreachable: a single dashed grey segment, no clear flag', () => {
    const board = flatBoard()
    const line = firingLine(board, { x: 4, y: 4 }, { x: 4, y: 6 }, queen, 'blue', false, occupiedCells([]))

    expect(line.kind).toBe('unreachable')
    expect(line.clear).toBe(false)
    expect(line.blocker).toBeNull()
    expect(line.segments).toEqual([{ from: center(4, 4), to: center(4, 6), dashed: true }])
  })

  it('leapers fire over blockers: clear even when a cell in between is occupied', () => {
    const board = flatBoard()
    const occ = occupiedCells([{ x: 0, y: 1 }])
    const line = firingLine(board, { x: 0, y: 0 }, { x: 1, y: 2 }, knight, 'blue', true, occ)

    expect(line.kind).toBe('clear')
    expect(line.segments).toHaveLength(1)
    expect(line.segments[0].dashed).toBe(false)
  })
})
