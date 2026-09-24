import {
  CAPTURE_ADVANCE_FX_COLOR,
  CAPTURE_ADVANCE_FX_RADIUS,
  CAPTURE_ADVANCE_FX_TTL,
  TEAM_COLORS,
} from '../../game/constants'
import { ChessKill, Dead, Fx, PieceType, Position, Team } from '../components'
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

      // A chess-rule kill gets its own effect: a small, quick red triple pulse
      // that runs alongside any capture-advance glide. Ordinary kills keep the
      // team-coloured blast, even when the killer then steps in.
      const capture = ctx.world.has(e, ChessKill)
      const fx = ctx.world.create()
      ctx.world.add(fx, Position, { x: pos.x, y: pos.y })
      ctx.world.add(fx, Fx, {
        ttl: capture ? CAPTURE_ADVANCE_FX_TTL : 0.5,
        maxTtl: capture ? CAPTURE_ADVANCE_FX_TTL : 0.5,
        radius: (capture ? CAPTURE_ADVANCE_FX_RADIUS : radiusTiles) * tile,
        color: capture ? CAPTURE_ADVANCE_FX_COLOR : (TEAM_COLORS[team] ?? '#ffb347'),
        capture,
      })

      const runtime = ctx.teams[team]
      runtime.alive[kind] = Math.max(0, (runtime.alive[kind] ?? 1) - 1)
      runtime.losses++

      ctx.bus.emit('explosion', `#${e} (${kind}) destroyed`, {
        entity: e,
        team,
        data: { fx, kind, radius: capture ? CAPTURE_ADVANCE_FX_RADIUS : radiusTiles, capture },
      })
      ctx.cmds.destroy.push(e)
    }
  },
}

export default system
