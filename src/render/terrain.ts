import { terrainDef } from '../game/board'
import type { Board } from '../game/board'

function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16)
  const r = Math.min(255, Math.max(0, ((n >> 16) & 255) + amount))
  const g = Math.min(255, Math.max(0, ((n >> 8) & 255) + amount))
  const b = Math.min(255, Math.max(0, (n & 255) + amount))
  return `rgb(${r},${g},${b})`
}

/** Bakes flat terrain colours once per board so the hot path only blits. */
export function bakeTerrain(board: Board, showGrid: boolean): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = board.pixelWidth
  canvas.height = board.pixelHeight
  const ctx = canvas.getContext('2d')!
  const t = board.tile

  for (let y = 0; y < board.height; y++) {
    for (let x = 0; x < board.width; x++) {
      const def = terrainDef(board.terrainAt(x, y))
      const parity = (x + y) % 2 === 0 ? 1 : 0
      const noise = ((x * 73856093) ^ (y * 19349663)) % 10
      ctx.fillStyle = shade(def.color, noise - 5 + parity * 6)
      ctx.fillRect(x * t, y * t, t, t)
    }
  }

  if (showGrid) {
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let x = 0; x <= board.width; x++) {
      ctx.moveTo(x * t + 0.5, 0)
      ctx.lineTo(x * t + 0.5, board.pixelHeight)
    }
    for (let y = 0; y <= board.height; y++) {
      ctx.moveTo(0, y * t + 0.5)
      ctx.lineTo(board.pixelWidth, y * t + 0.5)
    }
    ctx.stroke()
  }

  return canvas
}
