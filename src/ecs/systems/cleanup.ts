import type { System } from '../pipeline'

const system: System = {
  name: 'cleanup',
  update(ctx) {
    for (const e of ctx.cmds.destroy) {
      if (ctx.world.isAlive(e)) ctx.world.destroy(e)
    }
    ctx.cmds.destroy.length = 0
  },
}

export default system
