import { Cell, ChessKill, Dead, Health, Target, Team } from '../components'
import type { System } from '../pipeline'

const UNDER_FIRE_TICKS = 90

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
        : Math.max(1, Math.round(cmd.amount * ctx.rng.range(0.9, 1.1)))
      health.cur = Math.max(0, health.cur - amount)

      const targetComp = ctx.world.get(target, Target)
      if (targetComp && cmd.source !== null) {
        targetComp.lastAttacker = cmd.source
        targetComp.underFireUntil = ctx.tick + UNDER_FIRE_TICKS
      }

      const team = ctx.world.get(target, Team)
      ctx.bus.emit('damage', `#${target} took ${amount} dmg (hp ${health.cur}/${health.max})`, {
        entity: target,
        team,
        data: { amount, source: cmd.source, kind: cmd.kind },
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
              ctx.cmds.advance.push({ killer: cmd.source, victim: target, cell: { x: tcell.x, y: tcell.y } })
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
