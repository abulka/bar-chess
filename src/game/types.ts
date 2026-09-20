export type TeamId = 'red' | 'blue'

export interface Vec2 {
  x: number
  y: number
}

export type IntentMode = 'move' | 'fight' | 'hold'

export type Trajectory = 'line' | 'homing' | 'arc' | 'jump' | 'beam'

export type Dir = readonly [number, number]

/**
 * Movement / firing geometry is defined from "blue perspective", i.e. forward is
 * -y (up the board, toward red at the top). For red pieces the y component is
 * negated at resolve time; this is a no-op for the symmetric chess patterns.
 */
export type Geometry =
  | { kind: 'slide'; dirs: readonly Dir[]; range: number }
  | { kind: 'leap'; offsets: readonly Dir[] }
  | { kind: 'pawn'; forward: number }

export const ORTHO_DIRS: readonly Dir[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

export const DIAG_DIRS: readonly Dir[] = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
]

export const ALL_DIRS: readonly Dir[] = [...ORTHO_DIRS, ...DIAG_DIRS]

export const KNIGHT_OFFSETS: readonly Dir[] = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
]

export interface ResolvedSlide {
  kind: 'slide'
  dirs: readonly Dir[]
  range: number
}

export interface ResolvedLeap {
  kind: 'leap'
  offsets: readonly Dir[]
}

export interface ResolvedPawn {
  kind: 'pawn'
  forward: number
  dy: number
}

export type ResolvedGeometry = ResolvedSlide | ResolvedLeap | ResolvedPawn

export function resolveGeometry(geometry: Geometry, team: TeamId): ResolvedGeometry {
  const flip = team === 'red' ? -1 : 1
  if (geometry.kind === 'slide') {
    return {
      kind: 'slide',
      range: geometry.range,
      dirs: geometry.dirs.map(([dx, dy]) => [dx, dy * flip] as Dir),
    }
  }
  if (geometry.kind === 'leap') {
    return {
      kind: 'leap',
      offsets: geometry.offsets.map(([dx, dy]) => [dx, dy * flip] as Dir),
    }
  }
  return { kind: 'pawn', forward: geometry.forward, dy: -flip }
}
