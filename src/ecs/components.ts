import type { OrderKind, ProjectileShape, StanceMode, TeamId, Trajectory, Vec2 } from '../game/types'
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

/** Persistent autonomous behaviour policy. */
export interface StanceData {
  mode: StanceMode
}

/** One queued waypoint, planned from the previous step's endpoint. */
export type OrderStep =
  | { kind: 'goto'; dest: Vec2; path: Vec2[] }
  | { kind: 'attack'; target: Entity; path: Vec2[]; goal: Vec2 | null; reachable: boolean }

/** One recorded order transition, for the piece panel's "why did it change" log. */
export interface OrderLogEntry {
  tick: number
  text: string
}

/** A one-shot instruction that overrides stance until fulfilled. */
export interface OrderData {
  kind: OrderKind
  dest: Vec2 | null
  target: Entity | null
  /** For an attack order: whether the target is positionally reachable at all. */
  reachable: boolean
  /** Attack target parked while a goto suspends the attack; resumed on arrival. */
  resumeTarget: Entity | null
  /** Turn index at which a suspension may re-engage; -1 while unarmed. */
  resumeTurn: number
  /** Steps queued behind the active order, executed in sequence. */
  queue: OrderStep[]
  /** Recent order transitions, oldest first (bounded). Lets the panel explain
   * why an order was issued, replaced, completed or abandoned. */
  log: OrderLogEntry[]
}

export interface TargetData {
  entity: Entity | null
  retargetAt: number
  lastAttacker: Entity | null
  underFireUntil: number
}

export interface WeaponData {
  left: number
  /** True once the weapon has fired at least once; gates the recharge bar. */
  fired: boolean
}

/**
 * Why the current motion goal was chosen. Lets the renderer colour and the
 * properties panel label an order's provenance — most importantly a
 * self-preservation retreat, which is not backed by an `Order`.
 */
export type MotionIntent = 'none' | 'order' | 'preserve' | 'defense' | 'engage' | 'rally'

export interface MotionData {
  /** desired destination in tile coordinates, or null to hold */
  goal: Vec2 | null
  /** source of the current goal (drives overlay colour + panel label) */
  intent: MotionIntent
  /** While `Health.cur < holdUntilHp` the piece stays in a self-preservation
   * safe-hold and does not advance its order. 0 = no hold. */
  holdUntilHp: number
  /** cell currently being entered; occupancy reserves it until arrival */
  reserved: Vec2 | null
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
  /** number of movement steps completed; used to detect a "turn" boundary */
  steps: number
  /** true once this piece has made its single move in the current turn */
  movedThisTurn: boolean
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
  size: number
  shape: ProjectileShape
  spin: boolean
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
export const Stance = defineComponent<StanceData>('Stance')
export const Order = defineComponent<OrderData>('Order')
export const Target = defineComponent<TargetData>('Target')
export const Weapon = defineComponent<WeaponData>('Weapon')
export const Motion = defineComponent<MotionData>('Motion')
export const Projectile = defineComponent<ProjectileData>('Projectile')
export const Fx = defineComponent<FxData>('Fx')
export const Dead = defineComponent<true>('Dead')

/** Every component store, in declaration order. */
export const ALL_STORES = [
  Position,
  Cell,
  Team,
  PieceType,
  Render,
  Health,
  Stance,
  Order,
  Target,
  Weapon,
  Motion,
  Projectile,
  Fx,
  Dead,
]

/**
 * Clear every component store. Stores are module-level singletons shared by all
 * `World` instances, so tests, self-play and record replay must reset them
 * between worlds or entity ids collide across games.
 */
export function clearAllComponents(): void {
  for (const store of ALL_STORES) store.map.clear()
}
