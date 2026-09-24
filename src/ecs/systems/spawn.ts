import { createPiece } from '../../game/factory'
import { PIECES } from '../../game/pieces'
import type { Vec2 } from '../../game/types'
import type { System } from '../pipeline'

function findLane(ctx: Parameters<System['update']>[0], team: 'red' | 'blue'): Vec2 | null {
  for (const lane of ctx.board.data.lanes[team]) {
    if (!ctx.board.passable(lane.x, lane.y)) continue
    if (ctx.occupancy.has(ctx.board.cellIndex(lane.x, lane.y))) continue
    return lane
  }
  return null
}

const system: System = {
  name: 'spawn',
  update(ctx) {
    for (const cmd of ctx.cmds.deploy) {
      const def = PIECES[cmd.key]
      if (!def) continue
      const cell = findLane(ctx, cmd.team)
      if (!cell) {
        ctx.bus.emit('warn', `${cmd.team} has no free entry lane for ${def.name}`, { team: cmd.team })
        continue
      }
      const e = createPiece(ctx, cmd.team, def, cell)
      const runtime = ctx.teams[cmd.team]
      runtime.alive[cmd.key] = (runtime.alive[cmd.key] ?? 0) + 1
      runtime.deployed++
      ctx.bus.emit('spawn', `${cmd.team} deployed ${def.name} #${e} at (${cell.x},${cell.y})`, {
        entity: e,
        team: cmd.team,
        data: { key: cmd.key },
      })
    }
    ctx.cmds.deploy.length = 0
  },
}

export default system
