/**
 * Shared colours and thresholds for the in-world health/recharge bars and the
 * inspector panel, kept in one place so both stay in sync. The scheme follows
 * Beyond All Reason: a fixed dark frame is always drawn full width, and the
 * coloured portion grows inside it. Health runs green at full down to red once
 * a piece drops to `HEALTH_RED_AT` (40%), and a recharging weapon draws a teal fill.
 * Both bars vanish once effectively full, and short reloads are skipped so fast
 * weapons don't make bars flicker on every shot.
 */
export const BAR_HIDE_THRESHOLD = 0.99
/** Weapons with a cooldown at or above this (seconds) get a recharge bar. */
export const RELOAD_MIN_COOLDOWN = 1.5
/** Fixed container behind every bar; there is no separate outline stroke. */
export const BAR_BG = 'rgba(8,10,14,0.82)'
export const RELOAD_FILL = '#15c2b6'
/** Bright cyan for a self-preservation retreat route/objective (not an order).
 * Deliberately far from the order gold/orange so an automatic dodge can never
 * be mistaken for a route the player issued. */
export const PRESERVE_COLOR = '#00e5ff'
/** Muted grey for an incidental "pot shot": a stationary piece firing at whatever
 * is in range without committing to pursue it (None/Move stance). */
export const POTSHOT_COLOR = '#8b929c'
/** Ordered-attack firing line and target ring. */
export const TRACK_COLOR = '#ff2d20'
/** Auto-acquired / retaliation target, distinct from an explicitly ordered one. */
export const ENGAGE_COLOR = '#e3b341'
/** Dashed grey firing line to an ordered target that cannot be reached. */
export const UNREACHABLE_COLOR = '#a0a6ac'
/** Normal / best-effort-partial movement route. */
export const ROUTE_COLOR = '#ffd166'
export const ROUTE_PARTIAL_COLOR = '#ffb347'
/** Selected-piece ring. */
export const SELECT_COLOR = '#ffd166'
/** Stance badge colours. */
export const STANCE_MOVE_COLOR = '#4ad991'
export const STANCE_ATTACK_COLOR = '#ff3b30'

const HEALTH_FULL: [number, number, number] = [76, 217, 100]
const HEALTH_EMPTY: [number, number, number] = [255, 59, 48]
/** At or below this health fraction the bar is solid red, not just reddish. */
const HEALTH_RED_AT = 0.4

function mix(a: [number, number, number], b: [number, number, number], t: number): string {
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t))
  return `rgb(${c[0]},${c[1]},${c[2]})`
}

const HEALTH_RED = `rgb(${HEALTH_EMPTY[0]},${HEALTH_EMPTY[1]},${HEALTH_EMPTY[2]})`

/** Green at full health, blending to solid red at or below 40%. */
export function healthColor(ratio: number): string {
  const r = Math.max(0, Math.min(1, ratio))
  if (r <= HEALTH_RED_AT) return HEALTH_RED
  return mix(HEALTH_EMPTY, HEALTH_FULL, (r - HEALTH_RED_AT) / (1 - HEALTH_RED_AT))
}
