import {
  BOTTOM_FRACTION_MAX,
  BOTTOM_FRACTION_MIN,
  RAIL_FRACTION_MAX,
  RAIL_FRACTION_MIN,
  SPEEDS,
} from './constants'
import { GAME_MODES } from './game'
import type { GameMode, OverlayFlags } from './game'

/**
 * The settings that change how the simulation runs. They ride along in turn
 * snapshots and game records so undo/redo/replay reproduce the rules that were
 * in force, not whatever is toggled now.
 */
export interface SimSettings {
  autoPreserve: boolean
  captureAdvance: boolean
  chessKills: boolean
}

/** UI/session preferences that should survive a reload or a server restart. */
export interface GameSettings {
  overlays: OverlayFlags
  hudVisible: boolean
  railsVisible: boolean
  speed: number
  gameMode: GameMode
  autoPreserve: boolean
  captureAdvance: boolean
  chessKills: boolean
  soundEnabled: boolean
  /** HUD bottom-panel height as a fraction of the viewport. */
  bottomFraction: number
  /** Left/right side-rail widths as a fraction of the viewport. */
  leftRailFraction: number
  rightRailFraction: number
  /** Whether the left "controls" hints and right "stance" legend are collapsed. */
  controlsCollapsed: boolean
  stanceCollapsed: boolean
  /** Whether the right-rail legend / firing-lines / copy sections are collapsed. */
  legendCollapsed: boolean
  firingLinesCollapsed: boolean
  copyCollapsed: boolean
}

/** A validated subset of settings to apply, as read from storage. */
export interface SettingsPatch {
  overlays?: Partial<OverlayFlags>
  hudVisible?: boolean
  railsVisible?: boolean
  speed?: number
  gameMode?: GameMode
  autoPreserve?: boolean
  captureAdvance?: boolean
  chessKills?: boolean
  soundEnabled?: boolean
  bottomFraction?: number
  leftRailFraction?: number
  rightRailFraction?: number
  controlsCollapsed?: boolean
  stanceCollapsed?: boolean
  legendCollapsed?: boolean
  firingLinesCollapsed?: boolean
  copyCollapsed?: boolean
}

const SETTINGS_KEY = 'bar-chess.settings'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Read persisted settings, dropping anything malformed or out of range so a
 * corrupt entry can never break startup. Returns null when nothing is stored.
 */
export function loadSettings(): SettingsPatch | null {
  let parsed: unknown
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return null
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null

  const out: SettingsPatch = {}
  if (isRecord(parsed.overlays)) {
    const overlays: Partial<OverlayFlags> = {}
    for (const [key, value] of Object.entries(parsed.overlays)) {
      if (typeof value === 'boolean') (overlays as Record<string, boolean>)[key] = value
    }
    out.overlays = overlays
  }
  if (typeof parsed.hudVisible === 'boolean') out.hudVisible = parsed.hudVisible
  if (typeof parsed.railsVisible === 'boolean') out.railsVisible = parsed.railsVisible
  if (typeof parsed.autoPreserve === 'boolean') out.autoPreserve = parsed.autoPreserve
  if (typeof parsed.captureAdvance === 'boolean') out.captureAdvance = parsed.captureAdvance
  if (typeof parsed.chessKills === 'boolean') out.chessKills = parsed.chessKills
  if (typeof parsed.speed === 'number' && SPEEDS.includes(parsed.speed)) out.speed = parsed.speed
  if (typeof parsed.gameMode === 'string' && GAME_MODES.some((m) => m.id === parsed.gameMode)) {
    out.gameMode = parsed.gameMode as GameMode
  }
  if (typeof parsed.soundEnabled === 'boolean') out.soundEnabled = parsed.soundEnabled
  if (isFraction(parsed.bottomFraction, BOTTOM_FRACTION_MIN, BOTTOM_FRACTION_MAX)) {
    out.bottomFraction = parsed.bottomFraction
  }
  if (isFraction(parsed.leftRailFraction, RAIL_FRACTION_MIN, RAIL_FRACTION_MAX)) {
    out.leftRailFraction = parsed.leftRailFraction
  }
  if (isFraction(parsed.rightRailFraction, RAIL_FRACTION_MIN, RAIL_FRACTION_MAX)) {
    out.rightRailFraction = parsed.rightRailFraction
  }
  if (typeof parsed.controlsCollapsed === 'boolean') out.controlsCollapsed = parsed.controlsCollapsed
  if (typeof parsed.stanceCollapsed === 'boolean') out.stanceCollapsed = parsed.stanceCollapsed
  if (typeof parsed.legendCollapsed === 'boolean') out.legendCollapsed = parsed.legendCollapsed
  if (typeof parsed.firingLinesCollapsed === 'boolean') {
    out.firingLinesCollapsed = parsed.firingLinesCollapsed
  }
  if (typeof parsed.copyCollapsed === 'boolean') out.copyCollapsed = parsed.copyCollapsed
  return out
}

function isFraction(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

/** Persist settings, ignoring storage failures (private mode, quota). */
export function saveSettings(settings: GameSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // Non-fatal: settings simply fall back to defaults next time.
  }
}

export function clearSettings(): void {
  try {
    localStorage.removeItem(SETTINGS_KEY)
  } catch {
    // Non-fatal.
  }
}
