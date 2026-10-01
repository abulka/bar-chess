import { containsCell, fireCells } from '../../game/geometry'
import { kingOf } from '../../game/healing'
import { makeOccupied } from '../../game/occupancy'
import { PIECES, WEAPONS, projectileDef, weaponDamage } from '../../game/pieces'
import type { TeamId, Vec2 } from '../../game/types'
import { Cell, Dead, Health, PieceType, Position, Projectile, Target, Team, Weapon, hasLiveCell } from '../components'
import type { Entity } from '../world'
import type { SimContext } from '../types'
import type { System } from '../pipeline'

function spawnProjectile(
  ctx: SimContext,
  owner: Entity,
  team: 'red' | 'blue',
  weaponKey: string,
  target: Entity,
  targetCell: Vec2,
  damage: number,
): Entity {
  const weapon = WEAPONS[weaponKey]
  const def = projectileDef(weapon.projectile)
  const pos = ctx.world.require(owner, Position)
  const fromCell = ctx.world.require(owner, Cell)
  const targetCenter = ctx.board.cellCenter(targetCell.x, targetCell.y)

  let waypoints: Vec2[]
  if (def.trajectory === 'jump') {
    const dx = targetCell.x - fromCell.x
    const dy = targetCell.y - fromCell.y
    const corner =
      Math.abs(dx) >= Math.abs(dy)
        ? ctx.board.cellCenter(fromCell.x + dx, fromCell.y)
        : ctx.board.cellCenter(fromCell.x, fromCell.y + dy)
    waypoints = [corner, targetCenter]
  } else if (def.trajectory === 'homing') {
    waypoints = []
  } else {
    waypoints = [targetCenter]
  }

  const p = ctx.world.create()
  ctx.world.add(p, Position, { x: pos.x, y: pos.y })
  ctx.world.add(p, Projectile, {
    team,
    damage,
    ttl: def.ttl,
    maxTtl: def.ttl,
    speed: def.speed * ctx.board.tile,
    trajectory: def.trajectory,
    splash: def.splash,
    radius: def.radius,
    size: def.size,
    shape: def.shape,
    spin: def.spin,
    color: def.color,
    target,
    owner,
    waypoints,
    waypointIndex: 0,
  })
  return p
}

const system: System = {
  name: 'combat',
  update(ctx) {
    const occupied = makeOccupied(ctx.board, ctx.occupancy)

    for (const e of ctx.world.query(Weapon, Target, Cell, Position, Team, PieceType)) {
      const weapon = ctx.world.require(e, Weapon)
      if (weapon.left > 0) {
        weapon.left = Math.max(0, weapon.left - ctx.dt)
        continue
      }

      const target = ctx.world.require(e, Target).entity

      const kind = ctx.world.require(e, PieceType).kind
      const def = PIECES[kind]
      if (!def) continue
      const wdef = WEAPONS[def.weapon]
      const team = ctx.world.require(e, Team)
      const cell = ctx.world.require(e, Cell)
      const cells = fireCells(ctx.board, cell, wdef.geometry, team, occupied)

      // Checkmate freezes all movement, so the winning side finishes by fire: a
      // piece covering the trapped king shoots it even when its standing order
      // points at a target it can no longer walk into range. This runs after the
      // orders pass, so the focus cannot be overwritten before the shot lands.
      let victim = target
      const enemyTeam: TeamId = team === 'red' ? 'blue' : 'red'
      if (ctx.checkmate[enemyTeam]) {
        const king = kingOf(ctx.world, enemyTeam)
        const kcell = king !== null ? ctx.world.get(king, Cell) : undefined
        if (king !== null && kcell && containsCell(cells, kcell.x, kcell.y)) {
          victim = king
          ctx.world.require(e, Target).entity = king
        }
      }

      if (!hasLiveCell(ctx.world, victim)) continue
      // A chess kill already queued for this target this tick: it dies before the
      // shot would land, so don't waste a projectile on it.
      if (ctx.world.has(victim, Dead)) continue
      if (ctx.cmds.damage.some((d) => d.target === victim && d.lethal)) continue

      const tcell = ctx.world.require(victim, Cell)
      if (!containsCell(cells, tcell.x, tcell.y)) continue

      const targetHealth = ctx.world.get(victim, Health)
      const damage = weaponDamage(wdef, targetHealth?.max ?? 0)
      const projectile = spawnProjectile(ctx, e, team, def.weapon, victim, tcell, damage)
      weapon.left = wdef.cooldown
      weapon.fired = true
      ctx.bus.emit('shot', `#${e} fired ${wdef.key} at #${victim}`, {
        entity: e,
        team,
        data: { projectile, target: victim, weapon: wdef.key, piece: kind, projectileKind: wdef.projectile },
      })
    }
  },
}

export default system
