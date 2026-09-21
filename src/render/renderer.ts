import {
  Cell,
  Fx,
  Health,
  Motion,
  Order,
  PieceType,
  Position,
  Projectile,
  Render,
  Stance,
  Target,
  Team,
  Weapon,
} from '../ecs/components'
import type { Entity } from '../ecs/world'
import { buildOccupancy, makeOccupied } from '../game/occupancy'
import { containsCell, fireCells, moveDestinations } from '../game/geometry'
import { PIECES, WEAPONS } from '../game/pieces'
import { resolveGeometry } from '../game/types'
import { coordName, fileLabel } from '../game/coords'
import type { Game } from '../game/game'
import { Camera } from './camera'
import { bakeTerrain } from './terrain'

const STANCE_COLORS: Record<string, string> = {
  move: '#4ad991',
  attack: '#ff3b30',
}
const TRACK_COLOR = '#ff2d20'
const UNREACHABLE_COLOR = '#a0a6ac'
const REGROUP_COLOR = '#e3b341'

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
    const scoped = this.scopedPieces(game)
    for (const { e, full } of scoped) {
      this.drawPieceOverlay(ctx, game, occupied, e, full)
    }
    this.drawHoverGhosts(ctx, game)
    this.drawPieces(ctx, game, scoped)
    this.drawProjectiles(ctx, game)
    this.drawFx(ctx, game)
    this.drawHoverCursor(ctx, game)
    ctx.restore()

    this.drawBorder(ctx, game)
    this.drawCoords(ctx, game)
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
      ctx.fillStyle = team === 'red' ? 'rgba(255,159,67,0.05)' : 'rgba(90,176,255,0.05)'
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

    const order = game.world.get(e, Order)
    const autoTarget = game.world.get(e, Target)?.entity ?? null
    const target = order?.kind === 'attack' ? order.target : autoTarget

    // A gold route for goto/autonomous moves; attack orders draw their own red
    // route below so the two do not overlap.
    if (motion && motion.path.length > 0 && order?.kind !== 'attack') {
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

    // Suspended attack: an amber dashed chain to the parked target marks the
    // regroup, so it is clear the piece will re-engage once it is safe.
    if (order?.kind === 'goto' && order.resumeTarget !== null && game.world.isAlive(order.resumeTarget)) {
      const rp = game.world.get(order.resumeTarget, Position)
      if (rp) {
        ctx.strokeStyle = full ? REGROUP_COLOR : 'rgba(227,179,65,0.6)'
        ctx.lineWidth = (full ? 1.8 : 1.2) / this.camera.zoom
        ctx.setLineDash([3 / this.camera.zoom, 5 / this.camera.zoom])
        ctx.beginPath()
        ctx.moveTo(pos.x, pos.y)
        ctx.lineTo(rp.x, rp.y)
        ctx.stroke()
        ctx.setLineDash([])
      }
    }

    // Attack order: a gold dashed movement route to the firing position, then a
    // firing line to the victim — solid red when the shot is clear, solid red
    // up to a blocker + dashed red beyond it, or dashed grey when out of reach.
    if (order?.kind === 'attack' && target !== null && game.world.isAlive(target)) {
      const tp = game.world.get(target, Position)
      const tc = game.world.get(target, Cell)
      if (tp && tc) {
        const endCell = motion && motion.path.length > 0 ? motion.path[motion.path.length - 1] : cell
        const end = board.cellCenter(endCell.x, endCell.y)
        const weaponGeom = WEAPONS[def.weapon].geometry
        const reachable = order?.reachable ?? true
        const clearShot =
          reachable && containsCell(fireCells(board, endCell, weaponGeom, team, occupied), tc.x, tc.y)

        // Movement route (same gold "route" style as a move order), so it reads
        // separately from the red/grey firing line that follows it.
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

        const dash = [5 / this.camera.zoom, 4 / this.camera.zoom]
        const segment = (ax: number, ay: number, bx: number, by: number) => {
          ctx.beginPath()
          ctx.moveTo(ax, ay)
          ctx.lineTo(bx, by)
          ctx.stroke()
        }
        const lineColor = !reachable ? UNREACHABLE_COLOR : TRACK_COLOR
        ctx.strokeStyle = lineColor
        ctx.lineWidth = (full ? (clearShot ? 2.2 : 1.6) : 1.4) / this.camera.zoom

        if (!reachable) {
          ctx.setLineDash(dash)
          segment(end.x, end.y, tp.x, tp.y)
        } else if (clearShot) {
          ctx.setLineDash([])
          segment(end.x, end.y, tp.x, tp.y)
        } else {
          // Positionally reachable but blocked: solid red up to the first
          // blocker, dashed red from there to the victim.
          const dx = tc.x - endCell.x
          const dy = tc.y - endCell.y
          const straight = dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy)
          const steps = Math.max(Math.abs(dx), Math.abs(dy))
          const sx = Math.sign(dx)
          const sy = Math.sign(dy)
          let blocker: { x: number; y: number } | null = null
          if (straight && steps > 1) {
            for (let k = 1; k < steps; k++) {
              const x = endCell.x + sx * k
              const y = endCell.y + sy * k
              if (occupied(x, y) || board.blocksVision(x, y)) {
                blocker = { x, y }
                break
              }
            }
          }
          if (blocker) {
            const bp = board.cellCenter(blocker.x, blocker.y)
            ctx.setLineDash([])
            segment(end.x, end.y, bp.x, bp.y)
            ctx.setLineDash(dash)
            segment(bp.x, bp.y, tp.x, tp.y)
          } else {
            ctx.setLineDash(dash)
            segment(end.x, end.y, tp.x, tp.y)
          }
        }
        ctx.setLineDash([])

        const ang = Math.atan2(tp.y - end.y, tp.x - end.x)
        const ah = t * 0.2
        ctx.fillStyle = lineColor
        ctx.beginPath()
        ctx.moveTo(tp.x, tp.y)
        ctx.lineTo(tp.x - Math.cos(ang - 0.4) * ah, tp.y - Math.sin(ang - 0.4) * ah)
        ctx.lineTo(tp.x - Math.cos(ang + 0.4) * ah, tp.y - Math.sin(ang + 0.4) * ah)
        ctx.closePath()
        ctx.fill()
        ctx.strokeStyle = TRACK_COLOR
        ctx.lineWidth = (full ? 2.2 : 1.5) / this.camera.zoom
        ctx.beginPath()
        ctx.arc(tp.x, tp.y, t * 0.24, 0, Math.PI * 2)
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(tp.x - t * 0.33, tp.y)
        ctx.lineTo(tp.x + t * 0.33, tp.y)
        ctx.moveTo(tp.x, tp.y - t * 0.33)
        ctx.lineTo(tp.x, tp.y + t * 0.33)
        ctx.stroke()
      }
      return
    }

    const goal = motion?.goal ?? null
    if (goal) {
      const center = board.cellCenter(goal.x, goal.y)
      const partial = motion?.blocked || !(order?.kind === 'goto' && order.dest && order.dest.x === goal.x && order.dest.y === goal.y)
      ctx.strokeStyle = partial ? '#ffb347' : '#ffd166'
      ctx.lineWidth = (full ? 2 : 1.4) / this.camera.zoom
      // Connect the route to the objective whenever the path does not already
      // end there (empty path, or a best-effort partial route).
      const last = motion && motion.path.length > 0 ? motion.path[motion.path.length - 1] : null
      const reachesGoal = last !== null && last.x === goal.x && last.y === goal.y
      if (!reachesGoal) {
        const from = last ? board.cellCenter(last.x, last.y) : pos
        ctx.setLineDash([3 / this.camera.zoom, 5 / this.camera.zoom])
        ctx.beginPath()
        ctx.moveTo(from.x, from.y)
        ctx.lineTo(center.x, center.y)
        ctx.stroke()
      }
      if (partial) ctx.setLineDash([3 / this.camera.zoom, 3 / this.camera.zoom])
      ctx.beginPath()
      ctx.arc(center.x, center.y, t * 0.26, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.moveTo(center.x - t * 0.16, center.y)
      ctx.lineTo(center.x + t * 0.16, center.y)
      ctx.moveTo(center.x, center.y - t * 0.16)
      ctx.lineTo(center.x, center.y + t * 0.16)
      ctx.stroke()
    }

    if (autoTarget === null || !game.world.isAlive(autoTarget)) return
    const tp = game.world.get(autoTarget, Position)
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

  /** Faint per-piece destinations + paths for the current hovered order. */
  private drawHoverGhosts(ctx: CanvasRenderingContext2D, game: Game): void {
    if (game.hoverPreview.length === 0) return
    const board = game.board
    const t = board.tile
    for (const preview of game.hoverPreview) {
      const pos = game.world.get(preview.entity, Position)
      if (!pos) continue
      ctx.strokeStyle = preview.attack ? `${TRACK_COLOR}aa` : 'rgba(255,255,255,0.4)'
      ctx.lineWidth = 1.5 / this.camera.zoom
      ctx.setLineDash([4 / this.camera.zoom, 4 / this.camera.zoom])
      ctx.beginPath()
      ctx.moveTo(pos.x, pos.y)
      for (const c of preview.cells) {
        const center = board.cellCenter(c.x, c.y)
        ctx.lineTo(center.x, center.y)
      }
      if (preview.cells.length === 0 && preview.dest) {
        const center = board.cellCenter(preview.dest.x, preview.dest.y)
        ctx.lineTo(center.x, center.y)
      }
      ctx.stroke()
      ctx.setLineDash([])
      if (preview.dest) {
        const center = board.cellCenter(preview.dest.x, preview.dest.y)
        ctx.strokeStyle = preview.attack ? TRACK_COLOR : 'rgba(255,255,255,0.6)'
        ctx.beginPath()
        ctx.arc(center.x, center.y, t * 0.22, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
  }

  /** Hover outline + square name under the cursor. */
  private drawHoverCursor(ctx: CanvasRenderingContext2D, game: Game): void {
    const cell = game.hoverCell
    if (!cell || !game.board.inBounds(cell.x, cell.y)) return
    const t = game.board.tile
    const color =
      game.hoverAttackTarget !== null
        ? TRACK_COLOR
        : game.hoverPreview.length > 0
          ? 'rgba(255,255,255,0.7)'
          : 'rgba(255,255,255,0.3)'
    ctx.strokeStyle = color
    ctx.lineWidth = 2 / this.camera.zoom
    ctx.strokeRect(cell.x * t + 1, cell.y * t + 1, t - 2, t - 2)
    ctx.fillStyle = color
    ctx.font = `${t * 0.26}px ui-monospace, monospace`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillText(coordName(cell.x, cell.y, game.board.height), cell.x * t + t * 0.08, cell.y * t + t * 0.06)
  }

  /** Chess coordinates in the margin around the board (screen space). */
  private drawCoords(ctx: CanvasRenderingContext2D, game: Game): void {
    const board = game.board
    const tileScreen = board.tile * this.camera.zoom
    if (tileScreen < 11) return
    const topLeft = this.camera.worldToScreen(0, 0)
    const bottomRight = this.camera.worldToScreen(board.pixelWidth, board.pixelHeight)
    ctx.fillStyle = 'rgba(201,209,217,0.55)'
    ctx.font = `${Math.min(13, Math.max(9, tileScreen * 0.34))}px ui-monospace, monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (let x = 0; x < board.width; x++) {
      const sx = topLeft.x + (x + 0.5) * tileScreen
      if (sx < 6 || sx > this.camera.viewportWidth - 6) continue
      ctx.fillText(fileLabel(x), sx, bottomRight.y + 4)
    }
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    for (let y = 0; y < board.height; y++) {
      const sy = topLeft.y + (y + 0.5) * tileScreen
      if (sy < 10 || sy > this.camera.viewportHeight - 10) continue
      ctx.fillText(String(board.height - y), topLeft.x - 4, sy)
    }
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

  private drawPieces(
    ctx: CanvasRenderingContext2D,
    game: Game,
    scoped: Array<{ e: Entity; full: boolean }>,
  ): void {
    const t = game.board.tile
    const entities = game.world.query(Position, Render, Health, PieceType)
    const sorted = entities.slice().sort((a, b) => game.world.require(a, Position).y - game.world.require(b, Position).y)

    // Target rings follow the same scope as orders/overlays: only enemies being
    // tracked by a scoped piece's attack order get a ring.
    const targeted = new Set<Entity>()
    const regrouping = new Set<Entity>()
    for (const { e } of scoped) {
      const od = game.world.get(e, Order)
      if (od?.kind === 'attack' && od.target !== null) targeted.add(od.target)
      if (od?.kind === 'goto' && od.resumeTarget !== null) regrouping.add(od.resumeTarget)
    }

    for (const e of sorted) {
      const pos = game.world.require(e, Position)
      const render = game.world.require(e, Render)
      const health = game.world.require(e, Health)
      const size = render.size * t

      ctx.fillStyle = 'rgba(0,0,0,0.35)'
      ctx.beginPath()
      ctx.ellipse(pos.x, pos.y + size * 0.3, size * 0.4, size * 0.18, 0, 0, Math.PI * 2)
      ctx.fill()

      // Pieces have no default ring; a red ring marks a piece under attack order.
      if (targeted.has(e)) {
        ctx.strokeStyle = TRACK_COLOR
        ctx.lineWidth = 2.5 / this.camera.zoom
        ctx.beginPath()
        ctx.arc(pos.x, pos.y, size * 0.62, 0, Math.PI * 2)
        ctx.stroke()
      } else if (regrouping.has(e)) {
        ctx.strokeStyle = REGROUP_COLOR
        ctx.lineWidth = 2.2 / this.camera.zoom
        ctx.setLineDash([3 / this.camera.zoom, 3 / this.camera.zoom])
        ctx.beginPath()
        ctx.arc(pos.x, pos.y, size * 0.62, 0, Math.PI * 2)
        ctx.stroke()
        ctx.setLineDash([])
      }

      ctx.fillStyle = render.tint
      ctx.font = `${size * 0.92}px "Segoe UI Symbol", "Apple Symbols", serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(render.glyph, pos.x, pos.y + size * 0.04)

      // Two stacked bars: health (team-tinted) and weapon reload (cyan), so it
      // is always clear both how hurt a piece is and whether it can fire.
      // Thin, uniform bars anchored near the top of the square (tile-relative,
      // so big pieces don't push them outside the cell).
      const barW = t * 0.46
      const barH = Math.max(1, t * 0.035)
      const barY = pos.y - t * 0.4
      if (game.overlays.health) {
        const ratio = health.cur / health.max
        const fill = ratio > 0.5 ? '#5ad469' : ratio > 0.25 ? '#e3b341' : '#e8503a'
        this.drawBar(ctx, pos.x, barY, barW, barH, ratio, fill, render.tint)
      }
      const weapon = game.world.get(e, Weapon)
      const kind = game.world.get(e, PieceType)?.kind
      const def = kind ? PIECES[kind] : undefined
      if (weapon && def) {
        const cd = WEAPONS[def.weapon].cooldown
        if (cd > 0) {
          this.drawBar(ctx, pos.x, barY + barH + 1, barW, barH, 1 - weapon.left / cd, '#e0503a', 'rgba(140,40,25,0.9)')
        }
      }

      // Badge shows an active attack order (red A) or an explicit stance. A
      // piece with no stance and no order shows nothing, keeping the opening
      // board clean.
      const stance = game.world.get(e, Stance)?.mode ?? 'none'
      const order = game.world.get(e, Order)
      const attacking = order?.kind === 'attack'
      if (attacking || stance !== 'none') {
        const letter = attacking ? 'A' : stance[0].toUpperCase()
        const bx = pos.x + size * 0.34
        const by = pos.y + size * 0.36
        const br = size * 0.17
        ctx.fillStyle = attacking ? TRACK_COLOR : STANCE_COLORS[stance] ?? '#888'
        ctx.beginPath()
        ctx.arc(bx, by, br, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#0b0f16'
        ctx.font = `bold ${br * 1.5}px ui-monospace, monospace`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(letter, bx, by + br * 0.06)
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

  private drawBar(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    ratio: number,
    fill: string,
    stroke: string,
  ): void {
    const left = x - w / 2
    const r = Math.max(0, Math.min(1, ratio))
    ctx.fillStyle = 'rgba(0,0,0,0.6)'
    ctx.fillRect(left, y, w, h)
    ctx.fillStyle = fill
    ctx.fillRect(left, y, w * r, h)
    ctx.strokeStyle = stroke
    ctx.lineWidth = 1 / this.camera.zoom
    ctx.strokeRect(left, y, w, h)
  }

  private drawProjectiles(ctx: CanvasRenderingContext2D, game: Game): void {
    const t = game.board.tile
    for (const e of game.world.query(Projectile, Position)) {
      const pos = game.world.require(e, Position)
      const proj = game.world.require(e, Projectile)
      const r = proj.size * t
      const elapsed = proj.maxTtl - proj.ttl

      // Heading: toward the current waypoint, or toward the homing target.
      let heading = 0
      const wp = proj.waypoints[proj.waypointIndex]
      if (wp) {
        heading = Math.atan2(wp.y - pos.y, wp.x - pos.x)
      } else if (proj.target !== null) {
        const tp = game.world.get(proj.target, Position)
        if (tp) heading = Math.atan2(tp.y - pos.y, tp.x - pos.x)
      }

      if (proj.trajectory === 'jump' && proj.waypoints.length > 0) {
        ctx.strokeStyle = `${proj.color}44`
        ctx.lineWidth = 1 / this.camera.zoom
        ctx.setLineDash([4 / this.camera.zoom, 5 / this.camera.zoom])
        ctx.beginPath()
        ctx.moveTo(pos.x, pos.y)
        for (let i = proj.waypointIndex; i < proj.waypoints.length; i++) {
          ctx.lineTo(proj.waypoints[i].x, proj.waypoints[i].y)
        }
        ctx.stroke()
        ctx.setLineDash([])
      }

      ctx.fillStyle = proj.color
      if (proj.shape === 'lance') {
        ctx.strokeStyle = proj.color
        ctx.lineWidth = r
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(pos.x - Math.cos(heading) * r * 2.5, pos.y - Math.sin(heading) * r * 2.5)
        ctx.lineTo(pos.x + Math.cos(heading) * r * 2, pos.y + Math.sin(heading) * r * 2)
        ctx.stroke()
        ctx.lineCap = 'butt'
      } else if (proj.shape === 'bomb') {
        ctx.save()
        ctx.translate(pos.x, pos.y)
        ctx.rotate(proj.spin ? elapsed * 9 : heading)
        ctx.fillRect(-r, -r, r * 2, r * 2)
        ctx.restore()
      } else {
        ctx.beginPath()
        ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2)
        ctx.fill()
        if (proj.shape === 'shell') {
          ctx.globalAlpha = 0.35
          ctx.strokeStyle = proj.color
          ctx.lineWidth = 1 / this.camera.zoom
          ctx.beginPath()
          ctx.arc(pos.x, pos.y, r * 1.7, 0, Math.PI * 2)
          ctx.stroke()
          ctx.globalAlpha = 1
        }
      }
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
