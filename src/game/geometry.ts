import type { Board } from './board'
import type { Dir, Geometry, TeamId, Vec2 } from './types'
import { resolveGeometry } from './types'

export type OccupiedFn = (x: number, y: number) => boolean

/** Shared "nothing is occupied" predicate (theoretical routing, previews). */
export const NEVER: OccupiedFn = () => false

/**
 * Step from `from` along `dir` up to `range` times, stopping before a cell
 * rejected by `stopBefore` (not visited) and after one accepted by `stopAfter`
 * (visited, then stops). The one place ray-stepping semantics live.
 */
function walkRay(
  board: Board,
  from: Vec2,
  [dx, dy]: Dir,
  range: number,
  visit: (x: number, y: number) => void,
  stopBefore: (x: number, y: number) => boolean,
  stopAfter: (x: number, y: number) => boolean = () => false,
): void {
  for (let k = 1; k <= range; k++) {
    const x = from.x + dx * k
    const y = from.y + dy * k
    if (!board.inBounds(x, y) || stopBefore(x, y)) break
    visit(x, y)
    if (stopAfter(x, y)) break
  }
}

/**
 * Walk the Bresenham line from `a` to `b` inclusive, calling `visit` for each
 * cell with whether it is the end. Returning `false` from `visit` stops early.
 */
function bresenham(
  a: Vec2,
  b: Vec2,
  visit: (x: number, y: number, isEnd: boolean) => boolean,
): void {
  let x = a.x
  let y = a.y
  const dx = Math.abs(b.x - x)
  const dy = Math.abs(b.y - y)
  const sx = x < b.x ? 1 : -1
  const sy = y < b.y ? 1 : -1
  let err = dx - dy
  for (;;) {
    const isEnd = x === b.x && y === b.y
    if (!visit(x, y, isEnd)) return
    if (isEnd) break
    const e2 = 2 * err
    if (e2 > -dy) {
      err -= dy
      x += sx
    }
    if (e2 < dx) {
      err += dx
      y += sy
    }
  }
}

/**
 * Rank a pawn starts on: rank 2 for blue (bottom) and rank 7 for red (top),
 * matching `initialArmy`. A pawn may take its two-square first move only here.
 */
function pawnHomeRank(board: Board, team: TeamId): number {
  return team === 'blue' ? board.height - 2 : 1
}

/**
 * Visit every legal one-move destination of `from` without allocating. Shared
 * by the collecting `moveDestinations` and the reachability flood fill so the
 * slide/leap/pawn rules (incl. pawnHomeRank) live in exactly one place.
 */
export function forEachMoveDestination(
  board: Board,
  from: Vec2,
  geom: Geometry,
  team: TeamId,
  occupied: OccupiedFn,
  ignoreOccupancy: boolean,
  visit: (x: number, y: number) => void,
): void {
  const g = resolveGeometry(geom, team)
  const free = (x: number, y: number) => board.passable(x, y) && (ignoreOccupancy || !occupied(x, y))

  if (g.kind === 'slide') {
    for (const dir of g.dirs) {
      walkRay(
        board,
        from,
        dir,
        g.range,
        visit,
        (x, y) => !board.passable(x, y) || (!ignoreOccupancy && occupied(x, y)),
      )
    }
    return
  }

  if (g.kind === 'leap') {
    for (const [dx, dy] of g.offsets) {
      const x = from.x + dx
      const y = from.y + dy
      if (free(x, y)) visit(x, y)
    }
    return
  }

  // A pawn advances up to `forward` squares, but the two-square first move is
  // only legal from its home rank; the first blocker stops the advance.
  const advance = from.y === pawnHomeRank(board, team) ? g.forward : 1
  for (let k = 1; k <= advance; k++) {
    const y = from.y + g.dy * k
    if (!free(from.x, y)) break
    visit(from.x, y)
  }
}

/**
 * Cells a piece can legally step to with one application of its movement
 * geometry. Another piece on a cell blocks it (one piece per square) unless
 * `ignoreOccupancy` is set, which path planning uses so routes may be planned
 * through cells that are merely busy right now.
 */
