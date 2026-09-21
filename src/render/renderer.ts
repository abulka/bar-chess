import { Cell, Fx, Health, Motion, PieceType, Position, Projectile, Render, Target, Team } from '../ecs/components'
import type { Entity } from '../ecs/world'
import { buildOccupancy, makeOccupied } from '../game/occupancy'
import { fireCells, moveDestinations } from '../game/geometry'
import { PIECES, WEAPONS } from '../game/pieces'
import { resolveGeometry } from '../game/types'
import type { Game } from '../game/game'
import { Camera } from './camera'
import { bakeTerrain } from './terrain'

export class Renderer {
  camera = new Camera()
  time = 0

  private terrain: HTMLCanvasElement | null = null
  private terrainKey = ''
  private canvas: HTMLCanvasElement
  private worldW = 0
  private worldH = 0

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
    if (this.worldW > 0) this.camera.updateLimits(this.worldW, this.worldH)
  }

  fit(game: Game): void {
    this.worldW = game.board.pixelWidth
    this.worldH = game.board.pixelHeight
    this.camera.fit(this.worldW, this.worldH)
  }

  draw(game: Game): void {
    this.time += 1 / 60
    const ctx = this.canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const vw = this.camera.viewportWidth
    const vh = this.camera.viewportHeight
    const board = game.board
    this.worldW = board.pixelWidth
    this.worldH = board.pixelHeight

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = '#0b0f16'
    ctx.fillRect(0, 0, vw, vh)

    const key = `${board.data.id}:${board.width}x${board.height}:${game.terrainVersion}:${game.overlays.grid}`
    if (key !== this.terrainKey) {
      this.terrain = bakeTerrain(board, game.overlays.grid)
      this.terrainKey = key
    }

    const occupancy = buildOccupancy(game.world, board)
    const occupied = makeOccupied(board, occupancy)

    ctx.save()
    ctx.translate(vw / 2, vh / 2)
    ctx.scale(this.camera.zoom, this.camera.zoom)
    ctx.translate(-this.camera.x, -this.camera.y)

    if (this.terrain) ctx.drawImage(this.terrain, 0, 0)

    this.drawSpawns(ctx, game)
    for (const { e, full } of this.scopedPieces(game)) {
      this.drawPieceOverlay(ctx, game, occupied, e, full)
    }
    this.drawPieces(ctx, game)
    this.drawProjectiles(ctx, game)
    this.drawFx(ctx, game)
    ctx.restore()

    this.drawBorder(ctx, game)
  }

  /**
   * Pieces to annotate: the current selection (full detail) plus, when enabled,
   * the player's army and/or the enemy army (lighter detail).
   */
  private scopedPieces(game: Game): Array<{ e: Entity; full: boolean }> {
    const out = new Map<Entity, boolean>()
    for (const e of game.selected) {
      if (game.world.isAlive(e)) out.set(e, true)
    }
    if (game.overlays.myOrders || game.overlays.enemyPlans) {
      for (const e of game.world.query(Cell, Team)) {
        if (out.has(e)) continue
        const team = game.world.require(e, Team)
        const mine = team === game.playerTeam
        if ((mine && game.overlays.myOrders) || (!mine && game.overlays.enemyPlans)) out.set(e, false)
      }
    }
    return Array.from(out, ([e, full]) => ({ e, full }))
  }

  private drawSpawns(ctx: CanvasRenderingContext2D, game: Game): void {
    const t = game.board.tile
    for (const team of ['red', 'blue'] as const) {
      const s = game.board.data.spawns[team]
      ctx.fillStyle = team === 'red' ? 'rgba(255,107,90,0.05)' : 'rgba(90,176,255,0.05)'
      ctx.fillRect(s.x * t, s.y * t, s.w * t, s.h * t)
    }
  }

  /**
   * Overlay for one piece: nominal range arc, legal move cells (blue), attack
   * cells (red), path, destination and engagement line. `full` marks a selected
   * piece (brighter) versus an army-overview piece.
   */
  private drawPieceOverlay(
    ctx: CanvasRenderingContext2D,
    game: Game,
    occupied: (x: number, y: number) => boolean,
    e: Entity,
    full: boolean,
  ): void {
    const board = game.board
    const t = board.tile
    const cell = game.world.get(e, Cell)
    const kind = game.world.get(e, PieceType)?.kind
    const team = game.world.get(e, Team)
    const motion = game.world.get(e, Motion)
    const pos = game.world.get(e, Position)
    if (!cell || !kind || !team || !pos) return
    const def = PIECES[kind]
    if (!def) return
    const glow = full ? 1 : 0.55

    // Range arcs are subtle and scale with the weapon, so only show them for
    // selected pieces; army views rely on move/attack cells + paths.
    if (game.overlays.rangeArcs && full) this.drawRangeArc(ctx, board, cell, def, team, glow)

    // Reach/attack shading is detailed, so it is reserved for selected pieces;
    // army views show paths, goals and targets instead.
    if (game.overlays.moveCells && full) {
      const moves = moveDestinations(board, cell, def.move, team, occupied)
      ctx.fillStyle = `rgba(90,176,255,${0.18 * glow})`
      ctx.strokeStyle = `rgba(90,176,255,${0.32 * glow})`
      ctx.lineWidth = 1 / this.camera.zoom
      for (const c of moves) {
        ctx.fillRect(c.x * t + 3, c.y * t + 3, t - 6, t - 6)
        ctx.strokeRect(c.x * t + 3, c.y * t + 3, t - 6, t - 6)
      }
    }

    if (game.overlays.attackCells && full) {
      // Attacks are outlined (not filled) so they remain readable where they
      // coincide with the movement fill (rooks, bishops, queens).
      const fires = fireCells(board, cell, WEAPONS[def.weapon].geometry, team, occupied)
      ctx.strokeStyle = `rgba(255,90,70,${0.85 * glow})`
      ctx.lineWidth = 2 / this.camera.zoom
      for (const c of fires) ctx.strokeRect(c.x * t + 4, c.y * t + 4, t - 8, t - 8)
    }

    if (motion && motion.path.length > 0) {
      ctx.strokeStyle = full ? '#ffd166' : 'rgba(255,209,102,0.7)'
      ctx.lineWidth = (full ? 2 : 1.4) / this.camera.zoom
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

    const goal = motion?.goal ?? null
    if (goal) {
      const center = board.cellCenter(goal.x, goal.y)
      ctx.strokeStyle = motion?.blocked ? '#ff7b72' : '#ffd166'
      ctx.lineWidth = (full ? 2 : 1.4) / this.camera.zoom
      if (!motion || motion.path.length === 0) {
        ctx.setLineDash([3 / this.camera.zoom, 5 / this.camera.zoom])
        ctx.beginPath()
        ctx.moveTo(pos.x, pos.y)
        ctx.lineTo(center.x, center.y)
        ctx.stroke()
        ctx.setLineDash([])
      }
      ctx.beginPath()
      ctx.arc(center.x, center.y, t * 0.26, 0, Math.PI * 2)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(center.x - t * 0.16, center.y)
      ctx.lineTo(center.x + t * 0.16, center.y)
      ctx.moveTo(center.x, center.y - t * 0.16)
      ctx.lineTo(center.x, center.y + t * 0.16)
      ctx.stroke()
    }

    const target = game.world.get(e, Target)?.entity ?? null
    if (target === null || !game.world.isAlive(target)) return
    const tp = game.world.get(target, Position)
    if (!tp) return
    ctx.strokeStyle = `rgba(255,209,102,${full ? 0.6 : 0.35})`
    ctx.lineWidth = 1 / this.camera.zoom
    ctx.beginPath()
    ctx.moveTo(pos.x, pos.y)
    ctx.lineTo(tp.x, tp.y)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(tp.x, tp.y, t * 0.2, 0, Math.PI * 2)
    ctx.stroke()
  }

  /** Nominal weapon range: circle, pawn forward half-disc, knight 8 dots. */
  private drawRangeArc(
    ctx: CanvasRenderingContext2D,
    board: Game['board'],
    cell: { x: number; y: number },
    def: (typeof PIECES)[string],
    team: 'red' | 'blue',
    alpha: number,
  ): void {
    const t = board.tile
    const center = board.cellCenter(cell.x, cell.y)
    const weaponGeom = WEAPONS[def.weapon].geometry
    const fill = `rgba(255,255,255,${0.045 * alpha})`
    const stroke = `rgba(255,255,255,${0.22 * alpha})`
    ctx.fillStyle = fill
    ctx.strokeStyle = stroke
    ctx.lineWidth = 1.5 / this.camera.zoom
    ctx.setLineDash([4 / this.camera.zoom, 4 / this.camera.zoom])

    const range = weaponGeom.kind === 'slide' ? weaponGeom.range : 1
    const radius = Math.min(range, Math.max(board.width, board.height)) * t

    if (weaponGeom.kind === 'leap') {
      for (const [dx, dy] of weaponGeom.offsets) {
        if (!board.inBounds(cell.x + dx, cell.y + dy)) continue
        ctx.beginPath()
        ctx.arc(center.x + dx * t, center.y + dy * t, t * 0.15, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
      }
      ctx.setLineDash([])
      return
    }

    if (def.move.kind === 'pawn') {
      const resolved = resolveGeometry(def.move, team)
      const dy = resolved.kind === 'pawn' ? resolved.dy : -1
      const start = dy < 0 ? Math.PI : 0
      ctx.beginPath()
      ctx.moveTo(center.x, center.y)
      ctx.arc(center.x, center.y, range * t, start, start + Math.PI)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
      ctx.setLineDash([])
      return
    }

    const resolved = resolveGeometry(weaponGeom, team)
    if (resolved.kind === 'slide' && resolved.dirs.length < 8) {
      // Rook (ranks/files) and bishop (diagonals) get accurate directional
      // bands rather than a circle that implies unreachable diagonals.
      ctx.setLineDash([])
      ctx.lineCap = 'round'
      ctx.strokeStyle = fill
      ctx.lineWidth = t * 0.5
      for (const [dx, dy] of resolved.dirs) {
        ctx.beginPath()
        ctx.moveTo(center.x, center.y)
        ctx.lineTo(center.x + dx * resolved.range * t, center.y + dy * resolved.range * t)
        ctx.stroke()
      }
      ctx.lineCap = 'butt'
      return
    }

    ctx.beginPath()
    ctx.arc(center.x, center.y, radius, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.setLineDash([])
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
