import { ATTACK_LEASH, TEAM_IDS, THREAT_TOLERANCE } from '../../game/constants'
import { friendlyCoverageCells } from '../../game/defended'
import { chebyshev } from '../../game/geometry'
import { enemyCoverage } from '../../game/kingSafety'
import { healthRatio, vecEquals } from '../../game/math'
import { makeOccupied } from '../../game/occupancy'
import { HEAL_RADIUS, kingOf } from '../../game/healing'
import { attackPlan, inFiringGeometry } from '../../game/approach'
import { coordName } from '../../game/coords'
import { PIECES, WEAPONS } from '../../game/pieces'
import type { PieceDef } from '../../game/pieces'
import { destReachable as canReach } from '../../game/pathfind'
import { noteOrder, clearMotion, clearOrder, promoteNext, rechainQueue } from '../../game/queue'
import { hasInstaKill, instaKillLandedNote } from '../../game/instaKill'
import { orderInsists, noPreserveEndedNote, noPreserveEndedSuppressedNote, noPreserveSuppressedNote } from '../../game/noPreserve'
import { CRITICAL_WOUND, HIT_STREAK_TRIGGER, preserveThreshold, recoverThreshold } from '../../game/selfPreservation'
import { Cell, Health, Motion, Order, PieceType, Target, Team, hasLiveCell } from '../components'
import type { MotionData, MotionIntent, OrderData } from '../components'
import type { Entity } from '../world'
import type { TeamId, Vec2 } from '../../game/types'
import type { SimContext } from '../types'
import type { System } from '../pipeline'
import { aiKingGoal, isScreening, KING_GUARD_RADIUS, kingThreats, loneKingGoal, screenPlan } from './kingDefense'
import {
  COVER_RADIUS,
  coverageThreats,
  escapeGoal,
  inHealingAura,
  isValuable,
  nearestDefendedCell,
  nearestHealingCell,
  outgunned,
  pieceDanger,
  threatAvoid,
} from './preservation'
import type { DangerMap, ThreatMemo } from './preservation'

/** Ticks a preserve/defense goal is honoured before it may be re-evaluated. */
const RETREAT_COMMIT_TICKS = 60

/** The committed goal while its window is still open, else null. */
function committedGoal(motion: MotionData, intent: MotionIntent, tick: number): Vec2 | null {
  if (!motion.goal || motion.intent !== intent || tick >= motion.goalSetTick + RETREAT_COMMIT_TICKS) {
    return null
  }
  return motion.goal
}

/** The closer of the king-aura and defended heal goals; ties prefer the aura. */
function pickHealGoal(from: Vec2, aura: Vec2 | null, defended: Vec2 | null): Vec2 | null {
  if (!aura) return defended
  if (!defended) return aura
  const da = chebyshev(from.x, from.y, aura.x, aura.y)
  const dd = chebyshev(from.x, from.y, defended.x, defended.y)
  return dd < da ? defended : aura
}

/** Assign a goal/intent, timestamping the change so commitment can hold it. */
function setGoal(motion: MotionData, goal: Vec2 | null, intent: MotionIntent, tick: number): void {
  if (goal === null || !motion.goal || !vecEquals(goal, motion.goal) || motion.intent !== intent) {
    motion.goalSetTick = tick
  }
  motion.goal = goal
  motion.intent = intent
}

/** A piece's def, cell and team, or null when any of them is missing. */
function pieceContext(ctx: SimContext, e: Entity): { def: PieceDef; cell: Vec2; team: TeamId } | null {
  const kind = ctx.world.get(e, PieceType)?.kind
  const def = kind ? PIECES[kind] : undefined
  const cell = ctx.world.get(e, Cell)
  const team = ctx.world.get(e, Team)
  return def && cell && team ? { def, cell, team } : null
}

/** Re-plan the remaining queue from the piece's current cell after a promotion. */
function rechain(ctx: SimContext, e: Entity, order: OrderData): void {
  const pc = pieceContext(ctx, e)
  if (!pc) return
  rechainQueue(ctx.board, pc.cell, order.queue, pc.def, pc.team, (target) => ctx.world.get(target, Cell) ?? null)
}

/**
 * Whether this piece's movement geometry can ever reach `dest`, ignoring other
 * pieces (walls still block). A destination that fails this can never be
 * fulfilled, so a queued waypoint is skipped instead of stalling the queue. A
 * merely blocked waypoint is reachable here and therefore waits, exactly like a
 * single goto order.
 */
function destReachable(ctx: SimContext, e: Entity, dest: { x: number; y: number }): boolean {
  const pc = pieceContext(ctx, e)
  if (!pc) return true
  return canReach(ctx.board, pc.cell, pc.def.move, pc.team, dest)
}

