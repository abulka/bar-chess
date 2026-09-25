import type { Entity, World } from './world'
import type { EventBus } from './events'
import type { Rng } from '../game/rng'
import type { Board } from '../game/board'
import type { TeamId, Vec2 } from '../game/types'

export interface DamageCommand {
  target: Entity
  source: Entity | null
  amount: number
  kind: string
  /** For projectile damage: whether the blow landed on the target's own cell. */
  direct?: boolean
  /** Chess kill: ignore `amount`/variance and drop the target straight to 0 HP. */
  lethal?: boolean
}

export interface DeployCommand {
  team: TeamId
  key: string
}

/** A kill that may let the killer step onto the victim's square (chess capture). */
export interface AdvanceCommand {
  killer: Entity
  victim: Entity
  cell: Vec2
}

export interface Commands {
  damage: DamageCommand[]
  deploy: DeployCommand[]
  destroy: Entity[]
  advance: AdvanceCommand[]
}

export type TeamController = 'human' | 'ai'

export interface TeamRuntime {
  controller: TeamController
  /** reinforcement production cooldown remaining per piece key, in seconds */
  cooldown: Record<string, number>
  /** living piece count per key */
  alive: Record<string, number>
  kills: number
  losses: number
  supply: number
  deployed: number
  /** cumulative moves made (drives the AI move budget) */
  movesMade: number
  /** moves made during the current turn */
  movesThisTurn: number
}

export interface SimContext {
  world: World
  bus: EventBus
  board: Board
  rng: Rng
  tick: number
  /** monotonic turn index; increments each time a turn begins */
  turn: number
  dt: number
  cmds: Commands
  teams: Record<TeamId, TeamRuntime>
  /** entity currently occupying each cell key, rebuilt by the targeting system */
  occupancy: Map<number, Entity>
  pathBudget: number
  verbosePhases: boolean
  /** when true, each piece may make at most one move this turn */
  turnActive: boolean
  /** when true, hurt pieces step out of fire on their own, even without orders */
  autoPreserve: boolean
  /** when true, an idle killer steps onto the square of a piece it just killed */
  captureAdvance: boolean
  /** when true, a pawn reaching the enemy back rank promotes to a queen */
  promotion: boolean
}
