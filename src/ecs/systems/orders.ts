import { ATTACK_LEASH, TEAM_IDS } from '../../game/constants'
import { chebyshev } from '../../game/geometry'
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
import { Cell, Health, Motion, Order, PieceType, Stance, Target, Team, hasLiveCell } from '../components'
import type { MotionIntent, OrderData } from '../components'
import type { Entity } from '../world'
import type { TeamId, Vec2 } from '../../game/types'
import type { SimContext } from '../types'
import type { System } from '../pipeline'
import { aiKingGoal, isScreening, KING_GUARD_RADIUS, kingThreats, screenPlan } from './kingDefense'
import {
  COVER_RADIUS,
  coverageThreats,
  escapeGoal,
  homeCell,
  inHealingAura,
  isValuable,
  nearestHealingCell,
  outgunned,
} from './preservation'
import type { ThreatMemo } from './preservation'

/** Flat HP fraction at or below which a piece is "critically wounded": it latches
 * a safe-hold to full health and will not advance its order until then. */
const CRITICAL_WOUND = 0.2

/** HP ratio at which a piece starts saving itself, scaled by how costly it is. */
function preserveThreshold(kind: string): number {
  switch (kind) {
    case 'queen':
    case 'king':
      return 0.5
    case 'rook':
      return 0.45
    case 'bishop':
    case 'knight':
      return 0.4
    default:
      return 0.3
  }
}

/**
 * HP ratio a wounded piece heals to before resuming, above the retreat trigger:
 * about one more hit absorbed (queen/king 0.70, rook 0.65, bishop/knight 0.60).
 * Without this hysteresis the heal trip is wasted — a piece crossing back over
 * the trigger immediately stops preserving and walks into the same fire again.
 */
