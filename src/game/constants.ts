import type { TeamId } from './types'

export const TEAM_IDS: TeamId[] = ['red', 'blue']

export const TEAM_COLORS: Record<TeamId, string> = {
  red: '#ff6b5a',
  blue: '#5ab0ff',
}

export const TEAM_NAMES: Record<TeamId, string> = {
  red: 'Red',
  blue: 'Blue',
}

export const FIXED_DT = 1 / 30
export const MAX_STEPS_PER_FRAME = 6
export const SNAPSHOT_INTERVAL_MS = 120
export const PATH_BUDGET_PER_TICK = 8
export const MOVE_TRAVEL = 0.32