export function moveDestinations(
  board: Board,
  from: Vec2,
  geom: Geometry,
  team: TeamId,
  occupied: OccupiedFn = NEVER,
  ignoreOccupancy = false,
): Vec2[] {
  const out: Vec2[] = []
  forEachMoveDestination(board, from, geom, team, occupied, ignoreOccupancy, (x, y) => {
    out.push({ x, y })
  })
  return out
}

/**
 * Cells a weapon can reach from `from`: slide rays stop at walls and at the
 * first piece (which is included as a hittable target); leaps ignore blockers.
 */
export function fireCells(
  board: Board,
  from: Vec2,
  geom: Geometry,
  team: TeamId,
  occupied: OccupiedFn = NEVER,
): Vec2[] {
  const g = resolveGeometry(geom, team)
  const out: Vec2[] = []
  const push = (x: number, y: number) => out.push({ x, y })

  if (g.kind === 'slide') {
    for (const dir of g.dirs) fireRay(board, from, dir, g.range, occupied, push)
    return out
  }

  if (g.kind === 'leap') {
    for (const [dx, dy] of g.offsets) {
      const x = from.x + dx
      const y = from.y + dy
      if (board.inBounds(x, y)) out.push({ x, y })
    }
    return out
  }

  for (const dir of pawnFireDirs(g.dy)) fireRay(board, from, dir, 2, occupied, push)
  return out
}

function pawnFireDirs(dy: number): Dir[] {
  return [
    [1, dy],
    [-1, dy],
  ]
}

/**
 * Firing ray: stops before walls / out-of-bounds, and visits the first occupied
 * cell before stopping, so the blocker counts as a hittable target.
 */
function fireRay(
  board: Board,
  from: Vec2,
  dir: Dir,
  range: number,
  occupied: OccupiedFn,
  visit: (x: number, y: number) => void,
): void {
  walkRay(
    board,
    from,
    dir,
    range,
    visit,
    (x, y) => board.blocksVision(x, y),
    (x, y) => occupied(x, y),
  )
}

/**
 * True when no wall or piece blocks the sight line between two cells. Used for
 * validation when a target was acquired by vision rather than by geometry.
 */
export function lineClear(
  board: Board,
  a: Vec2,
  b: Vec2,
  occupied: OccupiedFn = NEVER,
  includeEnds = false,
): boolean {
  let clear = true
  bresenham(a, b, (x, y, isEnd) => {
    const isStart = x === a.x && y === a.y
    if (!isStart && !(isEnd && !includeEnds)) {
      if (board.blocksVision(x, y) || occupied(x, y)) {
        clear = false
        return false
      }
    }
    return true
  })
  return clear
}

/**
 * Interior cells of the Bresenham line between `a` and `b` (endpoints excluded).
 * Used to find squares that can physically screen one point from another.
 */
export function cellsBetween(board: Board, a: Vec2, b: Vec2): Vec2[] {
  const out: Vec2[] = []
  bresenham(a, b, (x, y, isEnd) => {
    const isStart = x === a.x && y === a.y
    if (!isStart && !isEnd && board.inBounds(x, y)) out.push({ x, y })
    return true
  })
  return out
}

/**
 * Empty cells from which `targetCell` sits inside the given firing geometry.
 * Used to pick a firing position (rather than piling onto the occupied target).
 * Computed as `target - dir`, which is correct for asymmetric patterns too
 * (a pawn approaches from the side it fires toward).
 */
export function attackApproachCells(
  board: Board,
  targetCell: Vec2,
  geom: Geometry,
  team: TeamId,
  occupied: OccupiedFn = NEVER,
): Vec2[] {
  const g = resolveGeometry(geom, team)
  const out: Vec2[] = []
  const dirs: readonly Dir[] =
    g.kind === 'slide'
      ? g.dirs
      : g.kind === 'leap'
        ? g.offsets
        : ([[0, g.dy], [1, g.dy], [-1, g.dy]] as Dir[])
  const range = g.kind === 'slide' ? g.range : 1
  const push = (x: number, y: number) => {
    if (!occupied(x, y) && board.passable(x, y)) out.push({ x, y })
  }
  for (const [dx, dy] of dirs) {
    fireRay(board, targetCell, [-dx, -dy] as Dir, range, occupied, push)
  }
  return out
}

export function containsCell(cells: Vec2[], x: number, y: number): boolean {
  for (const c of cells) {
    if (c.x === x && c.y === y) return true
  }
  return false
}

export function chebyshev(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by))
}