function inFiringGeometryNow(ctx: SimContext, e: Entity, target: Entity, team: 'red' | 'blue'): boolean {
  const kind = ctx.world.require(e, PieceType).kind
  const def = PIECES[kind]
  if (!def) return false
  const cell = ctx.world.require(e, Cell)
  const tcell = ctx.world.require(target, Cell)
  const occupied = makeOccupied(ctx.board, ctx.occupancy)
  return inFiringGeometry(ctx.board, cell, tcell, WEAPONS[def.weapon].geometry, team, occupied)
}

/**
 * Stop and shoot when in geometry; otherwise move to a cell from which the
 * target can be hit (not onto the occupied target itself, which would deadlock).
 * Goal selection is `attackPlan` — the same policy as `Game.planAttack` — so the
 * executed route never diverges from the preview shown when the order was issued.
 *
 * A target with no firing position anywhere for this piece (positionally
 * unreachable: opposite colour, walled off) is still approached best-effort: the
 * route ends on the closest reachable empty square, and the overlay draws that
 * route followed by the dashed "unreachable" firing line. Self-preservation runs
 * before this pass, so a hurt piece is interrupted while it heals and resumes the
 * approach once recovered; `closestEmptyCell` holds on distance ties, so a piece
 * already standing on a closest square parks there instead of shuttling.
 */
function pursue(
  ctx: SimContext,
  e: Entity,
  target: Entity,
  team: 'red' | 'blue',
  avoid?: (x: number, y: number) => boolean,
): { x: number; y: number } | null {
  const kind = ctx.world.require(e, PieceType).kind
  const def = PIECES[kind]
  if (!def) return null
  const cell = ctx.world.require(e, Cell)
  const tcell = ctx.world.require(target, Cell)
  const occupied = makeOccupied(ctx.board, ctx.occupancy)
  const weaponGeom = WEAPONS[def.weapon].geometry
  const recent = ctx.world.get(e, Motion)?.prevCell ?? null
  // A king must also avoid firing cells that would put it in check.
  let blocked = avoid
  if (kind === 'king') {
    const covered = enemyCoverage(ctx.board, ctx.world, ctx.occupancy, e, team)
    blocked = (x, y) => (avoid ? avoid(x, y) : false) || covered.has(ctx.board.cellIndex(x, y))
  }
  const plan = attackPlan(ctx.board, cell, tcell, def.move, weaponGeom, team, occupied, blocked, recent)
  return plan.inRange ? null : plan.cell
}

/**
 * An `avoid` predicate rejecting squares where enemy fire exceeds the small
 * threat tolerance, so goal selection keeps a piece out of every enemy firing
 * position — the enemy king's guard ring included — not merely out of the
 * squares that would kill it. Callers fall back to a threatened square only
 * when no safer option exists.
 */
function addThreat(
  ctx: SimContext,
  danger: DangerMap,
  from: Vec2,
): (x: number, y: number) => boolean {
  return threatAvoid(ctx, danger, THREAT_TOLERANCE, from)
}

/**
 * Flag a goal the planner could only satisfy inside enemy fire as exempt from
 * the runtime threat guard. The planner falls back to a threatened square only
 * when no safer firing position exists, so the move is necessary (a short-range
 * finisher, or a piece whose attack geometry only reaches from a covered
 * square) and must be allowed through.
 */
function markThreatExempt(
  motion: MotionData,
  goal: Vec2 | null,
  avoid?: (x: number, y: number) => boolean,
): void {
  if (goal !== null && avoid !== undefined && avoid(goal.x, goal.y)) motion.threatExempt = true
}

/**
 * Where an AI piece with no target heads: the enemy king's square while it is
 * alive, so the army always converges on the win condition, falling back to the
 * enemy lane midpoint when the king is already gone. This is endgame-biased by
 * construction: any live field enemy within vision still wins acquisition, so
 * pieces keep fighting the army first and only march on the king once nothing
 * else is in reach.
 */
function rally(ctx: SimContext, team: 'red' | 'blue'): { x: number; y: number } | null {
  const enemy = team === 'red' ? 'blue' : 'red'
  const king = kingOf(ctx.world, enemy)
  const kc = king !== null ? ctx.world.get(king, Cell) : null
  return kc ? { x: kc.x, y: kc.y } : ctx.board.laneMidpoint(enemy)
}

/**
 * Would self-preservation pull this piece off its order right now? This mirrors
 * the gate and act decision in `update` (pass 0) and is used by the game to
 * offer the player the "no-preserve" insist prompt when they give an order. It
 * is a forecast for a hint, not the simulation, so keep it in step with the
 * pass below when that changes.
 */
