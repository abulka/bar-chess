import { describe, expect, it } from 'vitest'
import { closestEmptyCell, firingPositionExists, previewFiringCell } from '../../src/game/approach'
import { PIECES, WEAPONS } from '../../src/game/pieces'
import { flatBoard, occupiedCells } from '../helpers'

const bishopMove = PIECES.bishop.move
const bishopWeapon = WEAPONS.bishopLance.geometry
const rookMove = PIECES.rook.move
const rookWeapon = WEAPONS.rookShell.geometry
const knightMove = PIECES.knight.move
const knightWeapon = WEAPONS.knightBomb.geometry

describe('firingPositionExists', () => {
  it('is true when a firing square is reachable on the piece colour', () => {
    expect(firingPositionExists(flatBoard(), { x: 0, y: 0 }, { x: 3, y: 3 }, bishopMove, bishopWeapon, 'blue')).toBe(true)
  })

  it('is false when the target is positionally impossible (bishop, other colour)', () => {
    expect(firingPositionExists(flatBoard(), { x: 0, y: 0 }, { x: 1, y: 0 }, bishopMove, bishopWeapon, 'blue')).toBe(false)
  })
})

describe('previewFiringCell', () => {
  it('picks the reachable firing cell minimising total travel', () => {
    const occ = occupiedCells([{ x: 4, y: 0 }])
    const cell = previewFiringCell(flatBoard(), { x: 0, y: 0 }, { x: 4, y: 0 }, rookMove, rookWeapon, 'blue', occ)
    expect(cell).toEqual({ x: 2, y: 0 })
  })

  it('prefers the firing cell reached in fewest moves for a knight', () => {
    // Knight on c3 ordered at the pawn on d7. c5/f6 (both two hops) are blocked,
    // leaving b6 (two hops). The Euclidean-nearest firing cell e5 is four hops.
    const occ = occupiedCells([{ x: 2, y: 3 }, { x: 5, y: 2 }])
    const cell = previewFiringCell(flatBoard(), { x: 2, y: 5 }, { x: 3, y: 1 }, knightMove, knightWeapon, 'blue', occ)
    expect(cell).toEqual({ x: 1, y: 2 }) // b6
  })
})

describe('closestEmptyCell', () => {
  it('returns an empty passable cell, never the target itself', () => {
    const cell = closestEmptyCell(
      flatBoard(),
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      rookMove,
      'blue',
      occupiedCells([{ x: 4, y: 0 }]),
    )
    expect(cell).not.toBeNull()
    expect(cell).not.toEqual({ x: 4, y: 0 })
  })
})
