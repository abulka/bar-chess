import { Fx } from '../components'
import type { System } from '../pipeline'

const system: System = {
  name: 'cleanup',
  update(ctx) {
    for (const e of ctx.cmds.destroy) {
      if (ctx.world.isAlive(e)) ctx.world.destroy(e)
    }
    ctx.cmds.destroy.length = 0

    for (const e of ctx.world.query(Fx)) {
      const fx = ctx.world.require(e, Fx)
      fx.ttl -= ctx.dt
      if (fx.ttl <= 0) ctx.world.destroy(e)
    }
  },
}

export default system
