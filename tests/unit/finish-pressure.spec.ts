import { beforeEach, describe, expect, it } from 'vitest'
import { Health } from '../../src/ecs/components'
import { createPiece } from '../../src/game/factory'
import { PIECES } from '../../src/game/pieces'
import damage from '../../src/ecs/systems/damage'
import type { SimContext } from '../../src/ecs/types'
import { clearComponents, makeContext } from '../helpers'

describe('damage system — finish pressure', () => {
  beforeEach(() => clearComponents())

  function hit(ctx: SimContext, target: number, amount = 20): number {
    const before = ctx.world.require(target, Health).cur
    ctx.cmds.damage.push({ target, source: null, amount, kind: 'projectile' })
    damage.update(ctx)
    return before - ctx.world.require(target, Health).cur
  }

  it('ramps damage to a king whose side has been king-only past the cap', () => {
    const ctx = makeContext()
    ctx.tick = 10_000
    const king = createPiece(ctx, 'red', PIECES.king, { x: 4, y: 0 })
    ctx.teams.red.kingOnlySince = 0

    const dealt = hit(ctx, king)

    expect(dealt).toBeGreaterThan(30) // base 20, doubled at the cap
  })

  it('leaves the king alone inside the grace period', () => {
    const ctx = makeContext()
    const king = createPiece(ctx, 'red', PIECES.king, { x: 4, y: 0 })
    ctx.teams.red.kingOnlySince = ctx.tick

    const dealt = hit(ctx, king)

    expect(dealt).toBeGreaterThanOrEqual(18)
    expect(dealt).toBeLessThanOrEqual(22)
  })

  it('does not ramp when the rule is off', () => {
    const ctx = makeContext({ finishPressure: false })
    ctx.tick = 10_000
    const king = createPiece(ctx, 'red', PIECES.king, { x: 4, y: 0 })
    ctx.teams.red.kingOnlySince = 0

    const dealt = hit(ctx, king)

    expect(dealt).toBeGreaterThanOrEqual(18)
    expect(dealt).toBeLessThanOrEqual(22)
  })

  it('never ramps a king whose side still has field pieces', () => {
    const ctx = makeContext()
    const king = createPiece(ctx, 'red', PIECES.king, { x: 4, y: 0 })
    expect(ctx.teams.red.kingOnlySince).toBe(-1)

    const dealt = hit(ctx, king)

    expect(dealt).toBeGreaterThanOrEqual(18)
    expect(dealt).toBeLessThanOrEqual(22)
  })
})
