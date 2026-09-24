import type { Vec2 } from './types'

/** Flat index of `(x, y)` in a width-major grid (board terrain, reach masks, …). */
export function cellIndex(x: number, y: number, width: number): number {
  return y * width + x
}

export const TERRAIN = {
  floor: 0,
  road: 1,
  sand: 2,
  water: 3,
  wall: 4,
} as const

export interface TerrainDef {
  id: number
  name: string
  passable: boolean
  blocksVision: boolean
  blocksProjectile: boolean
  cost: number
  color: string
}

export const TERRAIN_DEFS: TerrainDef[] = [
  { id: 0, name: 'floor', passable: true, blocksVision: false, blocksProjectile: false, cost: 1, color: '#2a3242' },
  { id: 1, name: 'road', passable: true, blocksVision: false, blocksProjectile: false, cost: 0.7, color: '#3b3a33' },
  { id: 2, name: 'sand', passable: true, blocksVision: false, blocksProjectile: false, cost: 1.35, color: '#4d4635' },
  { id: 3, name: 'water', passable: false, blocksVision: false, blocksProjectile: false, cost: 99, color: '#1c3a52' },
  { id: 4, name: 'wall', passable: false, blocksVision: true, blocksProjectile: true, cost: 99, color: '#5a5f66' },
]

export function terrainDef(id: number): TerrainDef {
  return TERRAIN_DEFS[id] ?? TERRAIN_DEFS[0]
}

export interface MapSpawn {
  x: number
  y: number
  w: number
  h: number
}

export interface MapData {
  id: string
  name: string
  width: number
  height: number
  tile: number
  legend: Record<string, number>
  terrain: number[]
  spawns: { red: MapSpawn; blue: MapSpawn }
  lanes: { red: Vec2[]; blue: Vec2[] }
}

export class Board {
  readonly width: number
  readonly height: number
  readonly tile: number
  readonly data: MapData
  readonly terrain: Uint8Array
  /** Bumped on every terrain edit; keys derived caches such as reachability. */
  terrainVersion = 0

  constructor(data: MapData) {
    this.data = data
    this.width = data.width
    this.height = data.height
    this.tile = data.tile
    this.terrain = new Uint8Array(data.terrain)
  }

  get pixelWidth(): number {
    return this.width * this.tile
  }

  get pixelHeight(): number {
    return this.height * this.tile
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height
  }

  cellIndex(x: number, y: number): number {
    return cellIndex(x, y, this.width)
  }

  terrainAt(x: number, y: number): number {
    if (!this.inBounds(x, y)) return TERRAIN.wall
    return this.terrain[this.cellIndex(x, y)]
  }

  defAt(x: number, y: number): TerrainDef {
    return terrainDef(this.terrainAt(x, y))
  }

  setTerrain(x: number, y: number, id: number): void {
    if (!this.inBounds(x, y)) return
    this.terrain[this.cellIndex(x, y)] = id
    this.terrainVersion++
  }

  /** A cell a ground piece may stand on (ignores other pieces). */
  passable(x: number, y: number): boolean {
    return this.inBounds(x, y) && this.defAt(x, y).passable
  }

  moveCost(x: number, y: number): number {
    return this.defAt(x, y).cost
  }

  blocksVision(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return true
    return this.defAt(x, y).blocksVision
  }

  blocksProjectile(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return true
    return this.defAt(x, y).blocksProjectile
  }

  cellCenter(x: number, y: number): Vec2 {
    return { x: (x + 0.5) * this.tile, y: (y + 0.5) * this.tile }
  }

  worldToCell(x: number, y: number): Vec2 {
    return { x: Math.floor(x / this.tile), y: Math.floor(y / this.tile) }
  }

  laneCells(team: 'red' | 'blue'): Vec2[] {
    return this.data.lanes[team]
  }
}
