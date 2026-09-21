export type Entity = number

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ComponentStore<T = any> {
  readonly name: string
  readonly map: Map<Entity, T>
}

export function defineComponent<T>(name: string): ComponentStore<T> {
  return { name, map: new Map<Entity, T>() }
}

/**
 * Minimal archetype-free ECS world. An entity is an integer id. Components live
 * in per-type maps keyed by entity id. This is intentionally small and readable
 * so the live event log can reflect exactly what is happening.
 */
export class World {
  private next = 1
  private entities = new Set<Entity>()
  private stores: Array<ComponentStore<any>> = []

  create(): Entity {
    const id = this.next++
    this.entities.add(id)
    return id
  }

  destroy(e: Entity): void {
    if (!this.entities.delete(e)) return
    for (const store of this.stores) {
      store.map.delete(e)
    }
  }

  isAlive(e: Entity): boolean {
    return this.entities.has(e)
  }

  get count(): number {
    return this.entities.size
  }

  add<T>(e: Entity, c: ComponentStore<T>, value: T): void {
    this.track(c)
    c.map.set(e, value)
  }

  get<T>(e: Entity, c: ComponentStore<T>): T | undefined {
    return c.map.get(e)
  }

  require<T>(e: Entity, c: ComponentStore<T>): T {
    const v = c.map.get(e)
    if (v === undefined) {
      throw new Error(`entity ${e} is missing component ${c.name}`)
    }
    return v
  }

  has<T>(e: Entity, c: ComponentStore<T>): boolean {
    return c.map.has(e)
  }

  remove<T>(e: Entity, c: ComponentStore<T>): void {
    c.map.delete(e)
  }

  /** Every registered component store, used by tooling/inspectors. */
  get allStores(): ReadonlyArray<ComponentStore<any>> {
    return this.stores
  }

  query(...comps: Array<ComponentStore<any>>): Entity[] {
    if (comps.length === 0) return []
    let smallest = comps[0].map
    for (let i = 1; i < comps.length; i++) {
      if (comps[i].map.size < smallest.size) smallest = comps[i].map
    }
    const out: Entity[] = []
    outer: for (const e of smallest.keys()) {
      for (const c of comps) {
        if (!c.map.has(e)) continue outer
      }
      out.push(e)
    }
    return out
  }

  private track(c: ComponentStore<any>): void {
    if (!this.stores.includes(c)) this.stores.push(c)
  }

  clear(): void {
    this.entities.clear()
    for (const store of this.stores) store.map.clear()
    this.next = 1
  }

  /** Deep copy of all component data, used for turn replay. */
  capture(): WorldSnapshot {
    return {
      next: this.next,
      entities: Array.from(this.entities),
      stores: this.stores.map((store) => ({
        store,
        entries: Array.from(store.map.entries()).map(([e, v]) => [e, structuredClone(v)] as [Entity, any]),
      })),
    }
  }

  restore(snapshot: WorldSnapshot): void {
    this.next = snapshot.next
    this.entities = new Set(snapshot.entities)
    for (const { store, entries } of snapshot.stores) {
      store.map.clear()
      for (const [e, v] of entries) store.map.set(e, structuredClone(v))
    }
  }
}

export interface WorldSnapshot {
  next: number
  entities: Entity[]
  stores: Array<{ store: ComponentStore<any>; entries: Array<[Entity, any]> }>
}
