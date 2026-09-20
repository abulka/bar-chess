import { Cell, Fx, Health, Motion, PieceType, Position, Projectile, Render, Target, Team } from '../ecs/components'
import type { Entity } from '../ecs/world'
import { makeOccupied } from '../game/occupancy'
import { fireCells, moveDestinations } from '../game/geometry'
import { PIECES, WEAPONS } from '../game/pieces'
import type { Game } from '../game/game'
import { Camera } from './camera'
import { bakeTerrain } from './terrain'

export class Renderer {
  camera = new Camera()
  time = 0

  private terrain: HTMLCanvasElement | null = null
  private terrainKey = ''
  private canvas: HTMLCanvasElement

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1
    const rect = this.canvas.getBoundingClientRect()
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr))
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr))
    this.camera.viewportWidth = rect.width
    this.camera.viewportHeight = rect.height
  }

  fit(game: Game): void {
    this.camera.fit(game.board.pixelWidth, game.board.pixelHeight)
  }

  draw(game: Game): void {
    this.time += 1 / 60
    const ctx = this.canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const vw = this.camera.viewportWidth
    const vh = this.camera.viewportHeight
    const board = game.board

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#0b0f16'
    ctx.fillRect(0, 0, vw, vh)

    const key = `${board.data.id}:${board.width}x${board.height}:${game.terrainVersion}:${game.overlays.grid}`
    if (key !== this.terrainKey) {
      this.terrain = bakeTerrain(board, game.overlays.grid)
      this.terrainKey = key
    }

    const occupancy = this.buildOccupancy(game)
    const occupied = makeOccupied(board, occupancy)

    ctx.save()
    ctx.translate(vw / 2, vh / 2)
    ctx.scale(this.camera.zoom, this.camera.zoom)
    ctx.translate(-this.camera.x, -this.camera.y)

    if (this.terrain) ctx.drawImage(this.terrain, 0, 0)

    this.drawSpawns(ctx, game)
    if (game.overlays.intentions || game.overlays.ranges || game.overlays.targets) {
      this.drawBoardOverlays(ctx, game, occupied)
    }
    if (game.selected.length > 0) this.drawSelectedOverlays(ctx, game, occupied)
    this.drawPieces(ctx, game)
    this.drawTargets(ctx, game)
    this.drawProjectiles(ctx, game)
    this.drawFx(ctx, game)
    ctx.restore()

    this.drawBorder(ctx, game)
  }

  private buildOccupancy(game: Game): Map<number, Entity> {
    const map = new Map<number, Entity>()
    for (const e of game.world.query(Cell)) {
      const c = game.world.require(e, Cell)
      map.set(c.y * game.board.width + c.x, e)
    }
    return map
  }

  private drawSpawns(ctx: CanvasRenderingContext2D, game: Game): void {
    const t = game.board.tile
    for (const team of ['red', 'blue'] as const) {
      const s = game.board.data.spawns[team]
      ctx.fillStyle = team === 'red' ? 'rgba(255,107,90,0.05)' : 'rgba(90,176,255,0.05)'
      ctx.fillRect(s.x * t, s.y * t, s.w * t, s.h * t)
    }
  }

  private drawBoardOverlays(
    ctx: CanvasRenderingContext2D,
    game: Game,
    occupied: (x: number, y: number) => boolean,
  ): void {
    const board = game.board
    const t = board.tile
    for (const e of game.world.query(Position, Cell, Team, PieceType)) {
      const cell = game.world.require(e, Cell)
      const team = game.world.require(e, Team)
      const kind = game.world.require(e, PieceType).kind
      const def = PIECES[kind]
      if (!def) continue
      const tint = team === 'red' ? 'rgba(255,107,90,' : 'rgba(90,176,255,'

      if (game.overlays.ranges) {
        const moves = moveDestinations(board, cell, def.move, team, occupied)
        ctx.fillStyle = `${tint}0.06)`
        for (const c of moves) ctx.fillRect(c.x * t, c.y * t, t, t)
        const fires = fireCells(board, cell, WEAPONS[def.weapon].geometry, team, occupied)
        ctx.strokeStyle = `${tint}0.18)`
        ctx.lineWidth = 1 / this.camera.zoom
        for (const c of fires) ctx.strokeRect(c.x * t + 2, c.y * t + 2, t - 4, t - 4)
      }

      if (game.overlays.intentions) {
        const motion = game.world.get(e, Motion)
        const goal = motion?.goal ?? null
        if (goal) {
          const pos = game.world.require(e, Position)
          const center = board.cellCenter(goal.x, goal.y)
          ctx.strokeStyle = `${tint}0.28)`
          ctx.lineWidth = 1 / this.camera.zoom
          ctx.beginPath()
          ctx.moveTo(pos.x, pos.y)
          ctx.lineTo(center.x, center.y)
          ctx.stroke()
          ctx.beginPath()
          ctx.arc(center.x, center.y, t * 0.22, 0, Math.PI * 2)
          ctx.stroke()
        }
      }
    }
  }

  private drawSelectedOverlays(
    ctx: CanvasRenderingContext2D,
    game: Game,
    occupied: (x: number, y: number) => boolean,
  ): void {
    const board = game.board
    const t = board.tile

    for (const e of game.selected) {
      if (!game.world.isAlive(e)) continue
      const cell = game.world.get(e, Cell)
      const kind = game.world.get(e, PieceType)?.kind
      const team = game.world.get(e, Team)
      const motion = game.world.get(e, Motion)
      if (!cell || !kind || !team) continue
      const def = PIECES[kind]
      if (!def) continue
      const tint = team === 'red' ? 'rgba(255,107,90,' : 'rgba(90,176,255,'

      const moves = moveDestinations(board, cell, def.move, team, occupied)
      ctx.fillStyle = `${tint}0.14)`
      for (const c of moves) ctx.fillRect(c.x * t + 2, c.y * t + 2, t - 4, t - 4)

      const fires = fireCells(board, cell, WEAPONS[def.weapon].geometry, team, occupied)
      ctx.fillStyle = 'rgba(255,209,102,0.10)'
      ctx.strokeStyle = 'rgba(255,209,102,0.35)'
      ctx.lineWidth = 1 / this.camera.zoom
      for (const c of fires) {
        ctx.fillRect(c.x * t + 3, c.y * t + 3, t - 6, t - 6)
        ctx.strokeRect(c.x * t + 3, c.y * t + 3, t - 6, t - 6)
      }

      if (motion && motion.path.length > 0) {
        const pos = game.world.get(e, Position)
        if (pos) {
          ctx.strokeStyle = '#ffd166'
          ctx.lineWidth = 2 / this.camera.zoom
          ctx.setLineDash([5 / this.camera.zoom, 4 / this.camera.zoom])
          ctx.beginPath()
          ctx.moveTo(pos.x, pos.y)
          for (const c of motion.path) {
            const center = board.cellCenter(c.x, c.y)
            ctx.lineTo(center.x, center.y)
          }
          ctx.stroke()
          ctx.setLineDash([])
        }
      }
    }
  }

  private drawPieces(ctx: CanvasRenderingContext2D, game: Game): void {
    const t = game.board.tile
    const entities = game.world.query(Position, Render, Health, PieceType)
    const sorted = entities.slice().sort((a, b) => game.world.require(a, Position).y - game.world.require(b, Position).y)

    for (const e of sorted) {
      const pos = game.world.require(e, Position)
      const render = game.world.require(e, Render)
      const health = game.world.require(e, Health)
      const size = render.size * t

      ctx.fillStyle = 'rgba(0,0,0,0.35)'
      ctx.beginPath()
      ctx.ellipse(pos.x, pos.y + size * 0.3, size * 0.4, size * 0.18, 0, 0, Math.PI * 2)
      ctx.fill()

      ctx.beginPath()
      ctx.arc(pos.x, pos.y, size * 0.46, 0, Math.PI * 2)
      ctx.fillStyle = render.tint
      ctx.globalAlpha = 0.16
      ctx.fill()
      ctx.globalAlpha = 1
      ctx.strokeStyle = render.tint
      ctx.lineWidth = 1.5 / this.camera.zoom
      ctx.stroke()

      ctx.fillStyle = render.tint
      ctx.font = `${size * 0.92}px "Segoe UI Symbol", "Apple Symbols", serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(render.glyph, pos.x, pos.y + size * 0.04)

      if (game.overlays.health && health.cur < health.max) {
        this.drawHealthBar(ctx, pos.x, pos.y - size * 0.58, size, health.cur / health.max, render.tint)
      }

      if (game.selected.includes(e)) {
        ctx.strokeStyle = '#ffd166'
        ctx.lineWidth = 2 / this.camera.zoom
        ctx.beginPath()
        ctx.arc(pos.x, pos.y, size * 0.56, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
  }

  private drawHealthBar(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    ratio: number,
    tint: string,
  ): void {
    const w = width * 0.8
    const h = Math.max(2, width * 0.08)
    const left = x - w / 2
    ctx.fillStyle = 'rgba(0,0,0,0.65)'
    ctx.fillRect(left, y, w, h)
    const r = Math.max(0, Math.min(1, ratio))
    ctx.fillStyle = r > 0.5 ? '#5ad469' : r > 0.25 ? '#e3b341' : '#e8503a'
    ctx.fillRect(left, y, w * r, h)
    ctx.strokeStyle = tint
    ctx.lineWidth = 1 / this.camera.zoom
    ctx.strokeRect(left, y, w, h)
  }

  private drawTargets(ctx: CanvasRenderingContext2D, game: Game): void {
    const showAll = game.overlays.targets
    if (!showAll && game.selected.length === 0) return
    ctx.lineWidth = 1 / this.camera.zoom
    for (const e of game.world.query(Target, Position)) {
      const selected = game.selected.includes(e)
      if (!showAll && !selected) continue
      const target = game.world.require(e, Target).entity
      if (target === null) continue
      const tp = game.world.get(target, Position)
      const pos = game.world.require(e, Position)
      if (!tp) continue
      const team = game.world.get(e, Team)
      ctx.strokeStyle = selected
        ? 'rgba(255,209,102,0.6)'
        : team === 'red'
          ? 'rgba(255,107,90,0.22)'
          : 'rgba(90,176,255,0.22)'
      ctx.beginPath()
      ctx.moveTo(pos.x, pos.y)
      ctx.lineTo(tp.x, tp.y)
      ctx.stroke()
    }
  }

  private drawProjectiles(ctx: CanvasRenderingContext2D, game: Game): void {
    for (const e of game.world.query(Projectile, Position)) {
      const pos = game.world.require(e, Position)
      const proj = game.world.require(e, Projectile)

      if (proj.waypoints.length > 0) {
        ctx.strokeStyle = `${proj.color}55`
        ctx.lineWidth = 1.5 / this.camera.zoom
        ctx.beginPath()
        ctx.moveTo(pos.x, pos.y)
        for (let i = proj.waypointIndex; i < proj.waypoints.length; i++) {
          ctx.lineTo(proj.waypoints[i].x, proj.waypoints[i].y)
        }
        ctx.stroke()
      }

      ctx.fillStyle = proj.color
      ctx.beginPath()
      ctx.arc(pos.x, pos.y, proj.radius * game.board.tile, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = 0.25
      ctx.beginPath()
      ctx.arc(pos.x, pos.y, proj.radius * game.board.tile * 3, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = 1
    }
  }

  private drawFx(ctx: CanvasRenderingContext2D, game: Game): void {
    for (const e of game.world.query(Fx, Position)) {
      const pos = game.world.require(e, Position)
      const fx = game.world.require(e, Fx)
      const t = 1 - fx.ttl / fx.maxTtl
      const radius = fx.radius * (0.35 + t * 0.9)
      const alpha = Math.max(0, 1 - t)
      ctx.globalAlpha = alpha * 0.8
      ctx.fillStyle = '#ffcf6b'
      ctx.beginPath()
      ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = alpha
      ctx.strokeStyle = fx.color
      ctx.lineWidth = 2 / this.camera.zoom
      ctx.beginPath()
      ctx.arc(pos.x, pos.y, radius * 0.9, 0, Math.PI * 2)
      ctx.stroke()
      ctx.globalAlpha = 1
    }
  }

  private drawBorder(ctx: CanvasRenderingContext2D, game: Game): void {
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'
    ctx.lineWidth = 1 / this.camera.zoom
    ctx.strokeRect(0, 0, game.board.pixelWidth, game.board.pixelHeight)
  }
}
