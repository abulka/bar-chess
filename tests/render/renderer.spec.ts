// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/render/terrain', () => ({
  bakeTerrain: () => ({ width: 0, height: 0 }),
}))

import { Health, Motion, PieceType, Position, Render, Target, Weapon } from '../../src/ecs/components'
import { Game } from '../../src/game/game'
import { buildOccupancy } from '../../src/game/occupancy'
import { WEAPONS } from '../../src/game/pieces'
import { HEAL_COLOR } from '../../src/game/healing'
import { BAR_BG, PRESERVE_COLOR, RELOAD_FILL, healthColor } from '../../src/render/palette'
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
  fills: Rect[] = []
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
  rect(): void {}
  clip(): void {}
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
  createRadialGradient(): { addColorStop: () => void } {
    return { addColorStop: () => {} }
  }
  stroke(): void {
    this.strokes.push({
      style: this.strokeStyle,
      width: this.lineWidth,
      dash: [...this.dash],
      points: [...this.points],
    })
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.fills.push({ x, y, w, h, style: this.fillStyle })
  }
  strokeRect(x: number, y: number, w: number, h: number): void {
    this.rects.push({ x, y, w, h, style: this.strokeStyle })
  }
  fillText(): void {}
  measureText(text: string): { width: number } {
    return { width: text.length * 8 }
  }
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

/** The in-world bar frames (dark backgrounds), one per visible bar. */
const barFrames = (ctx: RecordingContext) => ctx.fills.filter((f) => f.style === BAR_BG)
/** Any bar-sized outline strokes; the BAR-style bars must not draw one. */
const barOutlines = (ctx: RecordingContext) => ctx.rects.filter((r) => Math.abs(r.w - TILE * 0.46) < 0.01)

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

describe('Renderer autonomous target overlay', () => {
  const ENGAGE = '#e3b341'
  let s: ReturnType<typeof setup>
  let attacker: number
  let target: number

  beforeEach(() => {
    s = setup()
    attacker = placePiece(s.game, 'queen', 'blue', { x: 4, y: 4 })
    target = placePiece(s.game, 'king', 'red', { x: 4, y: 6 })
    s.game.selected = [attacker]
  })

  it('draws an amber line + ring for an auto-acquired target', () => {
    s.game.world.require(attacker, Target).entity = target
    s.renderer.draw(s.game)

    const line = firingStrokes(s.ctx).filter((st) => st.style === ENGAGE)
    expect(line).toHaveLength(1)
    expect(line[0].dash).toEqual([])
    expect(line[0].points).toEqual([center(4, 4), center(4, 6)])
    // The victim is ringed amber (an arc-only stroke) and never red.
    expect(s.ctx.strokes.some((st) => st.style === ENGAGE && st.points.length === 0)).toBe(true)
    expect(s.ctx.strokes.some((st) => st.style === TRACK)).toBe(false)
  })

  it('keeps an ordered attack red and never duplicates it in amber', () => {
    orderAttack(s.game, attacker, target, true)
    s.game.world.require(attacker, Target).entity = target
    s.renderer.draw(s.game)

    expect(firingStrokes(s.ctx).filter((st) => st.style === TRACK)).toHaveLength(1)
    expect(s.ctx.strokes.some((st) => st.style === ENGAGE)).toBe(false)
  })

  it('hides an auto-acquired target outside the overlay scope', () => {
    s.game.selected = []
    s.game.world.require(attacker, Target).entity = target
    s.renderer.draw(s.game)

    expect(s.ctx.strokes.some((st) => st.style === ENGAGE)).toBe(false)
  })
})

describe('Renderer destination marker', () => {
  it('draws a hollow diamond (not a cross) at the motion goal', () => {
    const { renderer, ctx, game } = setup()
    const piece = placePiece(game, 'rook', 'blue', { x: 2, y: 2 })
    game.selected = [piece]
    game.world.require(piece, Motion).goal = { x: 4, y: 2 }
    renderer.draw(game)

    const c = center(4, 2)
    const r = TILE * 0.28
    const diamond = ctx.strokes.find(
      (st) => st.points.length === 4 && st.points[0].x === c.x && st.points[0].y === c.y - r,
    )
    expect(diamond).toBeDefined()
    expect(diamond!.points).toEqual([
      { x: c.x, y: c.y - r },
      { x: c.x + r, y: c.y },
      { x: c.x, y: c.y + r },
      { x: c.x - r, y: c.y },
    ])
    // A non-goto (autonomous) goal is best-effort, so the diamond is dashed.
    expect(diamond!.dash.length).toBeGreaterThan(0)
  })
})

