import type { Board } from './board'
import { moveDestinations } from './geometry'
import type { OccupiedFn } from './geometry'
import type { Geometry, TeamId, Vec2 } from './types'
import { resolveGeometry } from './types'

const NEVER: OccupiedFn = () => false

class MinHeap {
  private items: number[] = []
  private priority: Float64Array

  constructor(size: number) {
    this.priority = new Float64Array(size)
  }

  get size(): number {
    return this.items.length
  }

  push(node: number, prio: number): void {
    this.priority[node] = prio
    this.items.push(node)
    let i = this.items.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.priority[this.items[parent]] <= this.priority[this.items[i]]) break
      const tmp = this.items[parent]
      this.items[parent] = this.items[i]
      this.items[i] = tmp
      i = parent
    }
  }

  pop(): number {
    const top = this.items[0]
    const last = this.items.pop() as number
    if (this.items.length > 0) {
      this.items[0] = last
      let i = 0
      const n = this.items.length
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let smallest = i
        if (l < n && this.priority[this.items[l]] < this.priority[this.items[smallest]]) smallest = l
        if (r < n && this.priority[this.items[r]] < this.priority[this.items[smallest]]) smallest = r
        if (smallest === i) break
        const tmp = this.items[smallest]
        this.items[smallest] = this.items[i]
        this.items[i] = tmp
        i = smallest
      }
    }
    return top
  }
}

function heuristic(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by))
}

export interface PathResult {
  cells: Vec2[]
  found: boolean
  expanded: number
}

// Reachability ignoring pieces is a pure function of (board terrain, geometry,
// team, origin cell), and orders/AI ask the same question for the same piece
// every tick. Memoize it with a small LRU so the flood fill runs once per
// (cell, geometry) instead of once per tick. Cleared whenever the board object
// or its terrain changes.
const REACH_CACHE_LIMIT = 512
let reachCache = new Map<number, Uint8Array>()
let reachCacheBoard: Board | null = null
let reachCacheVersion = -1
let nextGeomId = 1
const geomIds = new WeakMap<Geometry, number>()

function geometryId(geom: Geometry): number {
  let id = geomIds.get(geom)
  if (id === undefined) {
    id = nextGeomId++
    geomIds.set(geom, id)
  }
  return id
}

/**
 * Every cell a piece can ever step onto, ignoring other pieces (walls and
 * impassable terrain still block). This is the reachability `findPath` uses with
 * no occupancy, computed in a single flood fill instead of one A* per target —
 * which matters when a long-range attacker probes many approach cells at once.
 *
 * The returned array is shared/cached: treat it as read-only.
 */
export function reachableCells(
  board: Board,
  from: Vec2,
  geom: Geometry,
  team: TeamId,
): Uint8Array {
  if (board !== reachCacheBoard || board.terrainVersion !== reachCacheVersion) {
    reachCache = new Map()
    reachCacheBoard = board
    reachCacheVersion = board.terrainVersion
  }
  if (!Number.isInteger(from.x) || !Number.isInteger(from.y) || !board.inBounds(from.x, from.y)) {
    return computeReachable(board, from, geom, team)
  }
  const key = (((geometryId(geom) * 2 + (team === 'red' ? 1 : 0)) * board.height + from.y) * board.width + from.x)
  const hit = reachCache.get(key)
  if (hit) {
    // Refresh LRU recency (Map preserves insertion order).
    reachCache.delete(key)
    reachCache.set(key, hit)
    return hit
  }
  const result = computeReachable(board, from, geom, team)
  reachCache.set(key, result)
  if (reachCache.size > REACH_CACHE_LIMIT) {
    const oldest = reachCache.keys().next().value
    if (oldest !== undefined) reachCache.delete(oldest)
  }
  return result
}

