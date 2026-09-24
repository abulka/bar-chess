import { Health } from '../components'
import { TEAM_IDS } from '../../game/constants'
import { HEAL_RATE, HUMAN_HEAL_MULTIPLIER, healingTargets } from '../../game/healing'
import type { System } from '../pipeline'

/**
 * King aura regeneration: every same-team piece other than the king within two
 * Chebyshev cells of it regenerates a fraction of its max HP each second. The
 * king is the source of the aura, never a target, so it does not heal itself.
 * Human-controlled teams regenerate `HUMAN_HEAL_MULTIPLIER` times faster.
 * Runs on the settled living set (after cleanup), never revives a piece at zero
 * HP, and clamps at max. Deterministic — it only advances by `ctx.dt` — so it is
 * captured by turn snapshots and replays exactly.
 */
const system: System = {
  name: 'healing',
  update(ctx) {
    for (const team of TEAM_IDS) {
      const field = healingTargets(ctx.world, team)
      if (!field) continue
      const rate =
        ctx.teams[team].controller === 'human' ? HEAL_RATE * HUMAN_HEAL_MULTIPLIER : HEAL_RATE
      for (const e of field.targets) {
        const health = ctx.world.get(e, Health)
        if (!health || health.cur <= 0 || health.cur >= health.max) continue
        health.cur = Math.min(health.max, health.cur + health.max * rate * ctx.dt)
      }
    }
  },
}

export default system