describe('Renderer range arc', () => {
  const ARC_STYLE = 'rgba(255,255,255,0.045)'

  /** End cells of the range-arc rays recorded for the current draw. */
  function arcEnds(ctx: RecordingContext): { x: number; y: number }[] {
    const arc = ctx.strokes.find((s) => s.style === ARC_STYLE)
    expect(arc).toBeDefined()
    const ends: { x: number; y: number }[] = []
    for (let i = 1; i < arc!.points.length; i += 2) {
      const p = arc!.points[i]
      ends.push({ x: Math.floor(p.x / TILE), y: Math.floor(p.y / TILE) })
    }
    return ends
  }

  it('covers only slider lines for a queen, never knight-reachable cells', () => {
    const { renderer, ctx, game } = setup()
    game.overlays.rangeArcs = true
    const queen = placePiece(game, 'queen', 'blue', { x: 3, y: 7 }) // d1
    game.selected = [queen]
    renderer.draw(game)

    // One path: file (up), rank (both ways) and the two upward diagonals = 5 rays.
    const ends = arcEnds(ctx)
    expect(ends).toHaveLength(5)
    for (const c of ends) {
      const dx = c.x - 3
      const dy = c.y - 7
      expect(dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy)).toBe(true)
    }
    // h3 is a knight's move from d1 and must not be shaded.
    expect(ends).not.toContainEqual({ x: 7, y: 5 })
  })

  it('shades only the eight adjacent cells for a king', () => {
    const { renderer, ctx, game } = setup()
    game.overlays.rangeArcs = true
    const king = placePiece(game, 'king', 'blue', { x: 4, y: 7 }) // e1
    game.selected = [king]
    renderer.draw(game)

    const ends = arcEnds(ctx)
    // In-board rays: up, left, right, up-left and up-right.
    expect(ends).toHaveLength(5)
    for (const c of ends) {
      expect(Math.max(Math.abs(c.x - 4), Math.abs(c.y - 7))).toBe(1)
    }
  })
})

describe('Renderer hover coordinate label', () => {
  it('backs the label over a piece and leaves an empty square clear', () => {
    const { renderer, ctx, game } = setup()
    const pieceCell = { x: 3, y: 3 }
    placePiece(game, 'rook', 'blue', pieceCell)

    game.hoverCell = pieceCell
    ctx.fills = []
    renderer.draw(game)
    const overPiece = ctx.fills.filter((f) => f.style === '#0b0f16' && f.w < TILE)
    expect(overPiece).toHaveLength(1)
    expect(overPiece[0].x).toBeCloseTo(pieceCell.x * TILE + TILE * 0.08 - TILE * 0.05)

    const occ = buildOccupancy(game.world, game.board)
    let empty: { x: number; y: number } | null = null
    for (let y = 0; y < game.board.height && !empty; y++) {
      for (let x = 0; x < game.board.width; x++) {
        if (!occ.has(y * game.board.width + x)) {
          empty = { x, y }
          break
        }
      }
    }
    expect(empty).not.toBeNull()
    game.hoverCell = empty
    ctx.fills = []
    renderer.draw(game)
    expect(ctx.fills.filter((f) => f.style === '#0b0f16' && f.w < TILE)).toHaveLength(0)
  })
})

describe('Renderer healing overlay', () => {
  const AURA = 'rgba(74,217,145'

  it('draws a green aura ring and a wavy tendril to a damaged piece', () => {
    const { renderer, ctx, game } = setup()
    game.overlays.healing = true
    placePiece(game, 'king', 'blue', { x: 4, y: 4 })
    const pawn = placePiece(game, 'pawn', 'blue', { x: 5, y: 5 })
    game.world.require(pawn, Health).cur = 10

    ctx.strokes = []
    renderer.draw(game)

    // The dashed boundary ring is an arc-only stroke in the aura colour.
    expect(ctx.strokes.some((st) => st.style.startsWith(AURA) && st.points.length === 0)).toBe(true)
    // The tendril is a multi-point wavy polyline in the healing green.
    expect(ctx.strokes.some((st) => st.style === HEAL_COLOR && st.points.length > 2)).toBe(true)
  })

  it('draws no aura or tendrils when the overlay is off', () => {
    const { renderer, ctx, game } = setup()
    game.overlays.healing = false
    placePiece(game, 'king', 'blue', { x: 4, y: 4 })
    const pawn = placePiece(game, 'pawn', 'blue', { x: 5, y: 5 })
    game.world.require(pawn, Health).cur = 10

    ctx.strokes = []
    renderer.draw(game)

    expect(ctx.strokes.some((st) => st.style.startsWith(AURA))).toBe(false)
    expect(ctx.strokes.some((st) => st.style === HEAL_COLOR)).toBe(false)
  })
})

