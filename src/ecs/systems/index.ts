import { Pipeline } from '../pipeline'
import spawn from './spawn'
import targeting from './targeting'
import ai from './ai'
import pathfinding from './pathfinding'
import movement from './movement'
import combat from './combat'
import projectile from './projectile'
import damage from './damage'
import death from './death'
import cleanup from './cleanup'

export function createPipeline(): Pipeline {
  return new Pipeline([
    spawn,
    targeting,
    ai,
    pathfinding,
    movement,
    combat,
    projectile,
    damage,
    death,
    cleanup,
  ])
}
