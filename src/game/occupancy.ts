import type { Board } from './board'
import { Cell, Motion } from '../ecs/components'
import type { Entity, World } from '../ecs/world'
import type { OccupiedFn } from './geometry'

export type Occupancy = Map<number, Entity>

export function cellIndex(board: Board, x: number, y: number): number {
  return y * board.width + x
}

/**
 * Cells claimed by pieces: each piece's current cell plus the cell it is
 * currently entering (`Motion.reserved`). Keeping the origin claimed until
 * arrival is what makes "one piece per square" hold through a move.
 */
export function buildOccupancy(world: World, board: Board): Occupancy {
  const map: Occupancy = new Map()
  for (const e of world.query(Cell)) {
    const c = world.require(e, Cell)
    map.set(cellIndex(board, c.x, c.y), e)
    const motion = world.get(e, Motion)
    if (motion?.reserved) map.set(cellIndex(board, motion.reserved.x, motion.reserved.y), e)
  }
  return map
}

export function makeOccupied(board: Board, occupancy: Occupancy): OccupiedFn {
  return (x, y) => occupancy.has(y * board.width + x)
}

/** Like `makeOccupied` but ignores the given entity's own cell/reservation. */
export function occupiedExcept(board: Board, occupancy: Occupancy, self: Entity): OccupiedFn {
  return (x, y) => {
    const other = occupancy.get(y * board.width + x)
    return other !== undefined && other !== self
  }
}
