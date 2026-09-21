import type { TeamId } from './types'

export const TEAM_IDS: TeamId[] = ['red', 'blue']

export const TEAM_COLORS: Record<TeamId, string> = {
  red: '#ff9f43',
  blue: '#5ab0ff',
}

export const TEAM_NAMES: Record<TeamId, string> = {
  red: 'Orange',
  blue: 'Blue',
}

export const FIXED_DT = 1 / 30
export const MAX_STEPS_PER_FRAME = 6
export const SNAPSHOT_INTERVAL_MS = 120
export const PATH_BUDGET_PER_TICK = 8
export const SPEEDS = [0.5, 1, 2, 4]
