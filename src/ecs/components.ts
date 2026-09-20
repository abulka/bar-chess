import type { IntentMode, TeamId, Trajectory, Vec2 } from '../game/types'
import type { Entity } from './world'
import { defineComponent } from './world'

export interface PositionData {
  x: number
  y: number
}

export interface CellData {
  x: number
  y: number
}

export interface RenderData {
  glyph: string
  tint: string
  size: number
}

export interface PieceTypeData {
  kind: string
}

export interface HealthData {
  cur: number
  max: number
}

export interface IntentData {
  mode: IntentMode
  dest: Vec2 | null
  /** set when the player (rather than the AI) issued this intention */
  player: boolean
}

export interface TargetData {
  entity: Entity | null
  retargetAt: number
}

export interface WeaponData {
  left: number
}

export interface MotionData {
  /** desired destination in tile coordinates, or null to hold */
  goal: Vec2 | null
  /** upcoming cells in tile coordinates, excluding the current cell */
  path: Vec2[]
  fromX: number
  fromY: number
  toX: number
  toY: number
  travel: number
  elapsed: number
  moving: boolean
  cooldown: number
  arrived: boolean
  replanAt: number
  blocked: boolean
}

export interface ProjectileData {
  team: TeamId
  damage: number
  ttl: number
  maxTtl: number
  speed: number
  trajectory: Trajectory
  splash: number
  radius: number
  color: string
  target: Entity | null
  owner: Entity | null
  /** world-space waypoints for jump/arc trajectories, empty for straight shots */
  waypoints: Vec2[]
  waypointIndex: number
}

export interface FxData {
  ttl: number
  maxTtl: number
  radius: number
  color: string
}

export const Position = defineComponent<PositionData>('Position')
export const Cell = defineComponent<CellData>('Cell')
export const Team = defineComponent<TeamId>('Team')
export const PieceType = defineComponent<PieceTypeData>('PieceType')
export const Render = defineComponent<RenderData>('Render')
export const Health = defineComponent<HealthData>('Health')
export const Intent = defineComponent<IntentData>('Intent')
export const Target = defineComponent<TargetData>('Target')
export const Weapon = defineComponent<WeaponData>('Weapon')
export const Motion = defineComponent<MotionData>('Motion')
export const Projectile = defineComponent<ProjectileData>('Projectile')
export const Fx = defineComponent<FxData>('Fx')
export const Dead = defineComponent<true>('Dead')
