import { Health } from '../components'
import { TEAM_IDS } from '../../game/constants'
import { HEAL_RATE, healingTargets } from '../../game/healing'
import type { System } from '../pipeline'

/**
 * King aura regeneration: every same-team piece within two Chebyshev cells of
 * its king (the king included) regenerates a fraction of its max HP each second.
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
      for (const e of field.targets) {
        const health = ctx.world.get(e, Health)
        if (!health || health.cur <= 0 || health.cur >= health.max) continue
        health.cur = Math.min(health.max, health.cur + health.max * HEAL_RATE * ctx.dt)
      }
    }
  },
}

export default system
