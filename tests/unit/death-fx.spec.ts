import { beforeEach, describe, expect, it } from 'vitest'
import { ChessKill, Dead, Fx } from '../../src/ecs/components'
import { createPiece } from '../../src/game/factory'
import { PIECES } from '../../src/game/pieces'
import death from '../../src/ecs/systems/death'
import { clearComponents, makeContext } from '../helpers'

describe('death explosion fx', () => {
  beforeEach(() => clearComponents())

  function spawnDead(): ReturnType<typeof makeContext> {
    const ctx = makeContext({ captureAdvance: true })
    const victim = createPiece(ctx, 'red', PIECES.pawn, { x: 2, y: 2 })
    ctx.world.add(victim, Dead, true)
    return ctx
  }

  it('uses the standard blast for an ordinary kill', () => {
    const ctx = spawnDead()
    death.update(ctx)

    const fx = ctx.world.require(ctx.world.query(Fx)[0], Fx)
    expect(fx.maxTtl).toBeCloseTo(0.5)
    expect(fx.capture).toBe(false)
  })

  it('keeps the standard blast even when a capture advance follows', () => {
    const ctx = spawnDead()
    const victim = ctx.world.query(Dead)[0]
    ctx.cmds.advance.push({ killer: 999, victim, cell: { x: 2, y: 2 } })

    death.update(ctx)

    const fx = ctx.world.require(ctx.world.query(Fx)[0], Fx)
    expect(fx.capture).toBe(false)
  })

  it('uses a small, quick red pulse for a chess kill', () => {
    const ctx = spawnDead()
    const victim = ctx.world.query(Dead)[0]
    ctx.world.add(victim, ChessKill, true)

    death.update(ctx)

    const fx = ctx.world.require(ctx.world.query(Fx)[0], Fx)
    expect(fx.maxTtl).toBeCloseTo(0.75)
    expect(fx.radius).toBeLessThan(1.6 * ctx.board.tile)
    expect(fx.capture).toBe(true)
    expect(fx.color).toBe('#ff3b30')
  })
})
