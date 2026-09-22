import { TEAM_COLORS } from '../../game/constants'
import { Dead, Fx, PieceType, Position, Team } from '../components'
import type { System } from '../pipeline'

const system: System = {
  name: 'death',
  update(ctx) {
    const tile = ctx.board.tile
    const radiusTiles = 1.6
    for (const e of ctx.world.query(Dead, Position, PieceType, Team)) {
      const pos = ctx.world.require(e, Position)
      const kind = ctx.world.require(e, PieceType).kind
      const team = ctx.world.require(e, Team)

      const fx = ctx.world.create()
      ctx.world.add(fx, Position, { x: pos.x, y: pos.y })
      ctx.world.add(fx, Fx, {
        ttl: 0.5,
        maxTtl: 0.5,
        radius: radiusTiles * tile,
        color: TEAM_COLORS[team] ?? '#ffb347',
      })

      const runtime = ctx.teams[team]
      runtime.alive[kind] = Math.max(0, (runtime.alive[kind] ?? 1) - 1)
      runtime.losses++

      ctx.bus.emit('explosion', `#${e} (${kind}) destroyed`, {
        entity: e,
        team,
        data: { fx, kind, radius: radiusTiles },
      })
      ctx.cmds.destroy.push(e)
    }
  },
}

export default system
