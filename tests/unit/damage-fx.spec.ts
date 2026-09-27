import { beforeEach, describe, expect, it } from 'vitest'
import type { EventRecord } from '../../src/ecs/events'
import { createPiece } from '../../src/game/factory'
import { PIECES } from '../../src/game/pieces'
import damage from '../../src/ecs/systems/damage'
import type { SimContext } from '../../src/ecs/types'
import { clearComponents, makeContext } from '../helpers'

/** One damaging command, returning the `damage` event it emitted. */
function hit(ctx: SimContext, target: number, amount: number): EventRecord {
  const events: EventRecord[] = []
  const unsub = ctx.bus.subscribe((e) => events.push(e))
  ctx.cmds.damage.push({ target, source: null, amount, kind: 'projectile' })
  damage.update(ctx)
  unsub()
  const event = events.find((e) => e.type === 'damage')
  expect(event).toBeDefined()
  return event!
}

describe('damage system — hit feedback payload', () => {
  beforeEach(() => clearComponents())

  it('carries a scaled hitFx payload for a significant non-lethal hit', () => {
    const ctx = makeContext()
    const target = createPiece(ctx, 'blue', PIECES.pawn, { x: 4, y: 3 })

    // 30 of a pawn's 42 HP (~71%) is a significant hit.
    const event = hit(ctx, target, 30)
    const fx = event.data?.hitFx as { severity: number; target: number } | undefined
    expect(fx).toBeDefined()
    expect(fx!.target).toBe(target)
    expect(fx!.severity).toBeGreaterThan(0.6)
  })

  it('fires for the reported turn-4 pawn hits (12 then 11 of 42 HP)', () => {
    const ctx = makeContext()
    const target = createPiece(ctx, 'blue', PIECES.pawn, { x: 4, y: 4 })

    expect(hit(ctx, target, 12).data?.hitFx).toBeDefined()
    expect(hit(ctx, target, 11).data?.hitFx).toBeDefined()
  })

  it('omits the payload for chip damage and killing blows', () => {
    const ctx = makeContext()
    const target = createPiece(ctx, 'blue', PIECES.queen, { x: 4, y: 4 })

    // 7 of a queen's 165 HP (~4%) is chip damage.
    expect(hit(ctx, target, 7).data?.hitFx).toBeNull()
    // A killing blow is left to the death explosion.
    expect(hit(ctx, target, 999).data?.hitFx).toBeNull()
  })
})
