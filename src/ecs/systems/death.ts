import { CAPTURE_ADVANCE_FX_RADIUS, DEATH_FX_RADIUS_TILES } from '../../game/constants'
import { ChessKill, Dead, PieceType, Position, Team } from '../components'
import type { System } from '../pipeline'

const system: System = {
  name: 'death',
  update(ctx) {
    for (const e of ctx.world.query(Dead, Position, PieceType, Team)) {
      const pos = ctx.world.require(e, Position)
      const kind = ctx.world.require(e, PieceType).kind
      const team = ctx.world.require(e, Team)

      // A chess-rule kill gets its own effect: a small, quick red triple pulse
      // that runs alongside any capture-advance glide. Ordinary kills keep the
      // standard red explosion, even when the killer then steps in. The effect
      // itself is render-only and lives in the `FxLayer`, fed by this event.
      const capture = ctx.world.has(e, ChessKill)

      const runtime = ctx.teams[team]
      runtime.alive[kind] = Math.max(0, (runtime.alive[kind] ?? 1) - 1)
      runtime.losses++

      ctx.bus.emit('explosion', `#${e} (${kind}) destroyed`, {
        entity: e,
        team,
        data: {
          kind,
          capture,
          radiusTiles: capture ? CAPTURE_ADVANCE_FX_RADIUS : DEATH_FX_RADIUS_TILES,
          x: pos.x,
          y: pos.y,
        },
      })
      ctx.cmds.destroy.push(e)
    }
  },
}

export default system
