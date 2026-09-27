import { beforeEach, describe, expect, it } from 'vitest'
import { ChessKill, Dead } from '../../src/ecs/components'
import { CAPTURE_ADVANCE_FX_RADIUS, DEATH_FX_RADIUS_TILES } from '../../src/game/constants'
import type { EventRecord } from '../../src/ecs/events'
import { createPiece } from '../../src/game/factory'
import { PIECES } from '../../src/game/pieces'
import death from '../../src/ecs/systems/death'
import { clearComponents, makeContext } from '../helpers'

describe('death system — explosion events (render-only fx)', () => {
  beforeEach(() => clearComponents())

  function explode(chess: boolean): EventRecord | undefined {
    const ctx = makeContext({ captureAdvance: true })
    const victim = createPiece(ctx, 'red', PIECES.pawn, { x: 2, y: 2 })
    ctx.world.add(victim, Dead, true)
    if (chess) ctx.world.add(victim, ChessKill, true)
    const events: EventRecord[] = []
    ctx.bus.subscribe((e) => events.push(e))
    death.update(ctx)
    return events.find((e) => e.type === 'explosion')
  }

  it('emits a standard red explosion at the victim position', () => {
    const event = explode(false)
    expect(event).toBeDefined()
    expect(event!.entity).toBeDefined()
    expect(event!.data).toMatchObject({ capture: false, radiusTiles: DEATH_FX_RADIUS_TILES })
    expect(typeof event!.data!.x).toBe('number')
    expect(typeof event!.data!.y).toBe('number')
  })

  it('emits a smaller capture pulse for a chess-rule kill', () => {
    const event = explode(true)
    expect(event).toBeDefined()
    expect(event!.data).toMatchObject({ capture: true, radiusTiles: CAPTURE_ADVANCE_FX_RADIUS })
  })

  it('destroys the victim', () => {
    const ctx = makeContext({ captureAdvance: true })
    const victim = createPiece(ctx, 'red', PIECES.pawn, { x: 2, y: 2 })
    ctx.world.add(victim, Dead, true)
    death.update(ctx)
    expect(ctx.cmds.destroy).toContain(victim)
  })
})
