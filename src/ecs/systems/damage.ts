import { Dead, Health, Team } from '../components'
import type { System } from '../pipeline'

const system: System = {
  name: 'damage',
  update(ctx) {
    for (const cmd of ctx.cmds.damage) {
      const target = cmd.target
      if (!ctx.world.isAlive(target)) continue
      const health = ctx.world.get(target, Health)
      if (!health || health.cur <= 0) continue

      const amount = Math.max(1, Math.round(cmd.amount * ctx.rng.range(0.9, 1.1)))
      health.cur = Math.max(0, health.cur - amount)

      const team = ctx.world.get(target, Team)
      ctx.bus.emit('damage', `#${target} took ${amount} dmg (hp ${health.cur}/${health.max})`, {
        entity: target,
        team,
        data: { amount, source: cmd.source, kind: cmd.kind },
      })

      if (health.cur <= 0 && !ctx.world.has(target, Dead)) {
        ctx.world.add(target, Dead, true)
        if (cmd.source !== null) {
          const sourceTeam = ctx.world.get(cmd.source, Team)
          if (sourceTeam) ctx.teams[sourceTeam].kills++
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
