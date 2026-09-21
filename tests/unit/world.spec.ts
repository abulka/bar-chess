import { describe, expect, it } from 'vitest'
import { defineComponent, World } from '../../src/ecs/world'

const Pos = defineComponent<{ x: number; y: number }>('TestPos')
const Tag = defineComponent<{ on: boolean }>('TestTag')

describe('World', () => {
  it('creates, reads and removes components', () => {
    const world = new World()
    const e = world.create()
    world.add(e, Pos, { x: 1, y: 2 })
    expect(world.get(e, Pos)).toEqual({ x: 1, y: 2 })
    expect(world.has(e, Tag)).toBe(false)

    world.remove(e, Pos)
    expect(world.get(e, Pos)).toBeUndefined()
  })

  it('require throws for a missing component', () => {
    const world = new World()
    const e = world.create()
    expect(() => world.require(e, Pos)).toThrow(/missing component/)
  })

  it('queries the intersection of components', () => {
    const world = new World()
    const a = world.create()
    const b = world.create()
    world.add(a, Pos, { x: 0, y: 0 })
    world.add(a, Tag, { on: true })
    world.add(b, Pos, { x: 1, y: 1 })

    expect(world.query(Pos).sort()).toEqual([a, b].sort())
    expect(world.query(Pos, Tag)).toEqual([a])
  })

  it('destroy drops the entity from every store', () => {
    const world = new World()
    const e = world.create()
    world.add(e, Pos, { x: 0, y: 0 })
    world.add(e, Tag, { on: true })
    world.destroy(e)
    expect(world.isAlive(e)).toBe(false)
    expect(world.get(e, Pos)).toBeUndefined()
    expect(world.query(Pos, Tag)).toEqual([])
  })

  it('capture/restore deep-clones component state', () => {
    const world = new World()
    const e = world.create()
    world.add(e, Pos, { x: 1, y: 1 })
    const snapshot = world.capture()

    world.require(e, Pos).x = 99
    world.restore(snapshot)
    expect(world.require(e, Pos)).toEqual({ x: 1, y: 1 })

    world.require(e, Pos).x = 5
    expect(snapshot.stores[0].entries[0][1]).toEqual({ x: 1, y: 1 })
  })
})
