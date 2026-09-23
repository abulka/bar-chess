import type { Entity } from './world'
import type { TeamId } from '../game/types'

export type EventType =
  | 'boot'
  | 'map'
  | 'phase'
  | 'spawn'
  | 'deploy'
  | 'target'
  | 'ai'
  | 'path'
  | 'move'
  | 'advance'
  | 'shot'
  | 'hit'
  | 'miss'
  | 'damage'
  | 'kill'
  | 'explosion'
  | 'cleanup'
  | 'win'
  | 'info'
  | 'warn'

export interface EventRecord {
  seq: number
  tick: number
  phase: string
  type: EventType
  msg: string
  entity?: Entity
  team?: TeamId
  data?: Record<string, unknown>
}

export interface EmitOptions {
  entity?: Entity
  team?: TeamId
  data?: Record<string, unknown>
}

/**
 * Central event bus. Every meaningful simulation transition is emitted here.
 * The collected records are what the "brain" log panel renders, so systems
 * should emit generously but avoid per-frame noise.
 */
export type EventListener = (record: EventRecord) => void

export class EventBus {
  private seq = 0
  private buffer: EventRecord[] = []
  private counts = new Map<EventType, number>()
  private listeners = new Set<EventListener>()

  total = 0
  tick = 0
  phase = 'boot'
  max: number

  constructor(max = 6000) {
    this.max = max
  }

  emit(type: EventType, msg: string, opts: EmitOptions = {}): void {
    this.total++
    const record: EventRecord = {
      seq: ++this.seq,
      tick: this.tick,
      phase: this.phase,
      type,
      msg,
    }
    if (opts.entity !== undefined) record.entity = opts.entity
    if (opts.team !== undefined) record.team = opts.team
    if (opts.data !== undefined) record.data = opts.data
    this.buffer.push(record)
    if (this.buffer.length > this.max) {
      this.buffer.splice(0, this.buffer.length - this.max)
    }
    this.counts.set(type, (this.counts.get(type) ?? 0) + 1)

    // Observers (audio, metrics, …) are read-only: a throwing listener must never
    // interrupt the simulation, so each is isolated.
    for (const listener of this.listeners) {
      try {
        listener(record)
      } catch {
        // Non-fatal: observability must not break the sim.
      }
    }
  }

  /** Subscribe to every emitted record. Returns an unsubscribe function. */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  unsubscribe(listener: EventListener): void {
    this.listeners.delete(listener)
  }

  /** Snapshot of the tail of the log. */
  tail(limit = 600): EventRecord[] {
    if (limit >= this.buffer.length) return this.buffer.slice()
    return this.buffer.slice(this.buffer.length - limit)
  }

  count(type: EventType): number {
    return this.counts.get(type) ?? 0
  }

  clear(): void {
    this.buffer.length = 0
    this.counts.clear()
    this.seq = 0
  }
}
