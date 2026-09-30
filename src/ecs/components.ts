import type { OrderKind, ProjectileShape, TeamId, Trajectory, Vec2 } from '../game/types'
import type { Entity, World } from './world'
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

/** One queued waypoint, planned from the previous step's endpoint. */
export type OrderStep =
  | { kind: 'goto'; dest: Vec2; path: Vec2[] }
  | { kind: 'attack'; target: Entity; path: Vec2[]; goal: Vec2 | null; reachable: boolean }

/** One recorded order transition, for the piece panel's "why did it change" log. */
export interface OrderLogEntry {
  tick: number
  text: string
}

/** A player instruction (or an AI's autonomous task) until fulfilled. */
export interface OrderData {
  kind: OrderKind
  dest: Vec2 | null
  target: Entity | null
  /** Last known cell of the active attack target, for order-log notes. */
  targetCell: Vec2 | null
  /**
   * Victim of a parked insta-kill (immediate chess kill), consumed by the
   * `orders` system on the next tick. It outranks self-preservation for that
   * tick (a suicide kill is allowed) and can only be set by a human order that
   * started the active order — see `src/game/instaKill.ts`. Kept on the order
   * (not in `cmds`) so it is part of the turn snapshot and replays
   * deterministically.
   */
  chessKill: Entity | null
  /**
   * First turn on which self-preservation may run again for this order; `-1`
   * when the player has not insisted on the order. Set by an Alt-clicked order
   * to suspend the wounded-retreat behaviour for a few turns — see
   * `src/game/noPreserve.ts`. It ends when the order is replaced, completed or
   * cleared, so a promoted queued step does not inherit it. Kept on the order
   * (not in `cmds`) so it is part of the world snapshot and replays
   * deterministically, like `chessKill`.
   */
  noPreserveUntil: number
  /** For an attack order: whether the target is positionally reachable at all. */
  reachable: boolean
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
   * safe-hold and does not advance its order. Full health for a critical wound,
   * `recoverThreshold` (about one more hit absorbed) for a lesser one. 0 = no hold. */
  holdUntilHp: number
  /** Hits taken since the last movement step; drives damage-aware retreats. */
  hitStreak: number
  /** The last cell this piece vacated, so goal selection can avoid 2-cycles. */
  prevCell: Vec2 | null
  /** Tick the current goal was chosen; a retreat is committed for a short window. */
  goalSetTick: number
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
  /** ease the interpolation in/out (capture-advance glide) instead of linear */
  ease?: boolean
  /** a free capture-advance step: do not apply the post-arrival move cooldown */
  freeAdvance?: boolean
  /**
   * The current goal deliberately enters enemy fire: a bodyguard screening its
   * own king, or a finisher that must close on a lone king because no safe
   * firing square exists. The route planner and movement honour it by suspending
   * the general "stay out of enemy coverage" guard. Set by `orders` each tick.
   */
  threatExempt: boolean
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

export const Position = defineComponent<PositionData>('Position')
export const Cell = defineComponent<CellData>('Cell')
export const Team = defineComponent<TeamId>('Team')
export const PieceType = defineComponent<PieceTypeData>('PieceType')
export const Render = defineComponent<RenderData>('Render')
export const Health = defineComponent<HealthData>('Health')
export const Order = defineComponent<OrderData>('Order')
export const Target = defineComponent<TargetData>('Target')
export const Weapon = defineComponent<WeaponData>('Weapon')
export const Motion = defineComponent<MotionData>('Motion')
export const Projectile = defineComponent<ProjectileData>('Projectile')
export const Dead = defineComponent<true>('Dead')
/** Marks a kill delivered by the chess-kill rule (drives the red pulse FX). */
export const ChessKill = defineComponent<true>('ChessKill')

/** True when `entity` is non-null, still alive, and has a board cell. */
export function hasLiveCell(world: World, entity: Entity | null): entity is Entity {
  return entity !== null && world.isAlive(entity) && world.has(entity, Cell)
}

/** Every component store, in declaration order. */
export const ALL_STORES = [
  Position,
  Cell,
  Team,
  PieceType,
  Render,
  Health,
  Order,
  Target,
  Weapon,
  Motion,
  Projectile,
  Dead,
  ChessKill,
]

/**
 * Clear every component store. Stores are module-level singletons shared by all
 * `World` instances, so tests, self-play and record replay must reset them
 * between worlds or entity ids collide across games.
 */
export function clearAllComponents(): void {
  for (const store of ALL_STORES) store.map.clear()
}
