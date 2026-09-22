import { PIECES } from '../../game/pieces'
import { Cell, PieceType, Position, Projectile } from '../components'
import type { Entity } from '../world'
import type { SimContext } from '../types'
import type { System } from '../pipeline'

function impact(ctx: SimContext, e: Entity, pos: { x: number; y: number }): void {
  const proj = ctx.world.require(e, Projectile)
  const cell = ctx.board.worldToCell(pos.x, pos.y)
  let hits = 0
  let directKind = 'pawn'

  for (const other of ctx.world.query(Cell)) {
    if (other === proj.owner) continue
    const oc = ctx.world.require(other, Cell)
    const dx = oc.x - cell.x
    const dy = oc.y - cell.y
    const d2 = dx * dx + dy * dy
    const direct = d2 === 0
    const splash = proj.splash > 0 && d2 <= proj.splash * proj.splash
    if (!direct && !splash) continue
    if (direct) directKind = ctx.world.get(other, PieceType)?.kind ?? directKind
    ctx.cmds.damage.push({ target: other, source: proj.owner, amount: proj.damage, kind: 'projectile' })
    hits++
  }

  if (hits > 0) {
    const ownerKind = proj.owner !== null ? ctx.world.get(proj.owner, PieceType)?.kind : undefined
    const attackerWeapon = ownerKind ? PIECES[ownerKind]?.weapon : undefined
    ctx.bus.emit('hit', `#${e} impacted (${hits} hit)`, {
      team: proj.team,
      data: { cell, hits, kind: directKind, shape: proj.shape, damage: proj.damage, weapon: attackerWeapon },
    })
  } else {
    ctx.bus.emit('miss', `#${e} impacted empty ground`, {
      team: proj.team,
      data: { cell, cause: 'ground' },
    })
  }
}

const system: System = {
  name: 'projectile',
  update(ctx) {
    const board = ctx.board
    for (const e of ctx.world.query(Projectile, Position)) {
      const proj = ctx.world.require(e, Projectile)
      const pos = ctx.world.require(e, Position)
      proj.ttl -= ctx.dt
      if (proj.ttl <= 0) {
        ctx.bus.emit('miss', `#${e} expired`, { team: proj.team, data: { cause: 'expired' } })
        ctx.cmds.destroy.push(e)
        continue
      }

      const step = proj.speed * ctx.dt

      if (proj.trajectory === 'homing') {
        const target = proj.target
        const tp = target !== null ? ctx.world.get(target, Position) : undefined
        if (!target || !ctx.world.isAlive(target) || !tp) {
          ctx.bus.emit('miss', `#${e} lost its target`, { team: proj.team, data: { cause: 'target-lost' } })
          ctx.cmds.destroy.push(e)
          continue
        }
        const dx = tp.x - pos.x
        const dy = tp.y - pos.y
        const distance = Math.hypot(dx, dy)
        const radius = (proj.radius + 0.3) * board.tile
        if (distance <= step + radius) {
          pos.x = tp.x
          pos.y = tp.y
          impact(ctx, e, pos)
          ctx.cmds.destroy.push(e)
          continue
        }
        pos.x += (dx / distance) * step
        pos.y += (dy / distance) * step
        continue
      }

      const wp = proj.waypoints[proj.waypointIndex]
      if (!wp) {
        ctx.bus.emit('miss', `#${e} had no path`, { team: proj.team, data: { cause: 'target-lost' } })
        ctx.cmds.destroy.push(e)
        continue
      }

      const dx = wp.x - pos.x
      const dy = wp.y - pos.y
      const distance = Math.hypot(dx, dy)

      if (distance <= step) {
        pos.x = wp.x
        pos.y = wp.y
        proj.waypointIndex++
        if (proj.waypointIndex >= proj.waypoints.length) {
          impact(ctx, e, pos)
          ctx.cmds.destroy.push(e)
        }
        continue
      }

      const nx = pos.x + (dx / distance) * step
      const ny = pos.y + (dy / distance) * step

      if (proj.trajectory === 'line') {
        const cell = board.worldToCell(nx, ny)
        if (board.blocksProjectile(cell.x, cell.y)) {
          ctx.bus.emit('miss', `#${e} struck a wall`, { team: proj.team, data: { cell, cause: 'wall' } })
          ctx.cmds.destroy.push(e)
          continue
        }
      }

      pos.x = nx
      pos.y = ny
    }
  },
}

export default system
