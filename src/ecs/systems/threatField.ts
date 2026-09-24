import { chebyshev, containsCell, fireCells, moveDestinations } from '../../game/geometry'
import type { OccupiedFn } from '../../game/geometry'
import { dist } from '../../game/math'
import { makeOccupied } from '../../game/occupancy'
import { PIECES, WEAPONS } from '../../game/pieces'
import type { Geometry, TeamId, Vec2 } from '../../game/types'
import { PieceType } from '../components'
import type { SimContext } from '../types'
import type { Threat } from './preservation'

/** One threat's firing geometry weighted by its weapon damage. */
export interface Coverage {
  cells: Vec2[]
  weight: number
}

/**
 * Every threat's firing geometry, weighted by damage — including a nearby enemy
 * that cannot hit the piece *yet* but can hit the square it is about to step
 * into. `selfFire` should free the moving piece's square so vacating it opens
 * the same shots an escapee would have to dodge.
 */
export function buildCoverage(ctx: SimContext, threats: Threat[], selfFire: OccupiedFn): Coverage[] {
  return threats.map((t) => {
    const od = PIECES[ctx.world.require(t.entity, PieceType).kind]
    const cells = od ? fireCells(ctx.board, t.cell, WEAPONS[od.weapon].geometry, t.team, selfFire) : []
    return { cells, weight: t.damage }
  })
}

/**
 * Total weapon damage covering `(x, y)`, plus caller-supplied proximity pressure
 * (`proximityPenalty` receives the Chebyshev distance to each threat). Constants
 * stay per-caller: self-preservation uses a flat adjacent penalty; the AI king
 * uses an adjacent spike and a radius gradient.
 */
function dangerAt(
  coverages: Coverage[],
  threats: Threat[],
  x: number,
  y: number,
  proximityPenalty: (chebyshevDist: number) => number = () => 0,
): number {
  let danger = 0
  for (const cov of coverages) {
    if (containsCell(cov.cells, x, y)) danger += cov.weight
  }
  for (const t of threats) {
    danger += proximityPenalty(chebyshev(x, y, t.cell.x, t.cell.y))
  }
  return danger
}

/** Euclidean distance from `(x, y)` to the nearest threat. */
function minThreatDist(threats: Threat[], x: number, y: number): number {
  let min = Infinity
  for (const t of threats) min = Math.min(min, dist(x, y, t.cell.x, t.cell.y))
  return min
}

/** How a candidate escape square scores against its peers. */
export interface SafeStepMetrics {
  /** Lower is better: total covering damage (+ step-in pressure). */
  danger: number
  /** Higher wins when danger ties (both callers: distance from threats). */
  primary: number
  /** True wins when danger ties, before `primary` (escape: keeps the shot). */
  prefer?: boolean
  /** Lower wins when danger and `primary` tie (king: distance to home). */
  secondary?: number
}

function stepBeats(m: SafeStepMetrics, best: SafeStepMetrics): boolean {
  if (m.danger < best.danger) return true
  if (m.danger > best.danger) return false
  const mPrefer = m.prefer === true
  const bestPrefer = best.prefer === true
  if (mPrefer !== bestPrefer) return mPrefer
  if (m.primary > best.primary + 1e-9) return true
  if (m.primary < best.primary - 1e-9) return false
  if (m.secondary === undefined || best.secondary === undefined) return false
  return m.secondary < best.secondary
}

/**
 * Lowest-danger legal step under a shared comparator: danger, optional
 * preference flag, then farthest from threats, then closest to a secondary
 * target (e.g. the king's home post). Returns null when `options` is empty.
 */
function bestSafeStep(options: Vec2[], metrics: (c: Vec2) => SafeStepMetrics): Vec2 | null {
  let best: Vec2 | null = null
  let bestM: SafeStepMetrics | null = null
  for (const c of options) {
    const m = metrics(c)
    if (bestM === null || stepBeats(m, bestM)) {
      best = c
      bestM = m
    }
  }
  return best
}

/**
 * A threat field with its scoring bound: the shared coverages, threats and a
 * per-caller proximity penalty, exposing danger/distance/metrics so escape and
 * king goals do the arithmetic identically.
 */
export interface ThreatField {
  danger(x: number, y: number): number
  dist(x: number, y: number): number
  metrics(x: number, y: number, extra?: { prefer?: boolean; secondary?: number }): SafeStepMetrics
}

function threatField(
  coverages: Coverage[],
  threats: Threat[],
  proximityPenalty: (chebyshevDist: number) => number = () => 0,
): ThreatField {
  return {
    danger: (x, y) => dangerAt(coverages, threats, x, y, proximityPenalty),
    dist: (x, y) => minThreatDist(threats, x, y),
    metrics: (x, y, extra = {}) => ({
      danger: dangerAt(coverages, threats, x, y, proximityPenalty),
      primary: minThreatDist(threats, x, y),
      ...extra,
    }),
  }
}

/** A piece's legal one-step options and how the current and best squares score. */
export interface SafeStepResult {
  current: SafeStepMetrics
  best: Vec2
  bestMetrics: SafeStepMetrics
}

/**
 * Score every legal one-step option against a fresh threat field and return the
 * best plus the current square's metrics, or null when there is nowhere to go.
 * `score` is the per-caller tie-break (escape keeps its shot; the king prefers
 * home), applied identically to the current square and the candidates.
 */
export function evaluateSafeStep(
  ctx: SimContext,
  cell: Vec2,
  move: Geometry,
  team: TeamId,
  coverages: Coverage[],
  threats: Threat[],
  proximityPenalty: (chebyshevDist: number) => number,
  score: (field: ThreatField, c: Vec2) => SafeStepMetrics,
): SafeStepResult | null {
  const options = moveDestinations(ctx.board, cell, move, team, makeOccupied(ctx.board, ctx.occupancy))
  const field = threatField(coverages, threats, proximityPenalty)
  const best = bestSafeStep(options, (c) => score(field, c))
  if (best === null) return null
  return {
    current: field.metrics(cell.x, cell.y),
    best,
    bestMetrics: score(field, best),
  }
}
