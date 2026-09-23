import type { Geometry, ProjectileShape, Trajectory } from './types'
import { ALL_DIRS, DIAG_DIRS, KNIGHT_OFFSETS, ORTHO_DIRS } from './types'

const SLIDE_RANGE = 24

export interface ProjectileDef {
  key: string
  trajectory: Trajectory
  /** world units per second, expressed in tiles */
  speed: number
  ttl: number
  radius: number
  splash: number
  /** rendered size in tiles */
  size: number
  shape: ProjectileShape
  spin: boolean
  color: string
}

export interface WeaponDef {
  key: string
  geometry: Geometry
  damage: number
  /** seconds between shots */
  cooldown: number
  projectile: string
}

export interface PieceDef {
  key: string
  name: string
  glyph: string
  hp: number
  move: Geometry
  /** seconds between movement steps */
  moveCooldown: number
  weapon: string
  buildTime: number
  supply: number
  cap: number
  size: number
  radius: number
}

export const PROJECTILES: Record<string, ProjectileDef> = {
  bolt: { key: 'bolt', trajectory: 'line', speed: 5, ttl: 4, radius: 0.1, splash: 0, size: 0.07, shape: 'dot', spin: false, color: '#ffd166' },
  shell: { key: 'shell', trajectory: 'line', speed: 3.2, ttl: 5, radius: 0.16, splash: 0.75, size: 0.1, shape: 'shell', spin: false, color: '#ff8f2d' },
  lance: { key: 'lance', trajectory: 'line', speed: 8.5, ttl: 3, radius: 0.08, splash: 0, size: 0.05, shape: 'lance', spin: false, color: '#9fe0ff' },
  knightShell: {
    key: 'knightShell',
    trajectory: 'jump',
    speed: 4.5,
    ttl: 4,
    radius: 0.16,
    splash: 0.5,
    size: 0.12,
    shape: 'bomb',
    spin: true,
    color: '#c9a6ff',
  },
  beam: { key: 'beam', trajectory: 'beam', speed: 70, ttl: 1, radius: 0.06, splash: 0, size: 0.05, shape: 'lance', spin: false, color: '#9be7ff' },
}

export const WEAPONS: Record<string, WeaponDef> = {
  pawnShot: {
    key: 'pawnShot',
    // chess capture: the two forward diagonals (a piece directly ahead blocks
    // the pawn, as in chess; it is not a valid target).
    geometry: { kind: 'slide', dirs: [[1, -1], [-1, -1]], range: 1 },
    damage: 7,
    cooldown: 1.3,
    projectile: 'bolt',
  },
  knightBomb: {
    key: 'knightBomb',
    geometry: { kind: 'leap', offsets: KNIGHT_OFFSETS },
    damage: 18,
    cooldown: 2.4,
    projectile: 'knightShell',
  },
  bishopLance: {
    key: 'bishopLance',
    geometry: { kind: 'slide', dirs: DIAG_DIRS, range: SLIDE_RANGE },
    damage: 12,
    cooldown: 1.5,
    projectile: 'lance',
  },
  rookShell: {
    key: 'rookShell',
    geometry: { kind: 'slide', dirs: ORTHO_DIRS, range: SLIDE_RANGE },
    damage: 20,
    cooldown: 1.9,
    projectile: 'shell',
  },
  queenNova: {
    key: 'queenNova',
    geometry: { kind: 'slide', dirs: ALL_DIRS, range: SLIDE_RANGE },
    damage: 24,
    cooldown: 1.7,
    projectile: 'bolt',
  },
  kingGuard: {
    key: 'kingGuard',
    geometry: { kind: 'slide', dirs: ALL_DIRS, range: 1 },
    damage: 14,
    cooldown: 1.1,
    projectile: 'bolt',
  },
}

export const PIECES: Record<string, PieceDef> = {
  pawn: {
    key: 'pawn',
    name: 'Pawn',
    glyph: '\u265f',
    hp: 42,
    // Up to two squares forward, but the double step is only legal from the
    // pawn's home rank (see `pawnHomeRank`); elsewhere it advances one.
    move: { kind: 'pawn', forward: 2 },
    moveCooldown: 1.1,
    weapon: 'pawnShot',
    buildTime: 2.5,
    supply: 1,
    cap: 16,
    size: 0.8,
    radius: 0.3,
  },
  knight: {
    key: 'knight',
    name: 'Knight',
    glyph: '\u265e',
    hp: 95,
    move: { kind: 'leap', offsets: KNIGHT_OFFSETS },
    moveCooldown: 1.6,
    weapon: 'knightBomb',
    buildTime: 6,
    supply: 3,
    cap: 6,
    size: 0.8,
    radius: 0.34,
  },
  bishop: {
    key: 'bishop',
    name: 'Bishop',
    glyph: '\u265d',
    hp: 75,
    move: { kind: 'slide', dirs: DIAG_DIRS, range: SLIDE_RANGE },
    moveCooldown: 1.2,
    weapon: 'bishopLance',
    buildTime: 5,
    supply: 3,
    cap: 6,
    size: 0.8,
    radius: 0.34,
  },
  rook: {
    key: 'rook',
    name: 'Rook',
    glyph: '\u265c',
    hp: 140,
    move: { kind: 'slide', dirs: ORTHO_DIRS, range: SLIDE_RANGE },
    moveCooldown: 1.8,
    weapon: 'rookShell',
    buildTime: 8,
    supply: 5,
    cap: 4,
    size: 0.8,
    radius: 0.38,
  },
  queen: {
    key: 'queen',
    name: 'Queen',
    glyph: '\u265b',
    hp: 165,
    move: { kind: 'slide', dirs: ALL_DIRS, range: SLIDE_RANGE },
    moveCooldown: 1.2,
    weapon: 'queenNova',
    buildTime: 12,
    supply: 7,
    cap: 2,
    size: 0.8,
    radius: 0.4,
  },
  king: {
    key: 'king',
    name: 'King',
    glyph: '\u265a',
    hp: 240,
    move: { kind: 'slide', dirs: ALL_DIRS, range: 1 },
    moveCooldown: 1,
    weapon: 'kingGuard',
    buildTime: 15,
    supply: 8,
    cap: 1,
    size: 0.8,
    radius: 0.42,
  },
}

export const PIECE_LIST: PieceDef[] = [
  PIECES.pawn,
  PIECES.knight,
  PIECES.bishop,
  PIECES.rook,
  PIECES.queen,
  PIECES.king,
]

export function weaponDef(key: string): WeaponDef {
  return WEAPONS[key]
}

/** How far a piece can notice an enemy, in cells. */
export function weaponVision(geometry: Geometry): number {
  if (geometry.kind === 'slide') return geometry.range
  if (geometry.kind === 'leap') {
    let max = 0
    for (const [dx, dy] of geometry.offsets) max = Math.max(max, Math.hypot(dx, dy))
    return max
  }
  return 2
}

export function projectileDef(key: string): ProjectileDef {
  return PROJECTILES[key]
}