export function wouldSelfPreserve(ctx: SimContext, e: Entity): boolean {
  if (!ctx.autoPreserve) return false
  const order = ctx.world.get(e, Order)
  const motion = ctx.world.get(e, Motion)
  const target = ctx.world.get(e, Target)
  const hp = ctx.world.get(e, Health)
  const cell = ctx.world.get(e, Cell)
  const team = ctx.world.get(e, Team)
  const kind = ctx.world.get(e, PieceType)?.kind
  if (!order || !motion || !target || !hp || !cell || !team || !kind) return false
  if (hasInstaKill(order)) return false
  if (orderInsists(order, ctx.turn)) return false

  const enemyTeam: TeamId = team === 'red' ? 'blue' : 'red'
  const kings = { red: kingOf(ctx.world, 'red'), blue: kingOf(ctx.world, 'blue') }
  const fieldCount: Record<TeamId, number> = { red: 0, blue: 0 }
  for (const o of ctx.world.query(PieceType, Team, Health)) {
    if (ctx.world.require(o, PieceType).kind === 'king') continue
    if (ctx.world.require(o, Health).cur <= 0) continue
    fieldCount[ctx.world.require(o, Team)]++
  }
  const controller = ctx.teams[team].controller
  const isKing = kind === 'king'
  const lastStandKing = isKing && fieldCount[team] === 0
  const enemyKing = kings[enemyTeam]
  const endgame = enemyKing !== null && fieldCount[enemyTeam] === 0
  if (endgame || lastStandKing || (controller === 'ai' && isKing)) return false

  const hpRatio = healthRatio(hp, 1)
  const preserve = preserveThreshold(kind)
  const valuable = isValuable(kind)
  const holding = motion.holdUntilHp > 0 && hp.cur < motion.holdUntilHp
  const attacker = target.lastAttacker
  const underFire =
    attacker !== null && ctx.tick < target.underFireUntil && hasLiveCell(ctx.world, attacker)
  if (!(valuable || underFire || hpRatio < preserve || holding)) return false

  const threats = coverageThreats(ctx, e, team, new Map(), { proximityRadius: COVER_RADIUS })
  const shooters = threats.reduce((n, t) => n + (t.canHitNow ? 1 : 0), 0)
  const pressedByHits = kind !== 'pawn' && motion.hitStreak >= HIT_STREAK_TRIGGER
  const lethal = outgunned(ctx, e, threats)
  const pressured = lethal || (valuable && shooters >= 2) || pressedByHits
  const wounded = hpRatio < preserve

  const king = kings[team]
  const kc = king !== null ? ctx.world.get(king, Cell) : null
  const inAura = !!kc && chebyshev(cell.x, cell.y, kc.x, kc.y) <= HEAL_RADIUS
  const friendlyCover = ctx.defendedHeal
    ? friendlyCoverageCells(ctx.board, ctx.world, ctx.occupancy, team, e)
    : null
  const defendedHere = !!friendlyCover?.has(ctx.board.cellIndex(cell.x, cell.y))
  const sanctuary = inAura || defendedHere
  // A move that ends inside a sanctuary is honoured, not overridden, unless the
  // volley would kill the piece — the same exception the pass makes.
  const destDefended =
    order.dest !== null &&
    !!friendlyCover &&
    friendlyCover.has(ctx.board.cellIndex(order.dest.x, order.dest.y))
  const sanctuaryBound =
    order.kind === 'goto' &&
    order.dest !== null &&
    ((!!kc && inHealingAura(order.dest, kc)) || destDefended)
  if (sanctuaryBound && !lethal) return false

  let heal: Vec2 | null = null
  if ((holding || wounded) && !sanctuary && kind !== 'pawn') {
    const auraCell = kc ? nearestHealingCell(ctx, e, team, kc) : null
    const defendedCell = friendlyCover ? nearestDefendedCell(ctx, e, team, friendlyCover) : null
    heal = pickHealGoal(cell, auraCell, defendedCell)
  }

  const shouldDodge = sanctuary
    ? lethal || pressedByHits
    : shooters > 0 || underFire || pressedByHits
  return holding || heal !== null || ((wounded || pressured) && (shouldDodge || sanctuary))
}

