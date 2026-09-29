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

/**
 * Simulation/rules version. Bump this by hand on any change to AI, combat or
 * movement behaviour that would make an old recorded beat replay differently.
 * Saves stamped with a different version load position-only (their turn history
 * is cleared) so a replay can never mix old recorded states with new rules.
 */
export const SIM_VERSION = 3

/** Seconds a capture-advance step glides for (slower than a normal step). */
export const CAPTURE_ADVANCE_TRAVEL = 0.75
/** Capture-advance blast: small, quick triple pulse, matched to the glide. */
export const CAPTURE_ADVANCE_FX_TTL = 0.75
export const CAPTURE_ADVANCE_FX_RADIUS = 0.8
/** Colour of the capture-advance pulses. */
export const CAPTURE_ADVANCE_FX_COLOR = '#ff3b30'

/**
 * Chess-kill tracer: a quick streak from the killer to the victim so an instant
 * chess kill still reads as a shot, not just a blast on the victim's square. It
 * is render-only and plays even while the simulation is frozen by a win.
 */
export const CHESS_TRACER_TTL = 0.28
export const CHESS_TRACER_COLOR = '#ffd166'

/**
 * Normal death explosion colour. Red, never the team tint: the orange/amber
 * palette is reserved for the Orange team, so an orange blast on a blue piece
 * (or vice versa) would read as the wrong side.
 */
export const DEATH_FX_COLOR = '#ff3b30'
export const DEATH_FX_TTL = 0.5
export const DEATH_FX_RADIUS_TILES = 1.6
/**
 * How long a dying piece trembles in place before its blast, so the player can
 * register the killing blow rather than seeing the piece vanish instantly. It
 * runs longer than the projectile-hit tremble (`HIT_FX_TTL`) because this is the
 * fatal one. During this window the explosion is held back.
 */
export const DEATH_TREMBLE_TTL = 0.45

/**
 * Hit-impact feedback: a significant non-fatal hit (at least
 * `HIT_FX_MIN_FRACTION` of the target's max HP) shows a small pink burst plus a
 * flash on the damaged piece in its own team colour and a brief tremble.
 * `HIT_FX_MAX_ACTIVE` caps concurrent bursts so splash fire cannot flood the board.
 */
export const HIT_FX_TTL = 0.38
export const HIT_FX_MIN_FRACTION = 0.2
export const HIT_FX_MIN_RADIUS = 0.22
export const HIT_FX_MAX_RADIUS = 0.7
export const HIT_FX_MAX_ACTIVE = 12
export const HIT_FX_COLOR = '#ff4fb0'

/**
 * Finish pressure: once a side is down to its king alone, incoming damage to
 * that king ramps after a grace period so an attrition siege cannot run to the
 * study turn cap. Fraction added per `FINISH_PRESSURE_PERIOD_TICKS`, capped at
 * `FINISH_PRESSURE_MAX_BONUS`.
 */
export const FINISH_PRESSURE_GRACE_TICKS = 240
export const FINISH_PRESSURE_PERIOD_TICKS = 180
export const FINISH_PRESSURE_STEP = 0.25
export const FINISH_PRESSURE_MAX_BONUS = 1

/** HUD bottom-panel height as a fraction of the viewport, persisted as a pref. */
export const BOTTOM_FRACTION_DEFAULT = 0.28
export const BOTTOM_FRACTION_MIN = 0.1
export const BOTTOM_FRACTION_MAX = 0.9

/** Side-rail width as a fraction of the viewport, persisted as a pref. */
export const RAIL_FRACTION_DEFAULT = 0.14
export const RAIL_FRACTION_MIN = 0.08
export const RAIL_FRACTION_MAX = 0.45