function computeReachable(
  board: Board,
  from: Vec2,
  geom: Geometry,
  team: TeamId,
): Uint8Array {
  const w = board.width
  const h = board.height
  const seen = new Uint8Array(w * h)
  if (!board.inBounds(from.x, from.y)) return seen
  const g = resolveGeometry(geom, team)
  const start = from.y * w + from.x
  seen[start] = 1
  const queue: number[] = [start]

  const visit = (x: number, y: number): boolean => {
    const idx = y * w + x
    if (seen[idx]) return false
    seen[idx] = 1
    queue.push(idx)
    return true
  }

  for (let qi = 0; qi < queue.length; qi++) {
    const current = queue[qi]
    const cx = current % w
    const cy = (current - cx) / w

    if (g.kind === 'slide') {
      for (const [dx, dy] of g.dirs) {
        for (let k = 1; k <= g.range; k++) {
          const x = cx + dx * k
          const y = cy + dy * k
          if (!board.passable(x, y)) break
          if (!visit(x, y)) continue
        }
      }
      continue
    }

    if (g.kind === 'leap') {
      for (const [dx, dy] of g.offsets) {
        const x = cx + dx
        const y = cy + dy
        if (board.passable(x, y)) visit(x, y)
      }
      continue
    }

    const y = cy + g.dy * g.forward
    if (board.passable(cx, y)) visit(cx, y)
  }
  return seen
}

/**
 * A* over the graph induced by a piece's movement geometry. Other pieces are
 * passed in as `occupied` (excluding the moving piece itself), so routes respect
 * one-piece-per-square and only leaps may pass over blockers. If the goal is
 * unreachable it returns the best-effort route to the closest cell reached.
 */
export function findPath(
  board: Board,
  from: Vec2,
  to: Vec2,
  geom: Geometry,
  team: TeamId,
  occupied: OccupiedFn = NEVER,
): PathResult {
  const w = board.width
  const h = board.height
  const size = w * h
  const gScore = new Float64Array(size).fill(Infinity)
  const cameFrom = new Int32Array(size).fill(-1)
  const closed = new Uint8Array(size)
  const heap = new MinHeap(size)

  const startIdx = from.y * w + from.x
  const goalIdx = to.y * w + to.x
  if (startIdx === goalIdx) return { cells: [], found: true, expanded: 0 }

  gScore[startIdx] = 0
  heap.push(startIdx, heuristic(from.x, from.y, to.x, to.y))

  let expanded = 0
  // Best-effort fallback uses Euclidean distance so a step that reduces only
  // one axis still counts as progress (e.g. a pawn advancing up its file toward
  // an off-file objective).
  let bestIdx = startIdx
  let bestD = (from.x - to.x) ** 2 + (from.y - to.y) ** 2

  while (heap.size > 0) {
    const current = heap.pop()
    if (closed[current]) continue
    closed[current] = 1
    expanded++

    if (current === goalIdx) {
      bestIdx = current
      bestD = 0
      break
    }

    const cx = current % w
    const cy = (current - cx) / w
    const dd = (cx - to.x) ** 2 + (cy - to.y) ** 2
    if (dd < bestD) {
      bestD = dd
      bestIdx = current
    }

    const neighbours = moveDestinations(board, { x: cx, y: cy }, geom, team, occupied)
    for (const n of neighbours) {
      const nIdx = n.y * w + n.x
      if (closed[nIdx]) continue
      const tentative = gScore[current] + board.moveCost(n.x, n.y)
      if (tentative < gScore[nIdx]) {
        gScore[nIdx] = tentative
        cameFrom[nIdx] = current
        heap.push(nIdx, tentative + heuristic(n.x, n.y, to.x, to.y))
      }
    }
  }

  const cells: Vec2[] = []
  let node = bestIdx
  while (node !== startIdx && node !== -1) {
    const x = node % w
    const y = (node - x) / w
    cells.push({ x, y })
    node = cameFrom[node]
  }
  cells.reverse()

  if (bestIdx !== goalIdx) return { cells, found: false, expanded }
  return { cells, found: true, expanded }
}
