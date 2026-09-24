import { describe, expect, it } from 'vitest'
import { EventBus } from '../../src/ecs/events'
import { Pipeline } from '../../src/ecs/pipeline'
import type { System } from '../../src/ecs/pipeline'
import type { SimContext } from '../../src/ecs/types'

describe('EventBus', () => {
  it('counts events by type and returns the tail', () => {
    const bus = new EventBus()
    bus.emit('info', 'a')
    bus.emit('shot', 'b')
    bus.emit('info', 'c')
    expect(bus.total).toBe(3)
    expect(bus.count('info')).toBe(2)
    expect(bus.count('shot')).toBe(1)
    expect(bus.tail().map((e) => e.msg)).toEqual(['a', 'b', 'c'])
    expect(bus.tail(2).map((e) => e.msg)).toEqual(['b', 'c'])
  })

  it('caps the ring buffer at max, keeping the newest records', () => {
    const bus = new EventBus(3)
    for (const msg of ['a', 'b', 'c', 'd', 'e']) bus.emit('info', msg)
    expect(bus.total).toBe(5)
    expect(bus.tail().map((e) => e.msg)).toEqual(['c', 'd', 'e'])
  })

  it('notifies subscribers and stops after unsubscribe', () => {
    const bus = new EventBus()
    const seen: string[] = []
    const off = bus.subscribe((e) => seen.push(e.msg))
    bus.emit('info', 'a')
    bus.emit('shot', 'b')
    off()
    bus.emit('info', 'c')
    expect(seen).toEqual(['a', 'b'])
  })

  it('isolates a throwing subscriber from the simulation', () => {
    const bus = new EventBus()
    const seen: string[] = []
    bus.subscribe(() => {
      throw new Error('boom')
    })
    bus.subscribe((e) => seen.push(e.msg))
    expect(() => bus.emit('info', 'a')).not.toThrow()
    expect(seen).toEqual(['a'])
  })

  it('tags replay events and keeps them out of the live log and counters', () => {
    const bus = new EventBus()
    bus.emit('shot', 'live')
    const seen: string[] = []
    bus.subscribe((e) => seen.push(e))

    bus.replaying = true
    bus.emit('shot', 'replayed')
    bus.replaying = false
    bus.emit('shot', 'live again')

    expect(bus.total).toBe(2)
    expect(bus.count('shot')).toBe(2)
    expect(bus.tail().map((e) => e.msg)).toEqual(['live', 'live again'])
    // Subscribers still see every event; replay ones are tagged.
    expect(seen.map((e) => e.msg)).toEqual(['replayed', 'live again'])
    expect(seen[0].replay).toBe(true)
    expect(seen[1].replay).toBeUndefined()
  })
})

describe('Pipeline', () => {
  it('runs systems in order', () => {
    const seen: string[] = []
    const system = (name: string): System => ({ name, update: () => void seen.push(name) })
    const pipeline = new Pipeline([system('first'), system('second'), system('third')])

    pipeline.run({ bus: new EventBus() } as unknown as SimContext)
    expect(seen).toEqual(['first', 'second', 'third'])
    expect(pipeline.timings.map((t) => t.name)).toEqual(['first', 'second', 'third'])
  })
})
