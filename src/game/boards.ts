import type { Board, MapData } from './board'
import type { TeamId, Vec2 } from './types'

export type BoardSize = 8 | 16 | 32 | 64

export const BOARD_SIZES: BoardSize[] = [8, 16, 32, 64]

const BACK_RANK = ['rook', 'knight', 'bishop', 'queen', 'king', 'bishop', 'knight', 'rook']

export interface Placement {
  team: TeamId
  key: string
  x: number
  y: number
}

export function createBoardData(size: BoardSize, name = `${size}\u00d7${size}`): MapData {
  const terrain = new Array<number>(size * size).fill(0)
  const offset = Math.max(0, Math.floor((size - 8) / 2))
  const files = Math.min(8, size)
  const lanes = (y: number): Vec2[] => {
    const out: Vec2[] = []
    for (let x = offset; x < offset + files; x++) out.push({ x, y })
    return out
  }
  return {
    id: `board-${size}`,
    name,
    width: size,
    height: size,
    tile: 48,
    legend: { '0': 0, '1': 1, '2': 2, '3': 3, '4': 4 },
    terrain,
    spawns: {
      red: { x: offset, y: 0, w: files, h: 2 },
      blue: { x: offset, y: size - 2, w: files, h: 2 },
    },
    lanes: {
      red: lanes(0),
      blue: lanes(size - 1),
    },
  }
}

export function initialArmy(size: BoardSize): Placement[] {
  const offset = Math.max(0, Math.floor((size - 8) / 2))
  const files = Math.min(8, size)
  const out: Placement[] = []
  for (let i = 0; i < files; i++) {
    const redKey = BACK_RANK[i % BACK_RANK.length]
    const blueKey = BACK_RANK[i % BACK_RANK.length]
    out.push({ team: 'blue', key: blueKey, x: offset + i, y: size - 1 })
    out.push({ team: 'red', key: redKey, x: offset + i, y: 0 })
    if (size >= 8) {
      out.push({ team: 'blue', key: 'pawn', x: offset + i, y: size - 2 })
      out.push({ team: 'red', key: 'pawn', x: offset + i, y: 1 })
    }
  }
  return out
}

export interface ArmyConfig {
  size: BoardSize
  id: string
  name: string
  army: Placement[]
}

export function boardConfigFromData(data: MapData, army: Placement[]): ArmyConfig {
  return { size: data.width as BoardSize, id: data.id, name: data.name, army }
}

export function defaultBoard(size: BoardSize = 16): ArmyConfig {
  const data = createBoardData(size)
  return { size, id: data.id, name: data.name, army: initialArmy(size) }
}

export function boardSizeOf(board: Board): BoardSize {
  return board.width as BoardSize
}
