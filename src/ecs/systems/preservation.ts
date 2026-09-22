import { chebyshev, containsCell, fireCells, moveDestinations } from '../../game/geometry'
import { makeOccupied, occupiedExcept } from '../../game/occupancy'
import { PIECES, WEAPONS, weaponVision } from '../../game/pieces'
import type { TeamId, Vec2 } from '../../game/types'
import { Cell, Health, PieceType, Target, Team } from '../components'
import type { Entity } from '../world'
import type { SimContext } from '../types'

/** A ranked enemy that can hurt `piece` this moment. */
export interface Threat {
  entity: Entity
  team: TeamId
  cell: Vec2
  damage: number
  /** The enemy's weapon currently covers the piece's square (line of sight). */
  canHitNow: boolean
  /** The enemy was the last piece to damage it. */
  lastAttacker: boolean
  /** The enemy is adjacent. */
  adjacent: boolean
  distance: number
  score: number
  /** A slide/pawn shooter can be body-blocked; a leap (knight) cannot. */
  screenable: boolean
}

/** Per-tick cache of a piece's threat list, keyed by entity. */
export type ThreatMemo = Map<Entity, Threat[]>

/**
 * How close an enemy must be to count as a threat even without a shot. Self
 * preservation passes 0 (only actual shooters and the last attacker); the AI
 * king passes KING_THREAT_RADIUS so it reacts to approaching pieces too.
 */
export interface ThreatOptions {
  proximityRadius?: number
}

/**
 * Rank every enemy that can hurt `piece` right now: anyone whose weapon covers
 * it (any distance, line of sight respected), whoever last hit it while it is
 * still under fire, and anyone inside `proximityRadius`. Sorted most dangerous
 * first — can-hit-now, then adjacency, then weapon damage, then closeness.
 */
export function coverageThreats(
  ctx: SimContext,
  piece: Entity,
  team: TeamId,
  memo: ThreatMemo,
  options: ThreatOptions = {},
): Threat[] {
  const cached = memo.get(piece)
  if (cached) return cached

  const cell = ctx.world.get(piece, Cell)
  if (!cell) {
    memo.set(piece, [])
    return []
  }
  const pieceTarget = ctx.world.get(piece, Target)
  // Only treat the last hit as a threat while the piece is still "under fire";
  // otherwise it would flee forever.
  const lastAttacker =
    pieceTarget && ctx.tick < pieceTarget.underFireUntil ? pieceTarget.lastAttacker : null
  const radius = options.proximityRadius ?? 0
  // Fire lines are judged with the piece itself removed so vacating its square
  // opens the same shots an escapee would have to dodge.
  const selfFree = occupiedExcept(ctx.board, ctx.occupancy, piece)

  const threats: Threat[] = []
  for (const other of ctx.world.query(Cell, Team, PieceType)) {
    if (other === piece) continue
    const otherTeam = ctx.world.require(other, Team)
    if (otherTeam === team) continue
    const kind = ctx.world.require(other, PieceType).kind
    const def = PIECES[kind]
    if (!def) continue
    const oc = ctx.world.require(other, Cell)
    const gap = chebyshev(oc.x, oc.y, cell.x, cell.y)
    const isLast = other === lastAttacker
    const geom = WEAPONS[def.weapon].geometry
    // Nothing beyond the weapon's own reach can matter; skip the fire sweep.
    if (!isLast && gap > radius && gap > weaponVision(geom)) continue
    const canHitNow = containsCell(fireCells(ctx.board, oc, geom, otherTeam, selfFree), cell.x, cell.y)
    // Only react to a distant enemy if it is actually covering the piece (a
    // sniper) or just hit it; otherwise it is not a threat yet.
    if (!canHitNow && !isLast && gap > radius) continue
    const adjacent = gap <= 1
    const distance = Math.hypot(oc.x - cell.x, oc.y - cell.y)
    const damage = WEAPONS[def.weapon].damage
    threats.push({
      entity: other,
      team: otherTeam,
      cell: { x: oc.x, y: oc.y },
      damage,
      canHitNow,
      lastAttacker: isLast,
      adjacent,
      distance,
      score: (canHitNow ? 100 : 0) + (isLast ? 15 : 0) + (adjacent ? 25 : 0) + damage - distance,
      screenable: geom.kind !== 'leap',
    })
  }
  threats.sort((a, b) => b.score - a.score)
  memo.set(piece, threats)
  return threats
}

