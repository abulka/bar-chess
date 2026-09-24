import { terrainDef } from '../game/board'
import { TEAM_COLORS } from '../game/constants'
import type { Game } from '../game/game'
import type { SavedMap } from '../game/map'
import { PIECES } from '../game/pieces'

const PIECE_FONT = '"Segoe UI Symbol", "Apple Symbols", serif'

/**
 * Draw the map editor cursor: a validity-tinted cell plus a translucent ghost of
 * the armed piece (or a red cross for the eraser).
 */
export function drawEditorCursor(ctx: CanvasRenderingContext2D, game: Game, zoom: number): void {
  const board = game.board
  const cell = game.hoverCell
  const brush = game.editorBrush
  if (!cell || !brush || !board.inBounds(cell.x, cell.y)) return

  const t = board.tile
  const valid =
    brush.kind === 'erase' ? game.pieceAt(cell.x, cell.y) !== null : game.canPlaceAt(cell.x, cell.y)
  const lineWidth = 2 / zoom

  ctx.save()
  ctx.fillStyle = valid ? 'rgba(120,255,150,0.18)' : 'rgba(255,90,90,0.2)'
  ctx.fillRect(cell.x * t, cell.y * t, t, t)
  ctx.strokeStyle = valid ? 'rgba(130,255,170,0.9)' : 'rgba(255,110,110,0.9)'
  ctx.lineWidth = lineWidth
  ctx.setLineDash([6 / zoom, 4 / zoom])
  ctx.strokeRect(cell.x * t + 1, cell.y * t + 1, t - 2, t - 2)
  ctx.setLineDash([])
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  if (brush.kind === 'piece') {
    const def = PIECES[brush.key]
    if (def) {
      const center = board.cellCenter(cell.x, cell.y)
      const size = def.size * t
      ctx.globalAlpha = 0.55
      ctx.fillStyle = TEAM_COLORS[brush.team]
      ctx.font = `${size * 0.92}px ${PIECE_FONT}`
      ctx.fillText(def.glyph, center.x, center.y + size * 0.04)
    }
  } else {
    const center = board.cellCenter(cell.x, cell.y)
    const r = t * 0.22
    ctx.globalAlpha = 0.95
    ctx.strokeStyle = 'rgba(255,110,110,0.95)'
    ctx.lineWidth = lineWidth * 1.4
    ctx.beginPath()
    ctx.moveTo(center.x - r, center.y - r)
    ctx.lineTo(center.x + r, center.y + r)
    ctx.moveTo(center.x + r, center.y - r)
    ctx.lineTo(center.x - r, center.y + r)
    ctx.stroke()
  }
  ctx.restore()
}

/** Render a compact top-down picture of a saved map into a square canvas. */
export function drawMapPreview(ctx: CanvasRenderingContext2D, map: SavedMap, sizePx: number): void {
  const board = map.board
  const cols = Math.max(1, board.width)
  const rows = Math.max(1, board.height)
  const cell = sizePx / Math.max(cols, rows)
  const ox = (sizePx - cols * cell) / 2
  const oy = (sizePx - rows * cell) / 2

  ctx.clearRect(0, 0, sizePx, sizePx)
  ctx.fillStyle = '#0b0f16'
  ctx.fillRect(0, 0, sizePx, sizePx)

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      ctx.fillStyle = terrainDef(board.terrain[y * cols + x] ?? 0).color
      ctx.fillRect(ox + x * cell, oy + y * cell, cell + 0.5, cell + 0.5)
    }
  }

  const spawn = board.spawns
  for (const team of ['red', 'blue'] as const) {
    const s = spawn?.[team]
    if (!s) continue
    ctx.fillStyle = team === 'red' ? 'rgba(255,159,67,0.16)' : 'rgba(90,176,255,0.16)'
    ctx.fillRect(ox + s.x * cell, oy + s.y * cell, s.w * cell, s.h * cell)
  }

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `${cell * 0.92}px ${PIECE_FONT}`
  for (const p of map.placements) {
    const def = PIECES[p.key]
    if (!def) continue
    ctx.fillStyle = TEAM_COLORS[p.team]
    ctx.fillText(def.glyph, ox + (p.x + 0.5) * cell, oy + (p.y + 0.5) * cell)
  }
}
