import { beforeEach, describe, expect, it } from 'vitest'
import { Cell, Target } from '../../src/ecs/components'
import type { SimContext } from '../../src/ecs/types'
import { World } from '../../src/ecs/world'
import { createPiece } from '../../src/game/factory'
import { buildOccupancy } from '../../src/game/occupancy'
import { PIECES } from '../../src/game/pieces'
import { Rng } from '../../src/game/rng'
import { underFireAttacker } from '../../src/game/underFire'
import { clearComponents, flatBoard } from '../helpers'

function makeWorld(): { board: ReturnType<typeof flatBoard>; world: World; ctx: SimContext } {
  const board = flatBoard(8)
  const world = new World()
  const rng = new Rng(1)
  return { board, world, ctx: { world, board, rng } as unknown as SimContext }
}

function report(world: World, board: ReturnType<typeof flatBoard>, e: number, tick = 10): number | null {
  return underFireAttacker(world, board, buildOccupancy(world, board), e, tick)
}

describe('underFireAttacker', () => {
  beforeEach(() => clearComponents())

  it('reports the last attacker while it still covers the piece', () => {
    const { board, world, ctx } = makeWorld()
    const bishop = createPiece(ctx, 'blue', PIECES.bishop, { x: 2, y: 2 })
    const rook = createPiece(ctx, 'red', PIECES.rook, { x: 2, y: 7 })
    const target = world.require(bishop, Target)
    target.lastAttacker = rook
    target.underFireUntil = 90

    expect(report(world, board, bishop)).toBe(rook)
  })

  it('clears once the piece steps off the firing line', () => {
    const { board, world, ctx } = makeWorld()
    const bishop = createPiece(ctx, 'blue', PIECES.bishop, { x: 2, y: 2 })
    const rook = createPiece(ctx, 'red', PIECES.rook, { x: 2, y: 7 })
    const target = world.require(bishop, Target)
    target.lastAttacker = rook
    target.underFireUntil = 90
    expect(report(world, board, bishop)).toBe(rook)

    world.require(bishop, Cell).x = 3

    expect(report(world, board, bishop)).toBeNull()
  })

  it('clears when a body blocks the line', () => {
    const { board, world, ctx } = makeWorld()
    const bishop = createPiece(ctx, 'blue', PIECES.bishop, { x: 2, y: 2 })
    const rook = createPiece(ctx, 'red', PIECES.rook, { x: 2, y: 7 })
    const target = world.require(bishop, Target)
    target.lastAttacker = rook
    target.underFireUntil = 90
    expect(report(world, board, bishop)).toBe(rook)

    createPiece(ctx, 'red', PIECES.pawn, { x: 2, y: 4 })

    expect(report(world, board, bishop)).toBeNull()
  })

  it('clears once the fire window elapses or the attacker dies', () => {
    const { board, world, ctx } = makeWorld()
    const bishop = createPiece(ctx, 'blue', PIECES.bishop, { x: 2, y: 2 })
    const rook = createPiece(ctx, 'red', PIECES.rook, { x: 2, y: 7 })
    const target = world.require(bishop, Target)
    target.lastAttacker = rook
    target.underFireUntil = 90

    expect(report(world, board, bishop, 90)).toBeNull()

    target.underFireUntil = 500
    world.destroy(rook)
    expect(report(world, board, bishop)).toBeNull()
  })
})
