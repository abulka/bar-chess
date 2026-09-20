import type { Board } from './board'
import { Cell } from '../ecs/components'
import type { Entity, World } from '../ecs/world'
import type { OccupiedFn } from './geometry'

export type Occupancy = Map<number, Entity>

export function cellIndex(board: Board, x: number, y: number): number {
  return y * board.width + x
}

export function buildOccupancy(world: World, board: Board): Occupancy {
  const map: Occupancy = new Map()
  for (const e of world.query(Cell)) {
    const c = world.require(e, Cell)
    map.set(cellIndex(board, c.x, c.y), e)
  }
  return map
}

export function makeOccupied(board: Board, occupancy: Occupancy): OccupiedFn {
  return (x, y) => occupancy.has(y * board.width + x)
}
