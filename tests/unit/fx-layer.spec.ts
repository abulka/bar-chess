import { describe, expect, it } from 'vitest'
import type { EventRecord, EventType } from '../../src/ecs/events'
import {
  CAPTURE_ADVANCE_FX_COLOR,
  DEATH_FX_COLOR,
  DEATH_FX_TTL,
  HIT_FX_COLOR,
  HIT_FX_MAX_ACTIVE,
} from '../../src/game/constants'
import { FxLayer } from '../../src/render/fx'

function event(type: EventType, data: Record<string, unknown>): EventRecord {
  return { seq: 1, tick: 0, phase: 'test', type, msg: '', data }
}

describe('FxLayer — render-only effects', () => {
  it('spawns a red death effect from an explosion event', () => {
    const fx = new FxLayer()
    fx.handle(event('explosion', { capture: false, radiusTiles: 1.6, x: 10, y: 20 }))

    expect(fx.effects).toHaveLength(1)
    expect(fx.effects[0]).toMatchObject({
      kind: 'death',
      color: DEATH_FX_COLOR,
      x: 10,
      y: 20,
      radiusTiles: 1.6,
    })
    expect(fx.effects[0].maxTtl).toBeCloseTo(DEATH_FX_TTL)
  })

  it('uses the capture pulse for a chess-rule kill', () => {
    const fx = new FxLayer()
    fx.handle(event('explosion', { capture: true, radiusTiles: 0.8, x: 0, y: 0 }))

    expect(fx.effects[0]).toMatchObject({ kind: 'capture', color: CAPTURE_ADVANCE_FX_COLOR })
  })

  it('adds an advance pulse for an ordinary capture but not a chess one', () => {
    const fx = new FxLayer()
    fx.handle(event('advance', { x: 1, y: 2, chess: false }))
    fx.handle(event('advance', { x: 3, y: 4, chess: true }))

    expect(fx.effects).toHaveLength(1)
    expect(fx.effects[0].kind).toBe('capture')
  })

  it('spawns a pink hit effect carrying the target', () => {
    const fx = new FxLayer()
    fx.handle(event('damage', { hitFx: { x: 5, y: 6, severity: 0.5, target: 42 } }))

    expect(fx.effects).toHaveLength(1)
    expect(fx.effects[0]).toMatchObject({ kind: 'hit', color: HIT_FX_COLOR, target: 42 })
  })

  it('ignores damage without a hitFx payload', () => {
    const fx = new FxLayer()
    fx.handle(event('damage', { amount: 3 }))
    expect(fx.effects).toHaveLength(0)
  })

  it('caps concurrent hit effects', () => {
    const fx = new FxLayer()
    for (let i = 0; i < HIT_FX_MAX_ACTIVE + 5; i++) {
      fx.handle(event('damage', { hitFx: { x: 0, y: 0, severity: 1, target: null } }))
    }
    expect(fx.effects.filter((e) => e.kind === 'hit')).toHaveLength(HIT_FX_MAX_ACTIVE)
  })

  it('ages effects by real time and drops expired ones', () => {
    const fx = new FxLayer()
    fx.handle(event('explosion', { x: 0, y: 0, radiusTiles: 1.6 }))

    fx.update(0.1)
    expect(fx.effects).toHaveLength(1)
    fx.update(1)
    expect(fx.effects).toHaveLength(0)
  })

  it('clears on a new game / loaded map', () => {
    const fx = new FxLayer()
    fx.handle(event('explosion', { x: 0, y: 0 }))
    fx.handle(event('map', {}))
    expect(fx.effects).toHaveLength(0)
  })
})