function recoverThreshold(kind: string): number {
  return Math.min(0.8, preserveThreshold(kind) + 0.2)
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
  const def = PIECES[ctx.world.require(e, PieceType).kind]
  if (!def) return null
  const cell = ctx.world.require(e, Cell)
  const tcell = ctx.world.require(target, Cell)
  const occupied = makeOccupied(ctx.board, ctx.occupancy)
  const weaponGeom = WEAPONS[def.weapon].geometry
  const plan = attackPlan(ctx.board, cell, tcell, def.move, weaponGeom, team, occupied, avoid)
  return plan.inRange ? null : plan.cell
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

const system: System = {
  name: 'orders',
  update(ctx) {
    // Per-tick caches: the king's enemy threat list is shared by every AI piece
    // so bodyguards do not rescan the board. Rebuilt each update, so undo/redo
    // and replay never see a stale entry.
    const kingThreatMemo: ThreatMemo = new Map()
    const pieceThreatMemo: ThreatMemo = new Map()
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
    // The 3×3 ring around each king, in cell indices. A king's guard hits for
    // 80% of max HP at range 1, so a piece should treat those squares as a kill
    // zone and pick a firing position outside it.
    const kingDanger: Record<TeamId, Set<number>> = { red: new Set(), blue: new Set() }
    for (const id of TEAM_IDS) {
      const k = kings[id]
      const kc = k !== null ? ctx.world.get(k, Cell) : null
      if (!kc) continue
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const x = kc.x + dx
          const y = kc.y + dy
          if (ctx.board.inBounds(x, y)) kingDanger[id].add(ctx.board.cellIndex(x, y))
        }
      }
    }
    // Squares already earmarked for screening this turn, so guards spread out.
    const claimed = new Set<number>()

    for (const e of ctx.world.query(Stance, Order, Motion, Cell, Team, Target)) {
      const stance = ctx.world.require(e, Stance)
      const order = ctx.world.require(e, Order)
      const motion = ctx.world.require(e, Motion)
      const cell = ctx.world.require(e, Cell)
      const team = ctx.world.require(e, Team)
      const target = ctx.world.require(e, Target)
      const enemyTeam: TeamId = team === 'red' ? 'blue' : 'red'
      // Firing positions inside the enemy king's 3×3 are a kill zone (its guard
      // hits for 80% of max HP), so pursuit prefers to shoot from outside it.
      const enemyDanger = (x: number, y: number) => kingDanger[enemyTeam].has(ctx.board.cellIndex(x, y))

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
      // The enemy is down to its king alone: the finishing phase. Attackers hunt
      // the king directly and ignore self-preservation; the lone king holds.
      const enemyKing = kings[enemyTeam]
      const endgame = enemyKing !== null && fieldCount[enemyTeam] === 0
      if (
        ctx.autoPreserve &&
        !instaKill &&
        !endgame &&
        kind &&
        !(ctx.teams[team].controller === 'ai' && kind === 'king') &&
        (valuable || underFire || hpRatio < preserve || holding)
      ) {
        // Judge the escape against every enemy currently covering this piece, not
        // just the last one to shoot. Valuable pieces also bail when outgunned or
        // focused by two or more shooters, before their HP drops.
        // Wide scan: even enemies not yet shooting count as cover pressure, so a
        // hurt piece backs away from the danger instead of standing in it.
        const threats = coverageThreats(ctx, e, team, pieceThreatMemo, { proximityRadius: COVER_RADIUS })
        const shooters = threats.reduce((n, t) => n + (t.canHitNow ? 1 : 0), 0)
        const pressured = outgunned(ctx, e, threats) || (valuable && shooters >= 2)
        const wounded = hpRatio < preserve
        // The king's healing aura is a sanctuary: inside it a piece holds rather
        // than repositioning unless the volley it faces would kill it (outgunned).
        // Outside it dodges whenever an enemy covers the square now or it is under
        // fire.
        const king = kings[team]
        const kc = king !== null ? ctx.world.get(king, Cell) : null
        const inAura = !!kc && chebyshev(cell.x, cell.y, kc.x, kc.y) <= HEAL_RADIUS
        const shouldDodge = inAura ? outgunned(ctx, e, threats) : shooters > 0 || underFire
        // Healing trip: a hurt or latched piece outside the aura walks to the
        // nearest healing square. Computed before the act decision so a merely
        // wounded piece that is not yet dodging still goes to heal instead of
        // freezing where it stands.
        const heal =
          (holding || wounded) && !inAura && kc && kind !== 'pawn'
            ? nearestHealingCell(ctx, e, team, kc)
            : null
        // Act (heal trip, dodge or hold) while latched, while wounded/pressured
        // and either in danger or in the aura, or while a healing square is
        // reachable. Otherwise fall through and let the order resume.
        const act =
          holding || heal !== null || ((wounded || pressured) && (shouldDodge || inAura))
        if (act) {
          // A critically wounded piece holds until fully healed.
          if (hp && (wounded || pressured) && hpRatio < CRITICAL_WOUND) motion.holdUntilHp = hp.max
          const lethal = outgunned(ctx, e, threats)
          // Healing-aware hold: a latched piece outside the aura
          // walks to the nearest healing square so it can regenerate and release
          // the hold, instead of parking where it can never heal. An explicit move
          // order that already ends inside the aura is left to run, and only a
          // volley that would kill it this tick breaks it off to dodge.
          const auraBound =
            order.kind === 'goto' && order.dest !== null && !!kc && inHealingAura(order.dest, kc)
          if (auraBound && !lethal) {
            // Fall through: honour the player's move order into the healing aura.
          } else {
            let goal: { x: number; y: number } | null = null
            let intent: MotionIntent = 'none'
            let noSaferStep = false
            if (heal) {
              goal = lethal && shouldDodge ? escapeGoal(ctx, e, team, threats, null) ?? heal : heal
              intent = 'preserve'
            }
            if (intent === 'none' && shouldDodge) {
              // Seek cover: step to the least-exposed nearby square, keeping a shot
              // when free; hold when every step is no safer (or nobody is near).
              // Pawns cannot retreat, so an "escape" only marches them into the
              // enemy and gives up the shot — they hold and fire instead.
              // Keep the shot while backing off: an attack order (or Attack stance)
              // holds its target in range as a tie-break.
              const keepShot =
                targetValid && (order.kind === 'attack' || stance.mode === 'attack')
                  ? (target.entity as number)
                  : null
              goal = kind === 'pawn' ? null : escapeGoal(ctx, e, team, threats, keepShot)
              if (goal !== null) intent = 'preserve'
              else noSaferStep = true
            }
            // Safe or healing with no step: hold rather than drift (intent none).
            motion.goal = goal
            motion.intent = intent
            // Recovery latch: a wounded piece in this preserve pass that can
            // actually heal (in the aura, or with an aura square within reach)
            // stays in preserve until it has healed to `recoverThreshold` —
            // roughly one more hit absorbed — rather than leaving the moment it
            // crosses the retreat trigger and walking straight back into the same
            // fire. A critical wound already latched to full health above, and
            // `Math.max` keeps that. Pieces with no aura to reach do not latch, so
            // they can never park waiting for a heal that cannot come.
            const canHeal = inAura || heal !== null
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
                  : order.kind === 'none'
                    ? 'self-preservation: safe — holding'
                    : order.kind === 'attack' && !order.reachable
                      ? 'self-preservation: safe — holding (target unreachable)'
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
          order.kind === 'none'
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
          motion.goal = pursue(ctx, e, t, team)
          motion.intent = motion.goal === null ? 'none' : 'order'
          continue
        }
        // The order is done; the next queued step takes over, else clear. The
        // stance is kept so the piece stays in Attack either way.
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

      // 3. Autonomous stance.
      const controller = ctx.teams[team].controller
      const mode = controller === 'ai' ? 'attack' : stance.mode

      if (mode !== 'attack') {
        clearMotion(motion)
        continue
      }

      // The AI king defends its post instead of charging with the army.
      if (controller === 'ai' && ctx.world.get(e, PieceType)?.kind === 'king') {
        // A lone king stops kiting and holds its post. It cannot win by running
        // and it is faster than every attacker (move cooldown 1s), so dodging
        // forever turned material wins into turn-cap draws. Standing lets the
        // enemy take the shot.
        if (fieldCount[team] === 0) {
          const home = homeCell(ctx, team)
          const alreadyHome = home !== null && vecEquals(cell, home)
          motion.goal = alreadyHome ? null : home
          motion.intent = alreadyHome ? 'none' : 'defense'
          continue
        }
        motion.goal = aiKingGoal(ctx, e, team, kingThreats(ctx, e, team, kingThreatMemo))
        motion.intent = motion.goal === null ? 'none' : 'defense'
        continue
      }

      // Finishing phase: the enemy has only its king left, so hunt it directly.
      // This deliberately skips bodyguard duty and self-preservation — a
      // wounded attacker must still take the shot that ends the game.
      if (endgame && enemyKing !== null) {
        target.entity = enemyKing
        target.retargetAt = ctx.tick + 12
        motion.goal = pursue(ctx, e, enemyKing, team, enemyDanger)
        motion.intent = motion.goal === null ? 'none' : 'engage'
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
            if (plan.onSegment) motion.goal = null
            else motion.goal = plan.cell ?? pursue(ctx, e, top.entity, team, enemyDanger)
            motion.intent = motion.goal === null ? 'none' : 'defense'
            continue
          }
        }
      }

      if (targetValid && hpRatio < preserveThreshold(kind ?? '')) {
        // Low HP (auto-preserve off): seek nearby cover, keeping the shot if free.
        // Pawns cannot retreat, so they hold and fire instead. Only retreat when
        // something is actually covering the piece — with no threats, falling
        // through keeps it fighting instead of parked on the spot.
        const threats = coverageThreats(ctx, e, team, pieceThreatMemo, { proximityRadius: COVER_RADIUS })
        if (threats.length > 0) {
          motion.goal = kind === 'pawn' ? null : escapeGoal(ctx, e, team, threats, target.entity as number)
          motion.intent = motion.goal === null ? 'none' : 'preserve'
          continue
        }
      }
      if (!targetValid) {
        // AI armies advance; a player's Attack stance skirmishes locally.
        motion.goal = controller === 'ai' ? rally(ctx, team) : null
        motion.intent = motion.goal === null ? 'none' : 'rally'
        continue
      }
      // Leash: don't chase an auto-acquired target clear across the board.
      const tcell = ctx.world.get(target.entity as number, Cell)
      const beyondLeash =
        tcell !== undefined &&
        chebyshev(cell.x, cell.y, tcell.x, tcell.y) > ATTACK_LEASH &&
        !inFiringGeometryNow(ctx, e, target.entity as number, team)
      motion.goal = beyondLeash ? null : pursue(ctx, e, target.entity as number, team, enemyDanger)
      motion.intent = motion.goal === null ? 'none' : 'engage'
    }
  },
}

export default system
