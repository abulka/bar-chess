import type { EventRecord } from '../ecs/events'
import type { Entity } from '../ecs/world'
import {
  CAPTURE_ADVANCE_FX_COLOR,
  CAPTURE_ADVANCE_FX_RADIUS,
  CAPTURE_ADVANCE_FX_TTL,
  CHESS_TRACER_COLOR,
  CHESS_TRACER_TTL,
  DEATH_FX_COLOR,
  DEATH_FX_RADIUS_TILES,
  DEATH_FX_TTL,
  HIT_FX_COLOR,
  HIT_FX_MAX_ACTIVE,
  HIT_FX_MAX_RADIUS,
  HIT_FX_MIN_RADIUS,
  HIT_FX_TTL,
} from '../game/constants'

/**
 * A purely visual effect. Effects live outside the ECS world on purpose: they
 * are driven by simulation events but never affect the simulation, so cosmetic
 * changes can never invalidate a save or alter a replay.
 */
export interface FxEffect {
  kind: 'death' | 'capture' | 'hit' | 'tracer'
  /** World-space position in pixels. */
  x: number
  y: number
  /** For a tracer: the shot's origin in world-space pixels. */
  fromX?: number
  fromY?: number
  /** Radius in tiles, scaled by the renderer's board tile size. */
  radiusTiles: number
  color: string
  ttl: number
  maxTtl: number
  /** For a hit: the piece to flash/tremble (followed while it lives). */
  target: Entity | null
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * The render layer's pool of transient effects, populated from the event bus
 * (`explosion`, `advance`, `damage`) and aged by real frame time — so effects
 * animate and expire even while the simulation is paused.
 */
export class FxLayer {
  readonly effects: FxEffect[] = []

  /** Spawn effects from one simulation event. */
  handle(record: EventRecord): void {
    // A new game / loaded map should not inherit the previous board's effects.
    if (record.type === 'boot' || record.type === 'map') {
      this.clear()
      return
    }
    const data = record.data as Record<string, unknown> | undefined
    if (record.type === 'explosion') {
      const capture = data?.capture === true
      this.effects.push({
        kind: capture ? 'capture' : 'death',
        x: num(data?.x),
        y: num(data?.y),
        radiusTiles: num(data?.radiusTiles, capture ? CAPTURE_ADVANCE_FX_RADIUS : DEATH_FX_RADIUS_TILES),
        color: capture ? CAPTURE_ADVANCE_FX_COLOR : DEATH_FX_COLOR,
        ttl: capture ? CAPTURE_ADVANCE_FX_TTL : DEATH_FX_TTL,
        maxTtl: capture ? CAPTURE_ADVANCE_FX_TTL : DEATH_FX_TTL,
        target: null,
      })
      return
    }
    if (record.type === 'advance') {
      // A chess kill shows a tracer from the killer to the victim's square; an
      // ordinary capture shows the small red advance pulse.
      if (data?.chess === true) {
        this.effects.push({
          kind: 'tracer',
          x: num(data?.x),
          y: num(data?.y),
          fromX: num(data?.fromX),
          fromY: num(data?.fromY),
          radiusTiles: 0,
          color: typeof data?.color === 'string' ? data.color : CHESS_TRACER_COLOR,
          ttl: CHESS_TRACER_TTL,
          maxTtl: CHESS_TRACER_TTL,
          target: null,
        })
        return
      }
      this.effects.push({
        kind: 'capture',
        x: num(data?.x),
        y: num(data?.y),
        radiusTiles: CAPTURE_ADVANCE_FX_RADIUS,
        color: CAPTURE_ADVANCE_FX_COLOR,
        ttl: CAPTURE_ADVANCE_FX_TTL,
        maxTtl: CAPTURE_ADVANCE_FX_TTL,
        target: null,
      })
      return
    }
    if (record.type === 'damage') {
      const hit = data?.hitFx as { x?: unknown; y?: unknown; severity?: unknown; target?: unknown } | undefined
      if (!hit) return
      if (this.countHits() >= HIT_FX_MAX_ACTIVE) return
      const severity = Math.min(1, Math.max(0, num(hit.severity)))
      const radiusTiles =
        HIT_FX_MIN_RADIUS + (HIT_FX_MAX_RADIUS - HIT_FX_MIN_RADIUS) * Math.sqrt(severity)
      this.effects.push({
        kind: 'hit',
        x: num(hit.x),
        y: num(hit.y),
        radiusTiles,
        color: HIT_FX_COLOR,
        ttl: HIT_FX_TTL,
        maxTtl: HIT_FX_TTL,
        target: typeof hit.target === 'number' ? hit.target : null,
      })
    }
  }

  /** Advance effect lifetimes by `dt` seconds and drop the expired ones. */
  update(dt: number): void {
    if (this.effects.length === 0) return
    for (const fx of this.effects) fx.ttl -= dt
    for (let i = this.effects.length - 1; i >= 0; i--) {
      if (this.effects[i].ttl <= 0) this.effects.splice(i, 1)
    }
  }

  clear(): void {
    this.effects.length = 0
  }

  private countHits(): number {
    let n = 0
    for (const fx of this.effects) if (fx.kind === 'hit') n++
    return n
  }
}
