import type { OrderKind, TeamId, Vec2 } from './types'

/** One piece's state at a turn boundary. */
export interface PieceTrace {
  entity: number
  team: TeamId
  kind: string
  cell: Vec2
  goal: Vec2 | null
  moving: boolean
  movedThisTurn: boolean
  orderKind: OrderKind
  target: number | null
  underFire: boolean
  hp: number
  maxHp: number
}

/** Every living piece sampled at the end of one turn (turn 0 = opening). */
export interface TurnTrace {
  turn: number
  tick: number
  pieces: PieceTrace[]
}

export const PIECE_LETTER: Record<string, string> = {
  pawn: 'P',
  knight: 'N',
  bishop: 'B',
  rook: 'R',
  queen: 'Q',
  king: 'K',
}

/** Compact piece tag, e.g. `rP` / `bN`. */
export function pieceTag(team: TeamId, kind: string): string {
  return `${team[0]}${PIECE_LETTER[kind] ?? '?'}`
}
