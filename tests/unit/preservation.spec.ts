import { beforeEach, describe, expect, it } from 'vitest'
import { Health } from '../../src/ecs/components'
import { buildOccupancy } from '../../src/game/occupancy'
import { createPiece } from '../../src/game/factory'
import { PIECES } from '../../src/game/pieces'
import { coverageThreats, escapeGoal, lethalAvoid, pieceDanger } from '../../src/ecs/systems/preservation'
import { clearComponents, makeContext } from '../helpers'

describe('escapeGoal — anti-dither scoring', () => {
  beforeEach(() => clearComponents())

  function setup(): {
    ctx: ReturnType<typeof makeContext>
    queen: number
    threats: ReturnType<typeof coverageThreats>
  } {
    const ctx = makeContext()
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 4, y: 4 })
    createPiece(ctx, 'red', PIECES.rook, { x: 4, y: 0 }) // covers the c-file
    ctx.occupancy = buildOccupancy(ctx.world, ctx.board)
    const threats = coverageThreats(ctx, queen, 'blue', new Map(), { proximityRadius: 6 })
    return { ctx, queen, threats }
  }

  it('prefers a committed goal over an equal-danger alternative', () => {
    const { ctx, queen, threats } = setup()
    const plain = escapeGoal(ctx, queen, 'blue', threats, null)
    expect(plain).not.toBeNull()
    // An adjacent, equally safe off-file square (the queen may slide diagonally).
    const stickyCell = { x: 3, y: 3 }
    expect(stickyCell).not.toEqual(plain)
    const committed = escapeGoal(ctx, queen, 'blue', threats, null, { sticky: stickyCell })
    expect(committed).toEqual(stickyCell)
  })

  it('does not immediately step back onto the square it just left', () => {
    const { ctx, queen, threats } = setup()
    const plain = escapeGoal(ctx, queen, 'blue', threats, null)
    expect(plain).not.toBeNull()
    const retraced = escapeGoal(ctx, queen, 'blue', threats, null, { prevCell: plain })
    expect(retraced).not.toEqual(plain)
  })
})

describe('pieceDanger — lethal enemy fire per square', () => {
  beforeEach(() => clearComponents())

  /** A blue queen on e4 and a red rook on the e-file (20 damage). */
  function setup(hp: number): { ctx: ReturnType<typeof makeContext>; queen: number } {
    const ctx = makeContext()
    const queen = createPiece(ctx, 'blue', PIECES.queen, { x: 4, y: 4 })
    createPiece(ctx, 'red', PIECES.rook, { x: 4, y: 0 })
    ctx.occupancy = buildOccupancy(ctx.world, ctx.board)
    ctx.world.require(queen, Health).cur = hp
    return { ctx, queen }
  }

  it('sums covering damage and marks a square lethal at or above current HP', () => {
    const { ctx, queen } = setup(15)
    const danger = pieceDanger(ctx, queen, 'blue')
    expect(danger.danger(4, 5)).toBe(20)
    expect(danger.lethal(4, 5)).toBe(true)
    expect(danger.lethal(3, 4)).toBe(false)
  })

  it('does not mark a square lethal when the piece can absorb the volley', () => {
    const { ctx, queen } = setup(165)
    expect(pieceDanger(ctx, queen, 'blue').lethal(4, 5)).toBe(false)
  })

  it('exposes the kill zone through lethalAvoid', () => {
    const { ctx, queen } = setup(15)
    const avoid = lethalAvoid(ctx, pieceDanger(ctx, queen, 'blue'))
    expect(avoid(4, 5)).toBe(true)
    expect(avoid(3, 4)).toBe(false)
  })

  it('sees a short-range king that covers the next square, not the current one', () => {
    const ctx = makeContext()
    const queen = createPiece(ctx, 'red', PIECES.queen, { x: 6, y: 7 }) // g1
    createPiece(ctx, 'blue', PIECES.king, { x: 4, y: 6 }) // e2, guard range 1
    ctx.occupancy = buildOccupancy(ctx.world, ctx.board)
    ctx.world.require(queen, Health).cur = 42 // a wounded promoted queen
    const danger = pieceDanger(ctx, queen, 'red')
    // e3 (4,5) is adjacent to the king and fatal; the queen's current g1 is not
    // reachable by the king, which is exactly why a distance cut based on g1
    // would wrongly hide it.
    expect(danger.danger(4, 5)).toBeGreaterThanOrEqual(132)
    expect(danger.lethal(4, 5)).toBe(true)
    expect(danger.lethal(6, 7)).toBe(false)
  })
})
