import { cellIndex } from './board'
import { fileLabel } from './coords'
import { PIECE_LETTER } from './trace'
import type { TeamId, Vec2 } from './types'

export const TERRAIN_CHAR: Record<number, string> = {
  0: '.',
  1: ':',
  2: ',',
  3: '~',
  4: '#',
}

/** Minimum shape needed to draw a piece on an ASCII grid. */
export interface GridPiece {
  team: TeamId
  kind: string
  cell: Vec2
}

/**
 * ASCII board: file-letter header plus rank rows, red upper / blue lower.
 * `emptyChar` renders cells with no piece (defaults to `.`).
 */
export function renderAsciiGrid(
  pieces: readonly GridPiece[],
  width: number,
  height: number,
  emptyChar: (x: number, y: number) => string = () => '.',
): string {
  const byCell = new Map<number, GridPiece>()
  for (const p of pieces) byCell.set(cellIndex(p.cell.x, p.cell.y, width), p)
  const files: string[] = []
  for (let x = 0; x < width; x++) files.push(fileLabel(x))
  const lines: string[] = ['  ' + files.join(' ')]
  for (let y = 0; y < height; y++) {
    const rank = String(height - y).padStart(String(height).length)
    const cells: string[] = []
    for (let x = 0; x < width; x++) {
      const piece = byCell.get(cellIndex(x, y, width))
      if (piece) {
        const letter = PIECE_LETTER[piece.kind] ?? '?'
        cells.push(piece.team === 'red' ? letter : letter.toLowerCase())
      } else {
        cells.push(emptyChar(x, y))
      }
    }
    lines.push(`${rank} ${cells.join(' ')}`)
  }
  return lines.join('\n')
}

/**
 * Sort comparator factory: red before blue, then bottom-to-top, left-to-right.
 * `key` maps each item to the common `{team, x, y}` shape.
 */
export function byTeamThenCell<T>(
  key: (item: T) => { team: TeamId; x: number; y: number },
): (a: T, b: T) => number {
  return (a, b) => {
    const ka = key(a)
    const kb = key(b)
    if (ka.team !== kb.team) return ka.team === 'red' ? -1 : 1
    return ka.y - kb.y || ka.x - kb.x
  }
}
