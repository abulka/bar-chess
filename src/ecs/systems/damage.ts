import {
  FINISH_PRESSURE_GRACE_TICKS,
  FINISH_PRESSURE_MAX_BONUS,
  FINISH_PRESSURE_PERIOD_TICKS,
  FINISH_PRESSURE_STEP,
  HIT_FX_MIN_FRACTION,
} from '../../game/constants'
import { Cell, ChessKill, Dead, Health, Motion, PieceType, Position, Target, Team } from '../components'
import type { Entity } from '../world'
import type { SimContext } from '../types'
import type { System } from '../pipeline'

const UNDER_FIRE_TICKS = 90

/**
 * Damage multiplier from finish pressure: a king whose side has no field pieces
 * left takes progressively more after a grace period, so an attrition siege
 * cannot outlast the study turn cap. Returns 1 when the rule is off.
 */
function finishMultiplier(ctx: SimContext, target: Entity): number {
  if (!ctx.finishPressure) return 1
  if (ctx.world.get(target, PieceType)?.kind !== 'king') return 1
  const team = ctx.world.get(target, Team)
  if (!team) return 1
  const since = ctx.teams[team].kingOnlySince
  // `>= 0` tolerates older snapshots that predate the field without producing NaN.
  if (!(since >= 0)) return 1
  const elapsed = ctx.tick - since
  if (elapsed <= FINISH_PRESSURE_GRACE_TICKS) return 1
  const steps = Math.floor((elapsed - FINISH_PRESSURE_GRACE_TICKS) / FINISH_PRESSURE_PERIOD_TICKS) + 1
  return 1 + Math.min(FINISH_PRESSURE_MAX_BONUS, steps * FINISH_PRESSURE_STEP)
}

const system: System = {
  name: 'damage',
  update(ctx) {
    for (const cmd of ctx.cmds.damage) {
      const target = cmd.target
      if (!ctx.world.isAlive(target)) continue
      const health = ctx.world.get(target, Health)
      if (!health || health.cur <= 0) continue

      const amount = cmd.lethal
        ? health.cur
        : Math.max(
            1,
            Math.round(cmd.amount * finishMultiplier(ctx, target) * ctx.rng.range(0.9, 1.1)),
          )
      health.cur = Math.max(0, health.cur - amount)

      // A significant non-lethal hit carries a render-only impact payload; the
      // FxLayer turns it into a burst + flash. Chip damage and killing blows are
      // skipped (deaths have their own explosion).
      const fraction = health.max > 0 ? amount / health.max : 0
      const hitPos = ctx.world.get(target, Position)
      const hitFx =
        health.cur > 0 && !cmd.lethal && fraction >= HIT_FX_MIN_FRACTION && hitPos
          ? { x: hitPos.x, y: hitPos.y, severity: fraction, target }
          : null

      const targetComp = ctx.world.get(target, Target)
      if (targetComp && cmd.source !== null) {
        targetComp.lastAttacker = cmd.source
        targetComp.underFireUntil = ctx.tick + UNDER_FIRE_TICKS
      }
      // Track consecutive hits since the last move so the preserve pass can
      // react to sustained fire even while the HP threshold is not crossed.
      const motion = ctx.world.get(target, Motion)
      if (motion) motion.hitStreak++

      const team = ctx.world.get(target, Team)
      ctx.bus.emit('damage', `#${target} took ${amount} dmg (hp ${health.cur}/${health.max})`, {
        entity: target,
        team,
        data: { amount, source: cmd.source, kind: cmd.kind, hitFx },
      })

      if (health.cur <= 0 && !ctx.world.has(target, Dead)) {
        ctx.world.add(target, Dead, true)
        // Tag a chess-rule kill so the death FX can use its own effect.
        if (cmd.kind === 'chess') ctx.world.add(target, ChessKill, true)
        if (cmd.source !== null) {
          const sourceTeam = ctx.world.get(cmd.source, Team)
          if (sourceTeam) ctx.teams[sourceTeam].kills++
          // A kill can let the killer step onto the victim's square (chess
          // capture). Only an enemy killed by a direct blow from a still-living
          // source qualifies; the advance system re-checks idleness and geometry.
          if (
            ctx.captureAdvance &&
            sourceTeam !== undefined &&
            sourceTeam !== team &&
            cmd.direct !== false &&
            ctx.world.isAlive(cmd.source)
          ) {
            const tcell = ctx.world.get(target, Cell)
            if (tcell) {
              ctx.cmds.advance.push({
                killer: cmd.source,
                victim: target,
                cell: { x: tcell.x, y: tcell.y },
                chess: cmd.kind === 'chess',
              })
            }
          }
        }
        ctx.bus.emit('kill', `#${target} destroyed by #${cmd.source ?? 'unknown'}`, {
          entity: target,
          team,
          data: { source: cmd.source },
        })
      }
    }
    ctx.cmds.damage.length = 0
  },
}

export default system
