import { describe, expect, it } from 'vitest'
import {
  attackPlan,
  closestEmptyCell,
  firingPositionExists,
  inFiringGeometry,
  previewFiringCell,
} from '../../src/game/approach'
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

  it('holds on the current square when it already ties for closest', () => {
    const board = flatBoard()
    // The reported g6↔h7 shuttle: a bishop chasing an opposite-colour target on
    // h6 has two equidistant nearest squares. From either one it must hold, not
    // hop to the tied twin.
    const occ = occupiedCells([])
    expect(closestEmptyCell(board, { x: 6, y: 2 }, { x: 7, y: 2 }, bishopMove, 'blue', occ)).toEqual({ x: 6, y: 2 })
    expect(closestEmptyCell(board, { x: 7, y: 1 }, { x: 7, y: 2 }, bishopMove, 'blue', occ)).toEqual({ x: 7, y: 1 })
  })
})

describe('inFiringGeometry', () => {
  it('is true when the target sits on a cell the weapon covers from here', () => {
    expect(
      inFiringGeometry(flatBoard(), { x: 0, y: 0 }, { x: 3, y: 0 }, rookWeapon, 'blue', occupiedCells([])),
    ).toBe(true)
  })

  it('is false on a square the weapon does not cover', () => {
    expect(
      inFiringGeometry(flatBoard(), { x: 0, y: 0 }, { x: 3, y: 3 }, rookWeapon, 'blue', occupiedCells([])),
    ).toBe(false)
  })
})

describe('attackPlan', () => {
  it('holds when the target is already in weapon geometry', () => {
    const board = flatBoard()
    const plan = attackPlan(board, { x: 0, y: 0 }, { x: 3, y: 0 }, rookMove, rookWeapon, 'blue', occupiedCells([]))
    expect(plan.inRange).toBe(true)
    expect(plan.reachable).toBe(true)
  })

  it('routes to a reachable firing cell when out of range', () => {
    const board = flatBoard()
    // Diagonal target: not on the rook's rank/file from (0,0), but reachable.
    const plan = attackPlan(board, { x: 0, y: 0 }, { x: 4, y: 4 }, rookMove, rookWeapon, 'blue', occupiedCells([]))
    expect(plan.inRange).toBe(false)
    expect(plan.reachable).toBe(true)
    expect(plan.cell).not.toEqual({ x: 4, y: 4 })
  })

  it('falls back to the closest empty cell when the target is positionally unreachable', () => {
    const board = flatBoard()
    // Bishop never reaches the opposite colour, so the goal is merely near it.
    const plan = attackPlan(board, { x: 0, y: 0 }, { x: 1, y: 0 }, bishopMove, bishopWeapon, 'blue', occupiedCells([]))
    expect(plan.reachable).toBe(false)
    expect(plan.inRange).toBe(false)
    expect(plan.cell).not.toEqual({ x: 1, y: 0 })
    expect(plan.cell).not.toBeNull()
  })

  it('parks on the spot when an unreachable target is already as close as possible', () => {
    const board = flatBoard()
    // Bishop on g6, target on the opposite-colour h6: g6 is already a nearest
    // square, so the goal is the piece's own cell (hold) rather than h7.
    const plan = attackPlan(board, { x: 6, y: 2 }, { x: 7, y: 2 }, bishopMove, bishopWeapon, 'blue', occupiedCells([]))
    expect(plan.reachable).toBe(false)
    expect(plan.inRange).toBe(false)
    expect(plan.cell).toEqual({ x: 6, y: 2 })
  })
})