/** One-volley damage from every enemy currently covering the piece. */
export function outgunned(ctx: SimContext, piece: Entity, threats: Threat[]): boolean {
  const hp = ctx.world.get(piece, Health)
  if (!hp) return false
  let incoming = 0
  for (const t of threats) if (t.canHitNow) incoming += t.damage
  return incoming >= hp.cur
}

/** Pieces worth protecting before they are actually below the HP threshold. */
export function isValuable(kind: string): boolean {
  return kind === 'queen' || kind === 'rook' || kind === 'bishop' || kind === 'knight' || kind === 'king'
}

/** Middle of a team's own back rank — the AI king's post. */
export function homeCell(ctx: SimContext, team: TeamId): Vec2 | null {
  const lanes = ctx.board.data.lanes[team]
  return lanes.length > 0 ? lanes[Math.floor(lanes.length / 2)] : null
}

/**
 * How far a hurt piece still watches for enemies while it is holding ground. It
 * backs away from anything inside this ring even if nothing can shoot it yet.
 */
export const COVER_RADIUS = 6

// Kept small: a square merely beside a threat is still safer than one inside its
// actual firing line (lowest weapon damage is 7).
const ADJACENT_PENALTY = 5

/**
 * The best legal one-step escape from the given threats. Scores each square by
 * the total weapon damage that covers it (so it dodges *all* shooters, not just
 * one), then by whether it keeps `keepShot` in firing geometry, then by how far
 * it is from the threats. Moves only when the step actually improves things;
 * otherwise returns null (hold and fight).
 */
export function escapeGoal(
  ctx: SimContext,
  piece: Entity,
  team: TeamId,
  threats: Threat[],
  keepShot: Entity | null,
): Vec2 | null {
  const kind = ctx.world.get(piece, PieceType)?.kind
  const def = kind ? PIECES[kind] : undefined
  const cell = ctx.world.get(piece, Cell)
  if (!def || !cell || threats.length === 0) return null

  const selfFree = occupiedExcept(ctx.board, ctx.occupancy, piece)
  // Every threat's firing geometry counts, not only the ones already covering
  // the piece: a nearby enemy that cannot hit it *yet* can still hit the square
  // it is about to step into.
  const coverages = threats.map((t) => {
    const od = PIECES[ctx.world.require(t.entity, PieceType).kind]
    const cells = od ? fireCells(ctx.board, t.cell, WEAPONS[od.weapon].geometry, t.team, selfFree) : []
    return { cells, weight: t.damage }
  })

  const dangerAt = (x: number, y: number): number => {
    let danger = 0
    for (const cov of coverages) {
      if (containsCell(cov.cells, x, y)) danger += cov.weight
    }
    for (const t of threats) {
      if (chebyshev(x, y, t.cell.x, t.cell.y) <= 1) danger += ADJACENT_PENALTY
    }
    return danger
  }
  const minThreatDist = (x: number, y: number): number => {
    let min = Infinity
    for (const t of threats) min = Math.min(min, Math.hypot(x - t.cell.x, y - t.cell.y))
    return min
  }

  const keepCell = keepShot !== null ? ctx.world.get(keepShot, Cell) ?? null : null
  const keepsShot = (x: number, y: number): boolean => {
    if (!keepCell) return false
    return containsCell(fireCells(ctx.board, { x, y }, WEAPONS[def.weapon].geometry, team, selfFree), keepCell.x, keepCell.y)
  }

  const options = moveDestinations(ctx.board, cell, def.move, team, makeOccupied(ctx.board, ctx.occupancy))
  const currentDanger = dangerAt(cell.x, cell.y)
  const currentKeeps = keepsShot(cell.x, cell.y)
  const currentDist = minThreatDist(cell.x, cell.y)

  let best: Vec2 | null = null
  let bestDanger = Infinity
  let bestKeeps = false
  let bestDist = -Infinity
  for (const c of options) {
    const danger = dangerAt(c.x, c.y)
    const keeps = keepsShot(c.x, c.y)
    const dist = minThreatDist(c.x, c.y)
    const better =
      danger < bestDanger ||
      (danger === bestDanger && keeps && !bestKeeps) ||
      (danger === bestDanger && keeps === bestKeeps && dist > bestDist + 1e-9)
    if (better) {
      best = c
      bestDanger = danger
      bestKeeps = keeps
      bestDist = dist
    }
  }

  if (best === null) return null
  if (bestDanger < currentDanger) return best
  if (bestDanger === currentDanger) {
    if (bestKeeps && !currentKeeps) return best
    if (bestKeeps === currentKeeps && bestDist > currentDist + 1e-9) return best
  }
  return null
}
