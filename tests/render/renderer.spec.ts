// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/render/terrain', () => ({
  bakeTerrain: () => ({ width: 0, height: 0 }),
}))

import { Health, Motion, PieceType, Position, Render } from '../../src/ecs/components'
import { Game } from '../../src/game/game'
import { Renderer } from '../../src/render/renderer'
import { orderAttack, placePiece } from '../helpers'

const TRACK = '#ff2d20'
const UNREACHABLE = '#a0a6ac'
const ROUTE = '#ffd166'
const TILE = 48
const center = (x: number, y: number) => ({ x: (x + 0.5) * TILE, y: (y + 0.5) * TILE })

interface Stroke {
  style: string
  width: number
  dash: number[]
  points: { x: number; y: number }[]
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
  style: string
}

class RecordingContext {
  strokes: Stroke[] = []
  rects: Rect[] = []
  strokeStyle = ''
  fillStyle = ''
  lineWidth = 1
  font = ''
  textAlign = ''
  textBaseline = ''
  lineCap = ''
  globalAlpha = 1

  private dash: number[] = []
  private points: { x: number; y: number }[] = []

  setTransform(): void {}
  save(): void {}
  restore(): void {}
  translate(): void {}
  scale(): void {}
  rotate(): void {}
  beginPath(): void {
    this.points = []
  }
  closePath(): void {}
  moveTo(x: number, y: number): void {
    this.points.push({ x, y })
  }
  lineTo(x: number, y: number): void {
    this.points.push({ x, y })
  }
  arc(): void {}
  ellipse(): void {}
  fill(): void {}
  stroke(): void {
    this.strokes.push({
      style: this.strokeStyle,
      width: this.lineWidth,
      dash: [...this.dash],
      points: [...this.points],
    })
  }
  fillRect(): void {}
  strokeRect(x: number, y: number, w: number, h: number): void {
    this.rects.push({ x, y, w, h, style: this.strokeStyle })
  }
  fillText(): void {}
  drawImage(): void {}
  setLineDash(dash: number[]): void {
    this.dash = dash
  }
  getLineDash(): number[] {
    return this.dash
  }
}

function setup(): { renderer: Renderer; ctx: RecordingContext; game: Game } {
  const game = new Game(8)
  game.overlays.moveCells = false
  game.overlays.attackCells = false
  game.overlays.rangeArcs = false
  game.overlays.myOrders = false
  game.overlays.enemyPlans = false

  const ctx = new RecordingContext()
  const canvas = { getContext: () => ctx } as unknown as HTMLCanvasElement
  const renderer = new Renderer(canvas)
  renderer.camera.viewportWidth = 800
  renderer.camera.viewportHeight = 600
  renderer.camera.zoom = 1
  renderer.camera.x = game.board.pixelWidth / 2
  renderer.camera.y = game.board.pixelHeight / 2
  return { renderer, ctx, game }
}

const firingStrokes = (ctx: RecordingContext) => ctx.strokes.filter((s) => s.points.length === 2)

describe('Renderer firing-line overlay', () => {
  let s: ReturnType<typeof setup>
  let attacker: number
  let target: number

  beforeEach(() => {
    s = setup()
    attacker = placePiece(s.game, 'queen', 'blue', { x: 4, y: 4 })
    target = placePiece(s.game, 'king', 'red', { x: 4, y: 6 })
    s.game.selected = [attacker]
  })

  it('draws one solid red line to the target on a clear shot', () => {
    orderAttack(s.game, attacker, target, true)
    s.renderer.draw(s.game)

    const line = firingStrokes(s.ctx).filter((st) => st.style === TRACK)
    expect(line).toHaveLength(1)
    expect(line[0].dash).toEqual([])
    expect(line[0].points).toEqual([center(4, 4), center(4, 6)])
  })

  it('draws solid red to a blocker then dashed red to the target', () => {
    placePiece(s.game, 'rook', 'red', { x: 4, y: 5 })
    orderAttack(s.game, attacker, target, true)
    s.renderer.draw(s.game)

    const line = firingStrokes(s.ctx).filter((st) => st.style === TRACK)
    expect(line).toHaveLength(2)
    expect(line[0].dash).toEqual([])
    expect(line[0].points).toEqual([center(4, 4), center(4, 5)])
    expect(line[1].dash.length).toBeGreaterThan(0)
    expect(line[1].points).toEqual([center(4, 5), center(4, 6)])
  })

  it('draws a dashed grey line when the target is out of reach', () => {
    orderAttack(s.game, attacker, target, false)
    s.renderer.draw(s.game)

    const grey = firingStrokes(s.ctx).filter((st) => st.style === UNREACHABLE)
    expect(grey).toHaveLength(1)
    expect(grey[0].dash.length).toBeGreaterThan(0)
    expect(grey[0].points).toEqual([center(4, 4), center(4, 6)])
    expect(firingStrokes(s.ctx).some((st) => st.style === TRACK)).toBe(false)
  })

  it('draws the gold dashed movement route before the firing line', () => {
    orderAttack(s.game, attacker, target, true)
    s.game.world.require(attacker, Motion).path = [{ x: 4, y: 5 }]
    s.renderer.draw(s.game)

    const route = s.ctx.strokes.find((st) => st.style === ROUTE)
    expect(route).toBeDefined()
    expect(route!.dash.length).toBeGreaterThan(0)
    expect(route!.points[0]).toEqual(center(4, 4))
    expect(route!.points[route!.points.length - 1]).toEqual(center(4, 5))
  })
})

describe('Renderer reload overlay', () => {
  it('draws one firing-recharge bar per piece only when enabled', () => {
    const { renderer, ctx, game } = setup()
    const pieces = game.world.query(Position, Render, Health, PieceType).length
    expect(pieces).toBeGreaterThan(0)

    ctx.rects = []
    game.overlays.reload = true
    renderer.draw(game)
    const withReload = ctx.rects.length

    ctx.rects = []
    game.overlays.reload = false
    renderer.draw(game)
    const withoutReload = ctx.rects.length

    expect(withReload - withoutReload).toBe(pieces)
  })
})