const system: System = {
  name: 'orders',
  update(ctx) {
    // Per-tick caches: the king's enemy threat list is shared by every AI piece
    // so bodyguards do not rescan the board. Rebuilt each update, so undo/redo
    // and replay never see a stale entry.
    const kingThreatMemo: ThreatMemo = new Map()
    const pieceThreatMemo: ThreatMemo = new Map()
    // Damage-weighted enemy coverage per piece, shared between the pursue call
    // sites below so a piece's lethal squares are computed once per tick.
    const dangerMemo = new Map<Entity, DangerMap>()
    const dangerFor = (piece: Entity, t: TeamId): DangerMap => {
      let d = dangerMemo.get(piece)
      if (d === undefined) {
        d = pieceDanger(ctx, piece, t)
        dangerMemo.set(piece, d)
      }
      return d
    }
    const kings = { red: kingOf(ctx.world, 'red'), blue: kingOf(ctx.world, 'blue') }
    // Living non-king pieces per team. Once a team is down to its king alone,
    // self-preservation is switched off for the pieces hunting it — the endgame
    // finish. Without this a wounded valuable piece can latch a safe-hold in its
    // own aura and never take the shot that would end the game.
    const fieldCount: Record<TeamId, number> = { red: 0, blue: 0 }
    for (const o of ctx.world.query(PieceType, Team, Health)) {
      if (ctx.world.require(o, PieceType).kind === 'king') continue
      if (ctx.world.require(o, Health).cur <= 0) continue
      fieldCount[ctx.world.require(o, Team)]++
    }
    // Timestamp each side's arrival at king-only so `damage` can apply finish
    // pressure without duplicating the board scan. Reset if it ever has field
    // pieces again (undo, editor drops).
    for (const id of TEAM_IDS) {
      const runtime = ctx.teams[id]
      if (kings[id] !== null && fieldCount[id] === 0) {
        // `>= 0` also repairs older snapshots that predate the field.
        if (!(runtime.kingOnlySince >= 0)) runtime.kingOnlySince = ctx.tick
      } else {
        runtime.kingOnlySince = -1
      }
    }
    // Squares already earmarked for screening this turn, so guards spread out.
    const claimed = new Set<number>()
    // Cells each team's weapons cover (chess-protected squares), when the
    // defended-heal rule is on. Built once per tick from the tick-start
    // occupancy this pass runs under and shared by every piece.
    const friendlyCover: Record<TeamId, Set<number>> | null = ctx.defendedHeal
      ? {
          red: friendlyCoverageCells(ctx.board, ctx.world, ctx.occupancy, 'red'),
          blue: friendlyCoverageCells(ctx.board, ctx.world, ctx.occupancy, 'blue'),
        }
      : null

    for (const e of ctx.world.query(Order, Motion, Cell, Team, Target)) {
      const order = ctx.world.require(e, Order)
      const motion = ctx.world.require(e, Motion)
      const cell = ctx.world.require(e, Cell)
      const team = ctx.world.require(e, Team)
      const target = ctx.world.require(e, Target)
      const enemyTeam: TeamId = team === 'red' ? 'blue' : 'red'
      // A goal that deliberately enters enemy fire (a bodyguard screen or a
      // necessary lone-king finish) is re-armed below; clear last tick's flag so
      // the general threat guard applies to ordinary goals again.
      motion.threatExempt = false

      // 0a. Consume an insta-kill (immediate chess kill): it was decided when the
      // order was issued and lands here on the next tick. It is the highest
      // priority order in the game — it overrides self-preservation below, so a
      // suicide kill is allowed — so capture that fact before the victim is
      // cleared. The command queue is not part of the turn snapshot, but the
      // pending victim (on the order) is.
      const instaKill = hasInstaKill(order)
      if (order.chessKill !== null) {
        const victim = order.chessKill
        order.chessKill = null
        if (ctx.world.isAlive(victim)) {
          const vcell = ctx.world.get(victim, Cell)
          if (vcell) {
            noteOrder(order, ctx.tick, instaKillLandedNote(coordName(vcell.x, vcell.y, ctx.board.height)))
          }
          const hp = ctx.world.get(victim, Health)
          ctx.cmds.damage.push({
            target: victim,
            source: e,
            amount: hp?.cur ?? 1,
            kind: 'chess',
            direct: true,
            lethal: true,
          })
        }
      }

      // 0. Self-preservation: a hurt or outgunned piece retreats on its own, even
      // while it is moving or pursuing a standing attack order. A wounded piece
      // outside the king's aura walks home to heal and latches a recovery hold
      // until it is back above `recoverThreshold`; a critical wound (below
      // CRITICAL_WOUND) latches until fully healed. A new order clears the hold.
      // The one exception is an
      // insta-kill (immediate chess kill): it is pressed regardless of wounds —
      // a suicide kill is allowed — and it still lands because 0a queued the
      // lethal damage before this pass.
      const hp = ctx.world.get(e, Health)
      const hpRatio = healthRatio(hp, 1)
      const attacker = target.lastAttacker
      const underFire =
        attacker !== null &&
        ctx.tick < target.underFireUntil &&
        hasLiveCell(ctx.world, attacker)
      const kind = ctx.world.get(e, PieceType)?.kind
      const targetValid = hasLiveCell(ctx.world, target.entity)
      const preserve = kind ? preserveThreshold(kind) : 0
      // Valuable pieces scan every tick so they can bail *before* taking damage;
      // cheap pieces only bother once hurt or actually under fire.
      const valuable = kind !== undefined && isValuable(kind)
      // Release a latched safe-hold once the piece reaches its latch HP (full
      // health for a critical wound, the recovery threshold for a lesser one).
      if (motion.holdUntilHp > 0 && hp && hp.cur >= motion.holdUntilHp) motion.holdUntilHp = 0
      const holding = motion.holdUntilHp > 0
      // Whether this piece was preserving last tick, so the retreat is logged as
      // one episode (start / end) rather than on every goal re-evaluation.
      const wasPreserve = motion.intent === 'preserve'
      const controller = ctx.teams[team].controller
      const isKing = kind === 'king'
      // A lone king with no field pieces never runs: it is faster than every
      // attacker, so dodging forever turned material wins into turn-cap draws.
      // It is exempt from the preserve pass and last-stands instead (below).
      const lastStandKing = isKing && fieldCount[team] === 0
      // The enemy is down to its king alone: the finishing phase. Attackers hunt
      // the king directly and ignore self-preservation; the lone king holds.
      const enemyKing = kings[enemyTeam]
      const endgame = enemyKing !== null && fieldCount[enemyTeam] === 0
      // A player can insist on an order (Alt-click): self-preservation is
      // suspended until `noPreserveUntil`, and a healing hold latched before the
      // order was given is released so it cannot veto the order anyway. When the
      // window lapses, restore normal behaviour and record it once so the order
      // history tells the whole story. See `src/game/noPreserve.ts`.
      const insists = orderInsists(order, ctx.turn)
      if (insists) {
        motion.holdUntilHp = 0
      } else if (order.noPreserveUntil >= 0 && ctx.turn >= order.noPreserveUntil) {
        // Say "restored" only when the rule can actually run; a finishing phase,
        // the auto-preserve toggle being off, or an AI king's post still
        // suppresses it, and the history should not promise otherwise.
        const canPreserve =
          ctx.autoPreserve && !endgame && !lastStandKing && !(controller === 'ai' && isKing)
        noteOrder(
          order,
          ctx.tick,
          canPreserve ? noPreserveEndedNote() : noPreserveEndedSuppressedNote(endgame || lastStandKing),
        )
        order.noPreserveUntil = -1
      }
      if (
        ctx.autoPreserve &&
        !instaKill &&
        !endgame &&
        !lastStandKing &&
        kind &&
        !(controller === 'ai' && isKing) &&
        !insists &&
        (valuable || underFire || hpRatio < preserve || holding)
      ) {
        // Judge the escape against every enemy currently covering this piece, not
        // just the last one to shoot. Valuable pieces also bail when outgunned or
        // focused by two or more shooters, before their HP drops.
        // Wide scan: even enemies not yet shooting count as cover pressure, so a
        // hurt piece backs away from the danger instead of standing in it.
        const threats = coverageThreats(ctx, e, team, pieceThreatMemo, { proximityRadius: COVER_RADIUS })
        const shooters = threats.reduce((n, t) => n + (t.canHitNow ? 1 : 0), 0)
        // Sustained fire is pressure in its own right: a piece that keeps being
        // hit reconsiders its square even above the retreat threshold.
        const pressedByHits = kind !== 'pawn' && motion.hitStreak >= HIT_STREAK_TRIGGER
        const pressured = outgunned(ctx, e, threats) || (valuable && shooters >= 2) || pressedByHits
        const wounded = hpRatio < preserve
        // The king's healing aura is a sanctuary: inside it a piece holds rather
        // than repositioning unless the volley it faces would kill it (outgunned)
        // or the hits are outpacing the heal. Outside it dodges whenever an enemy
        // covers the square now or it is under fire.
        const king = kings[team]
        const kc = king !== null ? ctx.world.get(king, Cell) : null
        const inAura = !!kc && chebyshev(cell.x, cell.y, kc.x, kc.y) <= HEAL_RADIUS
        // A defended square (friendly weapon covering it) regenerates too, so it
        // is a sanctuary exactly like the aura when the rule is on.
        const defendedHere =
          !!friendlyCover && friendlyCover[team].has(ctx.board.cellIndex(cell.x, cell.y))
        const sanctuary = inAura || defendedHere
        const shouldDodge = sanctuary
          ? outgunned(ctx, e, threats) || pressedByHits
          : shooters > 0 || underFire || pressedByHits
        // Healing trip: a hurt or latched piece outside a sanctuary walks to the
        // nearest one. The king aura is preferred on ties (a stable post); a
        // defended square is the fallback when the aura is unreachable or closer.
        // Computed before the act decision so a merely wounded piece that is not
        // yet dodging still goes to heal instead of freezing where it stands.
        let heal: { x: number; y: number } | null = null
        if ((holding || wounded) && !sanctuary && kind !== 'pawn') {
          const auraCell = kc ? nearestHealingCell(ctx, e, team, kc) : null
          const defendedCell = friendlyCover ? nearestDefendedCell(ctx, e, team) : null
          heal = pickHealGoal(cell, auraCell, defendedCell)
        }
        // Act (heal trip, dodge or hold) while latched, while wounded/pressured
        // and either in danger or in the aura, or while a healing square is
        // reachable. Otherwise fall through and let the order resume.
        const act =
          holding || heal !== null || ((wounded || pressured) && (shouldDodge || sanctuary))
        if (act) {
          // A critically wounded piece holds until fully healed.
          if (hp && (wounded || pressured) && hpRatio < CRITICAL_WOUND) motion.holdUntilHp = hp.max
          const lethal = outgunned(ctx, e, threats)
          // Healing-aware hold: a latched piece outside the aura
          // walks to the nearest healing square so it can regenerate and release
          // the hold, instead of parking where it can never heal. An explicit move
          // order that already ends inside the aura is left to run, and only a
          // volley that would kill it this tick breaks it off to dodge.
          const destDefended =
            order.dest !== null &&
            !!friendlyCover &&
            friendlyCoverageCells(ctx.board, ctx.world, ctx.occupancy, team, e).has(
              ctx.board.cellIndex(order.dest.x, order.dest.y),
            )
          const sanctuaryBound =
            order.kind === 'goto' &&
            order.dest !== null &&
            ((!!kc && inHealingAura(order.dest, kc)) || destDefended)
          if (sanctuaryBound && !lethal) {
            // Fall through: honour the player's move order into the healing aura.
          } else {
            let goal: { x: number; y: number } | null = null
            let intent: MotionIntent = 'none'
            let noSaferStep = false
            const escapeOptions = {
              prevCell: motion.prevCell,
              sticky: committedGoal(motion, 'preserve', ctx.tick),
            }
            if (heal) {
              goal =
                lethal && shouldDodge
                  ? escapeGoal(ctx, e, team, threats, null, escapeOptions) ?? heal
                  : heal
              intent = 'preserve'
            }
            if (intent === 'none' && shouldDodge) {
              // Seek cover: step to the least-exposed nearby square, keeping a shot
              // when free; hold when every step is no safer (or nobody is near).
              // Pawns cannot retreat, so an "escape" only marches them into the
              // enemy and gives up the shot — they hold and fire instead.
              // Keep the shot while backing off: an attack order holds its target
              // in range as a tie-break.
              const keepShot =
                targetValid && order.kind === 'attack' ? (target.entity as number) : null
              goal = kind === 'pawn' ? null : escapeGoal(ctx, e, team, threats, keepShot, escapeOptions)
              if (goal !== null) intent = 'preserve'
              else noSaferStep = true
            }
            // Safe or healing with no step: hold rather than drift (intent none).
            setGoal(motion, goal, intent, ctx.tick)
            // Recovery latch: a wounded piece in this preserve pass that can
            // actually heal (in the aura, or with an aura square within reach)
            // stays in preserve until it has healed to `recoverThreshold` —
            // roughly one more hit absorbed — rather than leaving the moment it
            // crosses the retreat trigger and walking straight back into the same
            // fire. A critical wound already latched to full health above, and
            // `Math.max` keeps that. Pieces with no sanctuary to reach do not
            // latch, so they can never park waiting for a heal that cannot come.
            const canHeal = sanctuary || heal !== null
            if (wounded && canHeal && hp && kind !== 'pawn') {
              motion.holdUntilHp = Math.max(motion.holdUntilHp, hp.max * recoverThreshold(kind))
            }
            // Record the retreat as an episode — one entry when it starts, one
            // when it ends. Intra-episode goal re-evaluations are not logged, so a
            // goal abandoned before it is ever pursued can never leave a false
            // "retreat" as the newest entry in the order history.
            if (intent === 'preserve' && !wasPreserve && goal) {
              noteOrder(
                order,
                ctx.tick,
                `self-preservation: retreating → ${coordName(goal.x, goal.y, ctx.board.height)}`,
              )
            } else if (intent !== 'preserve' && wasPreserve) {
              noteOrder(
                order,
                ctx.tick,
                noSaferStep
                  ? 'self-preservation: no safer step — holding'
                  : order.kind === 'attack' && !order.reachable
                    ? 'self-preservation: safe — holding (target unreachable)'
                    : shouldDodge
                      ? 'self-preservation: still under fire — holding'
                      : order.kind === 'none'
                        ? 'self-preservation: safe — holding'
                        : 'self-preservation: safe — resuming order',
              )
            }
            continue
          }
        }
      }
      // Reached when the preserve pass did not act this tick, or is honouring an
      // aura-bound move order: if the piece was preserving last tick, that episode
      // is over. (The in-block branch above only covers the cases that `continue`.)
      if (wasPreserve) {
        noteOrder(
          order,
          ctx.tick,
          insists
            ? noPreserveSuppressedNote(order.noPreserveUntil)
            : order.kind === 'none'
              ? 'self-preservation: no longer needed — holding'
              : order.kind === 'attack' && !order.reachable
                ? 'self-preservation: no longer needed — holding (target unreachable)'
                : 'self-preservation: no longer needed — resuming order',
        )
      }

      // 1. Explicit attack order: glue to the target until it dies.
      if (order.kind === 'attack') {
        const t = order.target
        if (hasLiveCell(ctx.world, t)) {
          // Best-effort approach: stop and fire when in geometry, else head to a
          // firing cell, else the closest reachable empty square. A positionally
          // unreachable target (e.g. a bishop on the wrong colour) is therefore
          // still approached as close as the piece can get, and the overlay draws
          // that route followed by a dashed "unreachable" firing line. Targeting
          // recomputes `reachable` every tick, so the route and overlay update as
          // the piece and target move.
          //
          // Keep out of every enemy firing position, the king's guard ring
          // included, not merely the lethal ones. A player who insisted
          // (Alt-click) may always force entry.
          const avoid = insists ? undefined : addThreat(ctx, dangerFor(e, team), cell)
          motion.goal = pursue(ctx, e, t, team, avoid)
          markThreatExempt(motion, motion.goal, avoid)
          motion.intent = motion.goal === null ? 'none' : 'order'
          continue
        }
        // The order is done; the next queued step takes over, else clear.
        // (Retargeting to the next nearby enemy is done by the targeting system.)
        if (promoteNext(order, motion)) {
          noteOrder(order, ctx.tick, 'attack target lost — executing queued step')
          rechain(ctx, e, order)
          continue
        }
        noteOrder(order, ctx.tick, 'attack target lost — order complete')
        clearOrder(order)
      }

      // 2. Goto order: advance toward the objective (best effort if unreachable).
      // A move fully replaces any earlier attack; there is no parked target to
      // resume and no kiting away from the ordered square.
      if (order.kind === 'goto') {
        const arrived =
          order.dest !== null && vecEquals(order.dest, cell) && !motion.moving
        // A fulfilled waypoint yields to the queue. A waypoint this piece's
        // geometry can never reach is skipped too (best-effort would idle
        // forever); a waypoint merely blocked by pieces keeps waiting.
        const unreachable = order.dest !== null && !destReachable(ctx, e, order.dest)
        if (arrived || (unreachable && order.queue.length > 0)) {
          if (promoteNext(order, motion)) {
            noteOrder(
              order,
              ctx.tick,
              unreachable && !arrived ? 'waypoint unreachable — skipped' : 'move complete — executing queued step',
            )
            rechain(ctx, e, order)
            if (unreachable && !arrived) ctx.bus.emit('warn', `#${e} skipping unreachable waypoint`)
            continue
          }
        }
        // Not there yet: keep advancing (a blocked, pathless piece simply waits).
        if (!arrived) {
          motion.goal = order.dest
          motion.intent = 'order'
          continue
        }

        // Arrived: the move is complete; the next queued step takes over, else clear.
        if (promoteNext(order, motion)) {
          noteOrder(order, ctx.tick, 'move complete — executing queued step')
          rechain(ctx, e, order)
          continue
        }
        noteOrder(order, ctx.tick, 'move complete')
        clearOrder(order)
        clearMotion(motion)
        continue
      }

      // 3. Autonomous play. Only the AI acts without an order; a human piece
      // follows its order or holds.
      if (controller !== 'ai') {
        clearMotion(motion)
        continue
      }

      // A side down to its king last-stands instead of kiting.
      if (lastStandKing) {
        const threats = kingThreats(ctx, e, team, kingThreatMemo)
        const goal = loneKingGoal(ctx, e, team, threats, {
          enemyKingOnly: enemyKing !== null && fieldCount[enemyTeam] === 0,
          prevCell: motion.prevCell,
        })
        setGoal(motion, goal, goal === null ? 'none' : 'defense', ctx.tick)
        continue
      }

      // The AI king defends its post instead of charging with the army. Once the
      // enemy is down to its king alone it advances to opposition (distance 2;
      // the no-check rule forbids closing further), supporting the finish.
      if (controller === 'ai' && isKing) {
        const threats = kingThreats(ctx, e, team, kingThreatMemo)
        const goal =
          endgame && enemyKing !== null
            ? loneKingGoal(ctx, e, team, threats, { enemyKingOnly: true, prevCell: motion.prevCell })
            : aiKingGoal(ctx, e, team, threats, {
                prevCell: motion.prevCell,
                sticky: committedGoal(motion, 'defense', ctx.tick),
              })
        setGoal(motion, goal, goal === null ? 'none' : 'defense', ctx.tick)
        continue
      }

      // Finishing phase: the enemy has only its king left, so hunt it directly.
      // This deliberately skips bodyguard duty and self-preservation — a wounded
      // attacker must still take the shot that ends the game. Pieces shoot from
      // outside enemy fire by default; only when the lone king's sole firing
      // square is itself threatened does the attacker close, because finishing
      // matters more than the safe square (the special king capture).
      if (endgame && enemyKing !== null) {
        target.entity = enemyKing
        target.retargetAt = ctx.tick + 12
        const avoid = addThreat(ctx, dangerFor(e, team), cell)
        const goal = pursue(ctx, e, enemyKing, team, avoid)
        // No safe firing square exists anywhere, so this closing move is the
        // finish; let movement carry it through the fire.
        markThreatExempt(motion, goal, avoid)
        setGoal(motion, goal, goal === null ? 'none' : 'engage', ctx.tick)
        continue
      }

      // Nearby AI pieces break off to defend the king. Guards within
      // KING_GUARD_RADIUS first try to screen the line of fire, else engage the
      // most dangerous threat; the rest of the army keeps pressing the attack.
      if (controller === 'ai') {
        const king = kings[team]
        const kc = king !== null ? ctx.world.get(king, Cell) : null
        if (king !== null && king !== e && kc && chebyshev(cell.x, cell.y, kc.x, kc.y) <= KING_GUARD_RADIUS) {
          // Already blocking a shot: stay planted rather than chasing.
          if (isScreening(ctx, e, team, kc)) {
            clearMotion(motion)
            continue
          }
          const threats = kingThreats(ctx, king, team, kingThreatMemo)
          if (threats.length > 0) {
            const top = threats[0]
            target.entity = top.entity
            target.retargetAt = ctx.tick + 12
            const plan = top.canHitNow
              ? screenPlan(ctx, e, team, top, kc, makeOccupied(ctx.board, ctx.occupancy), claimed)
              : { onSegment: false, cell: null }
            const avoid = addThreat(ctx, dangerFor(e, team), cell)
            const screenCell = plan.onSegment ? null : plan.cell
            const goal =
              screenCell ?? (plan.onSegment ? null : pursue(ctx, e, top.entity, team, avoid))
            // A screen cell is deliberately inside enemy fire; exempt it from the
            // general threat guard so the bodyguard can take the line.
            if (screenCell !== null) motion.threatExempt = true
            markThreatExempt(motion, goal, avoid)
            setGoal(motion, goal, goal === null ? 'none' : 'defense', ctx.tick)
            continue
          }
        }
      }

      if (!insists && targetValid && hpRatio < preserveThreshold(kind ?? '')) {
        // Low HP (auto-preserve off): seek nearby cover, keeping the shot if free.
        // Pawns cannot retreat, so they hold and fire instead. Only retreat when
        // something is actually covering the piece — with no threats, falling
        // through keeps it fighting instead of parked on the spot.
        // The `!insists` guard is defensive: this section only runs for an order
        // of kind `none`, which `clearOrder`/`promoteNext` already strip of the
        // flag, but it keeps a future refactor from silently re-exposing it.
        const threats = coverageThreats(ctx, e, team, pieceThreatMemo, { proximityRadius: COVER_RADIUS })
        if (threats.length > 0) {
          const goal =
            kind === 'pawn'
              ? null
              : escapeGoal(ctx, e, team, threats, target.entity as number, {
                  prevCell: motion.prevCell,
                  sticky: committedGoal(motion, 'preserve', ctx.tick),
                })
          setGoal(motion, goal, goal === null ? 'none' : 'preserve', ctx.tick)
          continue
        }
      }
      if (!targetValid) {
        // Nothing in reach: march on the enemy king.
        const goal = rally(ctx, team)
        setGoal(motion, goal, goal === null ? 'none' : 'rally', ctx.tick)
        continue
      }
      // Leash: don't chase an auto-acquired target clear across the board.
      const tcell = ctx.world.get(target.entity as number, Cell)
      const beyondLeash =
        tcell !== undefined &&
        chebyshev(cell.x, cell.y, tcell.x, tcell.y) > ATTACK_LEASH &&
        !inFiringGeometryNow(ctx, e, target.entity as number, team)
      const avoid = addThreat(ctx, dangerFor(e, team), cell)
      const goal = beyondLeash ? null : pursue(ctx, e, target.entity as number, team, avoid)
      markThreatExempt(motion, goal, avoid)
      setGoal(motion, goal, goal === null ? 'none' : 'engage', ctx.tick)
    }
  },
}

export default system
