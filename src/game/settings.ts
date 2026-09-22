import { SPEEDS } from './constants'
import { GAME_MODES } from './game'
import type { GameMode, OverlayFlags } from './game'

/** UI/session preferences that should survive a reload or a server restart. */
export interface GameSettings {
  overlays: OverlayFlags
  hudVisible: boolean
  speed: number
  gameMode: GameMode
  autoPreserve: boolean
}

/** A validated subset of settings to apply, as read from storage. */
export interface SettingsPatch {
  overlays?: Partial<OverlayFlags>
  hudVisible?: boolean
  speed?: number
  gameMode?: GameMode
  autoPreserve?: boolean
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
  if (typeof parsed.autoPreserve === 'boolean') out.autoPreserve = parsed.autoPreserve
  if (typeof parsed.speed === 'number' && SPEEDS.includes(parsed.speed)) out.speed = parsed.speed
  if (typeof parsed.gameMode === 'string' && GAME_MODES.some((m) => m.id === parsed.gameMode)) {
    out.gameMode = parsed.gameMode as GameMode
  }
  return out
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
