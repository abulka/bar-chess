import { VOICE_OVERRIDES, type VoiceSpec } from './voices'

/**
 * Runtime sound overrides, layered above the committed `VOICE_OVERRIDES` code.
 * Edits made in the synth editor are accumulated here, persisted to
 * `localStorage`, and applied to the live game immediately (the engine resolves
 * the effective spec at play time). `formatAllOverrides()` / `formatEntry()`
 * emit the saved set as a ready-to-paste `VOICE_OVERRIDES` block/line for
 * committing to code. See ARCHITECTURE.md §11, "Voice override workflow".
 */

export type OverrideSource = 'local' | 'code' | null

const STORAGE_KEY = 'bar-chess.soundOverrides'
const VERSION = 1

let overrides: Record<string, VoiceSpec> = {}
let loaded = false
const listeners = new Set<() => void>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFilter(value: unknown): boolean {
  return isRecord(value) && typeof value.from === 'number'
}

function isVoiceEvent(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value.duration !== 'number' || typeof value.gain !== 'number') return false
  if ('from' in value) {
    return typeof value.type === 'string' && typeof value.from === 'number' && (value.filter === undefined || isFilter(value.filter))
  }
  return isFilter(value.filter)
}

function isVoiceSpec(value: unknown): value is VoiceSpec {
  return Array.isArray(value) && value.length > 0 && value.every(isVoiceEvent)
}

function clone(spec: VoiceSpec): VoiceSpec {
  return JSON.parse(JSON.stringify(spec)) as VoiceSpec
}

function readStorage(): Record<string, VoiceSpec> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    const source = isRecord(parsed) && isRecord(parsed.overrides) ? parsed.overrides : parsed
    if (!isRecord(source)) return {}
    const out: Record<string, VoiceSpec> = {}
    for (const [id, value] of Object.entries(source)) {
      if (isVoiceSpec(value)) out[id] = value
    }
    return out
  } catch {
    return {}
  }
}

function persist(): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, overrides }))
  } catch {
    // Non-fatal: overrides simply do not survive the session.
  }
}

function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  overrides = readStorage()
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // A bad observer must not break the store.
    }
  }
}

/** Re-read `localStorage` into memory (used after external changes / tests). */
export function reloadOverrides(): void {
  loaded = false
  ensureLoaded()
  notify()
}

export function getOverride(id: string): VoiceSpec | undefined {
  ensureLoaded()
  return overrides[id]
}

export function hasLocalOverride(id: string): boolean {
  ensureLoaded()
  return id in overrides
}

export function setOverride(id: string, spec: VoiceSpec): void {
  ensureLoaded()
  overrides[id] = clone(spec)
  persist()
  notify()
}

export function clearOverride(id: string): void {
  ensureLoaded()
  if (!(id in overrides)) return
  delete overrides[id]
  persist()
  notify()
}

export function clearAllOverrides(): void {
  ensureLoaded()
  if (Object.keys(overrides).length === 0) return
  overrides = {}
  persist()
  notify()
}

export function hasOverrides(): boolean {
  ensureLoaded()
  return Object.keys(overrides).length > 0
}

export function overrideCount(): number {
  ensureLoaded()
  return Object.keys(overrides).length
}

/** A copy of every saved override, safe to mutate. */
export function allOverrides(): Record<string, VoiceSpec> {
  ensureLoaded()
  return JSON.parse(JSON.stringify(overrides)) as Record<string, VoiceSpec>
}

export function subscribeOverrides(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Whether a cue is overridden, and by which layer. */
export function overrideSource(id: string): OverrideSource {
  ensureLoaded()
  if (id in overrides) return 'local'
  if (id in VOICE_OVERRIDES) return 'code'
  return null
}

/** Effective spec: local override → committed code override → built-in voice. */
export function resolveSpec(id: string, builtin: VoiceSpec): VoiceSpec {
  ensureLoaded()
  return overrides[id] ?? VOICE_OVERRIDES[id] ?? builtin
}

/** The committed spec for a cue (code override or built-in), ignoring local overrides. */
export function committedSpec(id: string, builtin: VoiceSpec): VoiceSpec {
  return VOICE_OVERRIDES[id] ?? builtin
}

/** `"shot.pawnShot": [ … ],` — a single entry to paste inside the braces. */
export function formatEntry(id: string, spec: VoiceSpec): string {
  return `${JSON.stringify(id)}: ${JSON.stringify(spec, null, 2)},`
}

/** The full, pasteable `VOICE_OVERRIDES` declaration for every saved override. */
export function formatAllOverrides(): string {
  return `export const VOICE_OVERRIDES: Record<string, VoiceSpec> = ${JSON.stringify(allOverrides(), null, 2)}`
}
