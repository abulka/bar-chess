import { Pipeline } from '../pipeline'
import spawn from './spawn'
import targeting from './targeting'
import orders from './orders'
import pathfinding from './pathfinding'
import movement from './movement'
import combat from './combat'
import projectile from './projectile'
import damage from './damage'
import death from './death'
import cleanup from './cleanup'
import advance from './advance'
import promotion from './promotion'
import healing from './healing'

export function createPipeline(): Pipeline {
  return new Pipeline([
    spawn,
    targeting,
    orders,
    pathfinding,
    movement,
    combat,
    projectile,
    damage,
    death,
    cleanup,
    advance,
    promotion,
    healing,
  ])
}