describe('Renderer self-preservation route', () => {
  it('draws the retreat route in the preserve colour, not the order gold', () => {
    const { renderer, ctx, game } = setup()
    const piece = placePiece(game, 'rook', 'blue', { x: 4, y: 4 })
    game.selected = [piece]
    const motion = game.world.require(piece, Motion)
    motion.goal = { x: 4, y: 2 }
    motion.intent = 'preserve'
    motion.path = [{ x: 4, y: 3 }, { x: 4, y: 2 }]

    ctx.strokes = []
    renderer.draw(game)

    expect(ctx.strokes.some((st) => st.style === PRESERVE_COLOR && st.points.length > 2)).toBe(true)
    expect(ctx.strokes.some((st) => st.style === ROUTE && st.points.length > 2)).toBe(false)
  })
})

describe('Renderer health and recharge bars', () => {
  it('draws a teal recharge bar only for a charging, long-cooldown weapon', () => {
    const { renderer, ctx, game } = setup()
    game.overlays.health = false
    for (const e of game.world.query(Weapon)) game.world.require(e, Weapon).left = 0

    ctx.fills = []
    renderer.draw(game)
    expect(barFrames(ctx)).toHaveLength(0)

    const knight = placePiece(game, 'knight', 'blue', { x: 2, y: 2 })
    const weapon = game.world.require(knight, Weapon)
    weapon.left = WEAPONS.knightBomb.cooldown / 2
    weapon.fired = true
    ctx.fills = []
    renderer.draw(game)
    expect(barFrames(ctx)).toHaveLength(1)
    expect(ctx.fills.some((f) => f.style === RELOAD_FILL)).toBe(true)
  })

  it('hides the recharge bar until the weapon has fired', () => {
    const { renderer, ctx, game } = setup()
    game.overlays.health = false
    for (const e of game.world.query(Weapon)) {
      const weapon = game.world.require(e, Weapon)
      weapon.left = 0
      weapon.fired = false
    }
    const knight = placePiece(game, 'knight', 'blue', { x: 2, y: 2 })
    const weapon = game.world.require(knight, Weapon)
    weapon.left = WEAPONS.knightBomb.cooldown / 2
    weapon.fired = false

    ctx.fills = []
    renderer.draw(game)
    expect(barFrames(ctx)).toHaveLength(0)
  })

  it('skips the recharge bar for fast weapons', () => {
    const { renderer, ctx, game } = setup()
    game.overlays.health = false
    for (const e of game.world.query(Weapon)) game.world.require(e, Weapon).left = 0
    const pawn = placePiece(game, 'pawn', 'blue', { x: 2, y: 2 })
    const weapon = game.world.require(pawn, Weapon)
    weapon.left = WEAPONS.pawnShot.cooldown / 2
    weapon.fired = true

    ctx.fills = []
    renderer.draw(game)
    expect(barFrames(ctx)).toHaveLength(0)
  })

  it('hides the health bar when full and draws it when damaged', () => {
    const { renderer, ctx, game } = setup()
    game.overlays.reload = false

    ctx.fills = []
    renderer.draw(game)
    expect(barFrames(ctx)).toHaveLength(0)

    const damaged = game.world.query(Health)[0]
    game.world.require(damaged, Health).cur = game.world.require(damaged, Health).max / 2
    ctx.fills = []
    renderer.draw(game)
    expect(barFrames(ctx)).toHaveLength(1)
  })

  it('draws a fixed dark frame with no coloured outline', () => {
    const { renderer, ctx, game } = setup()
    game.overlays.reload = false
    const health = game.world.require(game.world.query(Health)[0], Health)
    health.cur = health.max / 2

    ctx.fills = []
    ctx.rects = []
    renderer.draw(game)
    expect(barFrames(ctx)).toHaveLength(1)
    expect(barOutlines(ctx)).toHaveLength(0)
  })

  it('interpolates the health fill from green to red, red by 40%', () => {
    expect(healthColor(1)).toBe('rgb(76,217,100)')
    expect(healthColor(0.7)).toBe('rgb(166,138,74)')
    expect(healthColor(0.4)).toBe('rgb(255,59,48)')
    expect(healthColor(0.3)).toBe('rgb(255,59,48)')
    expect(healthColor(0)).toBe('rgb(255,59,48)')
  })

  it('uses the interpolated colour for a damaged piece', () => {
    const { renderer, ctx, game } = setup()
    game.overlays.reload = false
    const health = game.world.require(game.world.query(Health)[0], Health)
    health.cur = health.max * 0.8

    ctx.fills = []
    renderer.draw(game)
    expect(ctx.fills.some((f) => f.style === healthColor(0.8))).toBe(true)
  })
})
