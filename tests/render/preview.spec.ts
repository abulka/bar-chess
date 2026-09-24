// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { Game } from '../../src/game/game'
import { emptyMap } from '../../src/game/map'
import { PIECES } from '../../src/game/pieces'
import { drawEditorCursor, drawMapPreview } from '../../src/render/editor'
import { clearComponents } from '../helpers'

interface Rect {
  x: number
  y: number
  w: number
  h: number
  style: string
}

class RecordingContext {
  rects: Rect[] = []
  texts: Array<{ text: string; style: string }> = []
  fillStyle = ''
  strokeStyle = ''
  lineWidth = 1
  font = ''
  textAlign = ''
  textBaseline = ''
  globalAlpha = 1

  clearRect(): void {}
  fillRect(x: number, y: number, w: number, h: number): void {
    this.rects.push({ x, y, w, h, style: String(this.fillStyle) })
  }
  fillText(text: string): void {
    this.texts.push({ text, style: String(this.fillStyle) })
  }
  setTransform(): void {}
  save(): void {}
  restore(): void {}
  setLineDash(): void {}
  strokeRect(): void {}
  beginPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  stroke(): void {}
}

function asCtx(recorder: RecordingContext): CanvasRenderingContext2D {
  return recorder as unknown as CanvasRenderingContext2D
}

describe('map preview + editor cursor', () => {
  beforeEach(() => clearComponents())

  it('draws terrain, spawns and piece glyphs for a map', () => {
    const map = emptyMap(8, 'preview')
    map.placements = [{ team: 'red', key: 'king', x: 2, y: 3 }]
    const ctx = new RecordingContext()
    drawMapPreview(asCtx(ctx), map, 160)

    // 1 backdrop + 64 terrain cells + spawn rectangles.
    expect(ctx.rects.length).toBeGreaterThanOrEqual(65)
    expect(ctx.texts.map((t) => t.text)).toContain(PIECES.king.glyph)
  })

  it('tints the editor cursor by placement validity', () => {
    const game = new Game(8, 'human-vs-ai', 1)
    game.setEditor(true)
    game.setEditorBrush({ kind: 'piece', team: 'red', key: 'pawn' })
    game.setHover({ x: 4, y: 4 })

    const valid = new RecordingContext()
    drawEditorCursor(asCtx(valid), game, 1)
    expect(valid.rects.find((r) => r.x === 4 * 48)?.style).toContain('120,255,150')

    game.paint(4, 4, 4)
    const blocked = new RecordingContext()
    drawEditorCursor(asCtx(blocked), game, 1)
    expect(blocked.rects.find((r) => r.x === 4 * 48)?.style).toContain('255,90,90')
  })
})
