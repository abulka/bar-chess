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
/** How far an autonomous Attack piece will look for a target (cells). */
export const ATTACK_LEASH = 8

/** Seconds a capture-advance step glides for (slower than a normal step). */
export const CAPTURE_ADVANCE_TRAVEL = 0.75
/** Capture-advance blast: small, quick triple pulse, matched to the glide. */
export const CAPTURE_ADVANCE_FX_TTL = 0.75
export const CAPTURE_ADVANCE_FX_RADIUS = 0.8
/** Colour of the capture-advance pulses. */
export const CAPTURE_ADVANCE_FX_COLOR = '#ff3b30'

/** HUD bottom-panel height as a fraction of the viewport, persisted as a pref. */
export const BOTTOM_FRACTION_DEFAULT = 0.28
export const BOTTOM_FRACTION_MIN = 0.1
export const BOTTOM_FRACTION_MAX = 0.9

/** Side-rail width as a fraction of the viewport, persisted as a pref. */
export const RAIL_FRACTION_DEFAULT = 0.14
export const RAIL_FRACTION_MIN = 0.08
export const RAIL_FRACTION_MAX = 0.45
