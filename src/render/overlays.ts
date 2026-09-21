import type { Board } from '../game/board'
import { containsCell, fireCells } from '../game/geometry'
import type { OccupiedFn } from '../game/geometry'
import type { Geometry, TeamId, Vec2 } from '../game/types'

const NEVER: OccupiedFn = () => false

/** Cell centres along a movement route, ready to be stroked as a polyline. */
export function routePolyline(board: Board, path: readonly Vec2[]): Vec2[] {
  return path.map((c) => board.cellCenter(c.x, c.y))
}

export type FiringLineKind = 'clear' | 'blocked' | 'unreachable'

export interface FiringSegment {
  from: Vec2
  to: Vec2
  /** dashed = blocked/uncertain stretch, solid = clear shot. */
  dashed: boolean
}

export interface FiringLine {
  kind: FiringLineKind
  /** True when the target sits inside a clear firing geometry from the end cell. */
  clear: boolean
  /** Firing position the piece is (or will be) shooting from. */
  end: Vec2
  target: Vec2
  /** First blocker on a straight end→target line, when one exists. */
  blocker: Vec2 | null
  /** Styled segments to stroke, in draw order. */
  segments: FiringSegment[]
}

/**
 * Classify the attack indicator's firing line and resolve it into styled
 * segments. The renderer only maps `kind` to a colour and strokes `segments`,
 * so the clear / blocked / out-of-reach decisions are pure and testable.
 */
export function firingLine(
  board: Board,
  endCell: Vec2,
  targetCell: Vec2,
  weaponGeom: Geometry,
  team: TeamId,
  reachable: boolean,
  occupied: OccupiedFn = NEVER,
): FiringLine {
  const end = board.cellCenter(endCell.x, endCell.y)
  const target = board.cellCenter(targetCell.x, targetCell.y)
  const clearShot =
    reachable &&
    containsCell(fireCells(board, endCell, weaponGeom, team, occupied), targetCell.x, targetCell.y)

  if (!reachable) {
    return {
      kind: 'unreachable',
      clear: false,
      end,
      target,
      blocker: null,
      segments: [{ from: end, to: target, dashed: true }],
    }
  }

  if (clearShot) {
    return {
      kind: 'clear',
      clear: true,
      end,
      target,
      blocker: null,
      segments: [{ from: end, to: target, dashed: false }],
    }
  }

  const blockerCell = firstBlocker(board, endCell, targetCell, occupied)
  if (blockerCell) {
    const blocker = board.cellCenter(blockerCell.x, blockerCell.y)
    return {
      kind: 'blocked',
      clear: false,
      end,
      target,
      blocker,
      segments: [
        { from: end, to: blocker, dashed: false },
        { from: blocker, to: target, dashed: true },
      ],
    }
  }

  return {
    kind: 'blocked',
    clear: false,
    end,
    target,
    blocker: null,
    segments: [{ from: end, to: target, dashed: true }],
  }
}

/**
 * First piece or wall between the end and target cells when they sit on a
 * straight (orthogonal or diagonal) line; otherwise null (nothing meaningful to
 * pin the solid/dashed boundary to).
 */
function firstBlocker(board: Board, endCell: Vec2, targetCell: Vec2, occupied: OccupiedFn): Vec2 | null {
  const dx = targetCell.x - endCell.x
  const dy = targetCell.y - endCell.y
  const straight = dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy)
  const steps = Math.max(Math.abs(dx), Math.abs(dy))
  if (!straight || steps <= 1) return null
  const sx = Math.sign(dx)
  const sy = Math.sign(dy)
  for (let k = 1; k < steps; k++) {
    const x = endCell.x + sx * k
    const y = endCell.y + sy * k
    if (occupied(x, y) || board.blocksVision(x, y)) return { x, y }
  }
  return null
}
