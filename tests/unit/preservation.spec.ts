import { beforeEach, describe, expect, it } from 'vitest'
import { buildOccupancy } from '../../src/game/occupancy'
import { createPiece } from '../../src/game/factory'
import { PIECES } from '../../src/game/pieces'
import { coverageThreats, escapeGoal } from '../../src/ecs/systems/preservation'
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
