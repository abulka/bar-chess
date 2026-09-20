import type { Entity, World } from './world'
import type { EventBus } from './events'
import type { Rng } from '../game/rng'
import type { Board } from '../game/board'
import type { TeamId } from '../game/types'

export interface DamageCommand {
  target: Entity
  source: Entity | null
  amount: number
  kind: string
}

export interface DeployCommand {
  team: TeamId
  key: string
}

export interface Commands {
  damage: DamageCommand[]
  deploy: DeployCommand[]
  destroy: Entity[]
}

export interface TeamRuntime {
  /** reinforcement production cooldown remaining per piece key, in seconds */
  cooldown: Record<string, number>
  /** living piece count per key */
  alive: Record<string, number>
  kills: number
  losses: number
  supply: number
  deployed: number
}

export interface SimContext {
  world: World
  bus: EventBus
  board: Board
  rng: Rng
  tick: number
  dt: number
  cmds: Commands
  teams: Record<TeamId, TeamRuntime>
  /** entity currently occupying each cell key, rebuilt by the targeting system */
  occupancy: Map<number, Entity>
  pathBudget: number
  verbosePhases: boolean
}
