import type { Board } from './board'
import type { OccupiedFn } from './geometry'
import { closestEmptyCell, firingPositionExists, previewFiringCell } from './approach'
import { findPath } from './pathfind'
import { WEAPONS } from './pieces'
import type { PieceDef } from './pieces'
import type { TeamId, Vec2 } from './types'
import type { MotionData, OrderData, OrderStep } from '../ecs/components'
import type { Entity } from '../ecs/world'

const NEVER: OccupiedFn = () => false

/** How many recent order transitions a piece keeps for the properties panel. */
export const MAX_ORDER_LOG = 5

/**
 * Record an order transition (issued / replaced / completed / abandoned) on the
 * piece, newest last, capped at `MAX_ORDER_LOG`. Purely descriptive: the panel
 * reads it to explain *why* the order changed, and it rides along in turn
 * snapshots so undo/redo and record replay reproduce it exactly.
 */
export function noteOrder(order: OrderData, tick: number, text: string): void {
  order.log.push({ tick, text })
  if (order.log.length > MAX_ORDER_LOG) order.log.splice(0, order.log.length - MAX_ORDER_LOG)
}

/** Endpoint of a step's planned path (falls back to its objective). */
function stepEnd(step: OrderStep): Vec2 | null {
  const last = step.path[step.path.length - 1]
  if (last) return last
  if (step.kind === 'goto') return step.dest
  return step.goal
}

/**
 * Where the next queued step starts: the end of the last queued step, else the
 * active step's destination / firing position, else the piece itself.
 */
export function anchorFor(order: OrderData, motion: MotionData, cell: Vec2): Vec2 {
  const last = order.queue[order.queue.length - 1]
  if (last) {
    const end = stepEnd(last)
    if (end) return end
  }
  if (order.kind === 'goto' && order.dest) return order.dest
  if (order.kind === 'attack' && motion.goal) return motion.goal
  return { x: cell.x, y: cell.y }
}

/**
 * Plan a queued step's display route from `from`, theoretically: other pieces
 * are assumed to move, so only walls (and the target's own square for an attack)
 * are avoided. This mirrors `Game.planAttack`'s navigation so an appended step is
 * drawn the same way the active order is.
 */
export function planStep(
  board: Board,
  from: Vec2,
  step: OrderStep,
  def: PieceDef,
  team: TeamId,
  targetCell?: Vec2 | null,
): void {
  if (step.kind === 'goto') {
    step.path = findPath(board, from, step.dest, def.move, team, NEVER).cells
    return
  }
  if (!targetCell) {
    step.path = []
    step.goal = null
    step.reachable = false
    return
  }
  const geometry = WEAPONS[def.weapon].geometry
  step.reachable = firingPositionExists(board, from, targetCell, def.move, geometry, team)
  const goal =
    previewFiringCell(board, from, targetCell, def.move, geometry, team, NEVER) ??
    closestEmptyCell(board, from, targetCell, def.move, team, NEVER) ?? { x: targetCell.x, y: targetCell.y }
  step.goal = goal
  step.path = findPath(board, from, goal, def.move, team, NEVER).cells
}

/** Re-plan every queued step from a new anchor, keeping the chain connected. */
export function rechainQueue(
  board: Board,
  from: Vec2,
  queue: OrderStep[],
  def: PieceDef,
  team: TeamId,
  targetCellOf: (target: Entity) => Vec2 | null,
): void {
  let anchor = { x: from.x, y: from.y }
  for (const step of queue) {
    if (step.kind === 'goto') {
      planStep(board, anchor, step, def, team)
      anchor = stepEnd(step) ?? anchor
    } else {
      planStep(board, anchor, step, def, team, targetCellOf(step.target))
      anchor = stepEnd(step) ?? anchor
    }
  }
}

/**
 * Move the first queued step into the active order slot. A promoted attack
 * clears any suspended (parked) target; a promoted goto keeps it, so a regroup
 * resumes only once the whole queue has drained.
 */
export function promoteNext(order: OrderData, motion: MotionData): boolean {
  const next = order.queue.shift()
  if (!next) return false
  if (next.kind === 'goto') {
    order.kind = 'goto'
    order.dest = next.dest
    order.target = null
    order.resumeTurn = -1
    motion.goal = next.dest
    motion.intent = 'order'
  } else {
    order.kind = 'attack'
    order.target = next.target
    order.dest = null
    order.reachable = next.reachable
    order.resumeTarget = null
    order.resumeTurn = -1
    motion.goal = null
    motion.intent = 'none'
  }
  motion.path = []
  motion.arrived = false
  motion.blocked = false
  motion.replanAt = 0
  return true
}

export interface QueueMarker {
  cell: Vec2
  index: number
  kind: 'goto' | 'attack'
}

/** Endpoint marker per queued step, ready to be numbered by the renderer. */
export function queueMarkers(steps: readonly OrderStep[]): QueueMarker[] {
  const out: QueueMarker[] = []
  steps.forEach((step, index) => {
    const end = stepEnd(step)
    if (end) out.push({ cell: end, index, kind: step.kind })
  })
  return out
}
