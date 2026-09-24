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
import { fireCells, moveDestinations } from '../game/geometry'
import type { OccupiedFn } from '../game/geometry'
import { HEAL_COLOR, HEAL_RADIUS, healingTargets } from '../game/healing'
import { healthRatio, dist, vecEquals } from '../game/math'
import { PIECES, WEAPONS } from '../game/pieces'
import { queueMarkers } from '../game/queue'
import { resolveGeometry } from '../game/types'
import { coordName, fileLabel } from '../game/coords'
import { TEAM_IDS } from '../game/constants'
import type { Game } from '../game/game'
import { Camera } from './camera'
import { firingLine, routePolyline, type FiringLine, type FiringSegment } from './overlays'
import {
  BAR_BG,
  BAR_HIDE_THRESHOLD,
  ENGAGE_COLOR,
  POTSHOT_COLOR,
  PRESERVE_COLOR,
  RELOAD_FILL,
  RELOAD_MIN_COOLDOWN,
  ROUTE_COLOR,
  ROUTE_PARTIAL_COLOR,
  SELECT_COLOR,
  STANCE_ATTACK_COLOR,
  STANCE_MOVE_COLOR,
  TRACK_COLOR,
  UNREACHABLE_COLOR,
  healthColor,
} from './palette'
import { bakeTerrain } from './terrain'

const STANCE_COLORS: Record<string, string> = {
  move: STANCE_MOVE_COLOR,
  attack: STANCE_ATTACK_COLOR,
}

export class Renderer {
  camera = new Camera()
  time = 0

  private terrain: HTMLCanvasElement | null = null
  private terrainKey = ''
  private canvas: HTMLCanvasElement
  private worldW = 0
  private worldH = 0
  private lastFrameTime = 0

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
    const now = performance.now()
    const dt = this.lastFrameTime > 0 ? Math.min(0.05, (now - this.lastFrameTime) / 1000) : 1 / 60
    this.lastFrameTime = now
    this.time += dt
    this.camera.update(dt)
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
    this.drawBorder(ctx, game)

    this.drawSpawns(ctx, game)
    const scoped = this.scopedPieces(game)
    for (const { e, full } of scoped) {
      this.drawPieceOverlay(ctx, game, occupied, e, full)
    }
    this.drawHoverGhosts(ctx, game)
    if (game.overlays.healing) this.drawHealing(ctx, game)
    this.drawPieces(ctx, game, scoped)
    this.drawProjectiles(ctx, game)
    this.drawFx(ctx, game)
    this.drawHoverCursor(ctx, game, occupied)
    ctx.restore()

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
    for (const team of TEAM_IDS) {
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
    // selected pieces; army views rely on move/attack cells + paths. Clip to
    // the board so arcs never bleed into the surrounding margin.
    if (game.overlays.rangeArcs && full) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, 0, board.pixelWidth, board.pixelHeight)
      ctx.clip()
      this.drawRangeArc(ctx, board, cell, def, team, glow)
      ctx.restore()
    }

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

    // The queued remainder is drawn first, beneath the active order's route, so
    // the immediate plan always reads on top.
    if (order && order.queue.length > 0) this.drawQueuedRoute(ctx, game, e, pos, cell, full)

    // A gold route for goto/autonomous moves; a self-preservation retreat is
    // drawn in bright yellow so it reads as an automatic dodge, not an order.
    // Attack orders draw their own red route below so the two do not overlap.
    if (motion && motion.path.length > 0 && order?.kind !== 'attack') {
      const preserve = motion.intent === 'preserve'
      this.drawRoute(ctx, board, pos, motion.path, full, preserve ? PRESERVE_COLOR : undefined)
    }

    // Attack order: a gold dashed movement route to the firing position, then a
    // firing line to the victim — solid red when the shot is clear, solid red
    // up to a blocker + dashed red beyond it, or dashed grey when out of reach.
    if (order?.kind === 'attack' && target !== null && game.world.isAlive(target)) {
      const tp = game.world.get(target, Position)
      const tc = game.world.get(target, Cell)
      if (tp && tc) {
        // Preview the shot from the firing position only while the attack order
        // is actually being pursued. If self-preservation has overridden the goal
        // (`intent === 'preserve'`) the path leads to a retreat square, not a
        // firing position, so the line must come from where the piece stands now.
        const pursuing = motion?.intent === 'order'
        const endCell =
          pursuing && motion && motion.path.length > 0 ? motion.path[motion.path.length - 1] : cell
        const weaponGeom = WEAPONS[def.weapon].geometry
        const reachable = order?.reachable ?? true
        const line = firingLine(board, endCell, tc, weaponGeom, team, reachable, occupied)

        // Movement route (same gold "route" style as a move order), so it reads
        // separately from the red/grey firing line that follows it. When
        // self-preservation has overridden the attack the path is a retreat, so
        // it takes the bright-yellow preserve colour, not the order gold.
        if (motion && motion.path.length > 0) {
          const preserve = motion.intent === 'preserve'
          this.drawRoute(ctx, board, pos, motion.path, full, preserve ? PRESERVE_COLOR : undefined)
        }

        const dash = [5 / this.camera.zoom, 4 / this.camera.zoom]
        const lineColor = line.kind === 'unreachable' ? UNREACHABLE_COLOR : TRACK_COLOR
        ctx.strokeStyle = lineColor
        ctx.lineWidth = (full ? (line.clear ? 2.2 : 1.6) : 1.4) / this.camera.zoom
        this.strokeSegments(ctx, line.segments, (seg) => (seg.dashed ? dash : []))

        this.drawReticle(ctx, board, line, lineColor, TRACK_COLOR, full)
      }
      return
    }

    const goal = motion?.goal ?? null
    if (goal) {
      const center = board.cellCenter(goal.x, goal.y)
      const partial =
        motion?.blocked ||
        !(order?.kind === 'goto' && order.dest && vecEquals(order.dest, goal))
      ctx.strokeStyle =
        motion?.intent === 'preserve' ? PRESERVE_COLOR : partial ? ROUTE_PARTIAL_COLOR : ROUTE_COLOR
      ctx.lineWidth = (full ? 2 : 1.4) / this.camera.zoom
      // Connect the route to the objective whenever the path does not already
      // end there (empty path, or a best-effort partial route).
      const last = motion && motion.path.length > 0 ? motion.path[motion.path.length - 1] : null
      const reachesGoal = last !== null && vecEquals(last, goal)
      if (!reachesGoal) {
        const from = last ? board.cellCenter(last.x, last.y) : pos
        ctx.setLineDash([3 / this.camera.zoom, 5 / this.camera.zoom])
        ctx.beginPath()
        ctx.moveTo(from.x, from.y)
        ctx.lineTo(center.x, center.y)
        ctx.stroke()
      }
      if (partial) ctx.setLineDash([3 / this.camera.zoom, 3 / this.camera.zoom])
      // A hollow diamond marks the destination, so it can never be mistaken for
      // a target reticle (a circle + cross, red when ordered / amber when auto).
      const r = t * 0.28
      ctx.beginPath()
      ctx.moveTo(center.x, center.y - r)
      ctx.lineTo(center.x + r, center.y)
      ctx.lineTo(center.x, center.y + r)
      ctx.lineTo(center.x - r, center.y)
      ctx.closePath()
      ctx.stroke()
      ctx.setLineDash([])
    }

    // Auto-acquired / retaliation target. A committed piece (AI, or Attack
    // stance) will pursue it: an amber line + reticle reads as an engagement.
    // A stationary None/Move piece is only taking pot shots at whatever passes
    // in range and will not follow it, so it gets a muted grey dashed line with
    // no arrow or reticle — no lock-on feel.
    if (autoTarget === null || !game.world.isAlive(autoTarget)) return
    const tc = game.world.get(autoTarget, Cell)
    if (!tc) return
    const committed = this.committedTarget(game, e)
    // The target was acquired from the piece's current square, so the line shows
    // the shot it can take *now* — unless it is genuinely moving to a firing
    // position to pursue (`intent === 'engage'`), in which case preview it from
    // the path end. A pot shot / retreat / rally / defense never previews.
    const pursuing = motion?.intent === 'engage'
    const endCell =
      pursuing && motion && motion.path.length > 0 ? motion.path[motion.path.length - 1] : cell
    const autoLine = firingLine(board, endCell, tc, WEAPONS[def.weapon].geometry, team, true, occupied)
    const dash = [5 / this.camera.zoom, 4 / this.camera.zoom]
    ctx.strokeStyle = committed
      ? full
        ? ENGAGE_COLOR
        : 'rgba(227,179,65,0.6)'
      : full
        ? POTSHOT_COLOR
        : 'rgba(139,146,156,0.55)'
    ctx.lineWidth = (full ? 1.8 : 1.2) / this.camera.zoom
    // A pot shot always reads dashed: an incidental, uncommitted line.
    this.strokeSegments(ctx, autoLine.segments, (seg) =>
      committed ? (seg.dashed ? dash : []) : dash,
    )
    if (committed) this.drawReticle(ctx, board, autoLine, ENGAGE_COLOR, ENGAGE_COLOR, full)
  }

  /** Stroke each firing-line segment with a caller-chosen dash pattern. */
  private strokeSegments(
    ctx: CanvasRenderingContext2D,
    segments: readonly FiringSegment[],
    dashFor: (seg: FiringSegment) => number[],
  ): void {
    for (const seg of segments) {
      ctx.setLineDash(dashFor(seg))
      ctx.beginPath()
      ctx.moveTo(seg.from.x, seg.from.y)
      ctx.lineTo(seg.to.x, seg.to.y)
      ctx.stroke()
    }
    ctx.setLineDash([])
  }

  /**
   * Whether a piece is committed to pursuing its auto-acquired target: an AI
   * controller always is, and a human piece is when set to Attack stance. A
   * None/Move piece only fires in range and never follows the target.
   */
  private committedTarget(game: Game, e: Entity): boolean {
    const team = game.world.get(e, Team)
    if (!team) return false
    if (game.teams[team].controller === 'ai') return true
    return game.world.get(e, Stance)?.mode === 'attack'
  }

  /**
   * Direction arrow + reticle at the target end of a resolved firing line.
   * Shared by the red ordered indicator and the amber auto-acquired one; the
   * arrow follows `arrowColor` (grey when out of reach) while the ring uses
   * `ringColor`, so an unreachable ordered target keeps its red reticle.
   */
  private drawReticle(
    ctx: CanvasRenderingContext2D,
    board: Game['board'],
    line: FiringLine,
    arrowColor: string,
    ringColor: string,
    full: boolean,
  ): void {
    const t = board.tile
    const ang = Math.atan2(line.target.y - line.end.y, line.target.x - line.end.x)
    const ah = t * 0.2
    ctx.fillStyle = arrowColor
    ctx.beginPath()
    ctx.moveTo(line.target.x, line.target.y)
    ctx.lineTo(line.target.x - Math.cos(ang - 0.4) * ah, line.target.y - Math.sin(ang - 0.4) * ah)
    ctx.lineTo(line.target.x - Math.cos(ang + 0.4) * ah, line.target.y - Math.sin(ang + 0.4) * ah)
    ctx.closePath()
    ctx.fill()
    ctx.strokeStyle = ringColor
    ctx.lineWidth = (full ? 2.2 : 1.5) / this.camera.zoom
    ctx.beginPath()
    ctx.arc(line.target.x, line.target.y, t * 0.24, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(line.target.x - t * 0.33, line.target.y)
    ctx.lineTo(line.target.x + t * 0.33, line.target.y)
    ctx.moveTo(line.target.x, line.target.y - t * 0.33)
    ctx.lineTo(line.target.x, line.target.y + t * 0.33)
    ctx.stroke()
  }

  /** Gold dashed movement route from the piece to its planned path cells. */
  private drawRoute(
    ctx: CanvasRenderingContext2D,
    board: Game['board'],
    from: { x: number; y: number },
    path: readonly { x: number; y: number }[],
    full: boolean,
    color?: string,
  ): void {
    if (path.length === 0) return
    ctx.strokeStyle = color ?? (full ? ROUTE_COLOR : 'rgba(255,209,102,0.7)')
    ctx.lineWidth = (full ? 2 : 1.4) / this.camera.zoom
    ctx.setLineDash([5 / this.camera.zoom, 4 / this.camera.zoom])
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    for (const c of routePolyline(board, path)) ctx.lineTo(c.x, c.y)
    ctx.stroke()
    ctx.setLineDash([])
  }

  /**
   * The queued remainder of an order: a dim dashed chain through every planned
   * step, numbered waypoint markers, and a dashed threat line for queued attacks.
   */
  private drawQueuedRoute(
    ctx: CanvasRenderingContext2D,
    game: Game,
    e: Entity,
    pos: { x: number; y: number },
    cell: { x: number; y: number },
    full: boolean,
  ): void {
    const board = game.board
    const t = board.tile
    const order = game.world.get(e, Order)
    const motion = game.world.get(e, Motion)
    if (!order || order.queue.length === 0) return
    const dim = full ? 0.85 : 0.5
    const zoom = this.camera.zoom

    // Start the chain where the active route ends so it reads as one plan.
    let cursor = { x: pos.x, y: pos.y }
    if (order.kind === 'goto') {
      const end = motion && motion.path.length > 0 ? motion.path[motion.path.length - 1] : order.dest
      if (end) cursor = board.cellCenter(end.x, end.y)
    } else if (order.kind === 'attack') {
      const end = motion && motion.path.length > 0 ? motion.path[motion.path.length - 1] : cell
      cursor = board.cellCenter(end.x, end.y)
    }

    ctx.strokeStyle = `rgba(255,209,102,${0.55 * dim})`
    ctx.lineWidth = (full ? 1.6 : 1.2) / zoom
    ctx.setLineDash([4 / zoom, 5 / zoom])
    ctx.beginPath()
    ctx.moveTo(cursor.x, cursor.y)
    for (const step of order.queue) {
      for (const c of step.path) {
        const center = board.cellCenter(c.x, c.y)
        ctx.lineTo(center.x, center.y)
      }
    }
    ctx.stroke()
    ctx.setLineDash([])

    for (const marker of queueMarkers(order.queue)) {
      const center = board.cellCenter(marker.cell.x, marker.cell.y)
      const attacking = marker.kind === 'attack'
      if (attacking) {
        const step = order.queue[marker.index]
        if (step.kind === 'attack') {
          const tp = game.world.get(step.target, Position)
          if (tp) {
            ctx.strokeStyle = `rgba(255,59,48,${0.6 * dim})`
            ctx.lineWidth = 1.4 / zoom
            ctx.setLineDash([4 / zoom, 4 / zoom])
            ctx.beginPath()
            ctx.moveTo(center.x, center.y)
            ctx.lineTo(tp.x, tp.y)
            ctx.stroke()
            ctx.setLineDash([])
            ctx.beginPath()
            ctx.arc(tp.x, tp.y, t * 0.22, 0, Math.PI * 2)
            ctx.stroke()
          }
        }
      }
      ctx.fillStyle = attacking ? `rgba(255,59,48,${0.85 * dim})` : `rgba(255,209,102,${0.9 * dim})`
      ctx.beginPath()
      ctx.arc(center.x, center.y, t * 0.2, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#0b0f16'
      ctx.font = `bold ${t * 0.24}px ui-monospace, monospace`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(String(marker.index + 1), center.x, center.y)
    }
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
  private drawHoverCursor(ctx: CanvasRenderingContext2D, game: Game, occupied: OccupiedFn): void {
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
    ctx.font = `${t * 0.26}px ui-monospace, monospace`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    const label = coordName(cell.x, cell.y, game.board.height)
    const x = cell.x * t + t * 0.08
    const y = cell.y * t + t * 0.06
    // Only the occupied square gets a solid backing: it keeps the label legible
    // over a piece glyph, while empty squares stay unobscured.
    if (occupied(cell.x, cell.y)) {
      const padX = t * 0.05
      const padY = t * 0.04
      const boxW = ctx.measureText(label).width + padX * 2
      const boxH = t * 0.26 + padY * 2
      ctx.fillStyle = '#0b0f16'
      ctx.fillRect(x - padX, y - padY, boxW, boxH)
    }
    ctx.fillStyle = color
    ctx.fillText(label, x, y)
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

  /**
   * Nominal weapon range: directional bands for sliders, a forward half-disc
   * for pawns, and 8 dots for leaping knights. Sliders (rook, bishop, queen,
   * king) only ever reach cells along their dirs, so a circle would imply
   * unreachable cells (e.g. h3 from d1).
   */
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
    if (resolved.kind !== 'slide') return

    // Rook (ranks/files), bishop (diagonals) and queen/king (both) get accurate
    // directional bands. All rays go in one path so they composite once and the
    // shared centre does not stack into a bright blob.
    ctx.setLineDash([])
    ctx.lineCap = 'round'
    ctx.strokeStyle = fill
    ctx.lineWidth = t * 0.5
    ctx.beginPath()
    for (const [dx, dy] of resolved.dirs) {
      const steps = Math.min(resolved.range, this.stepsToEdge(board, cell, dx, dy))
      if (steps <= 0) continue
      ctx.moveTo(center.x, center.y)
      ctx.lineTo(center.x + dx * steps * t, center.y + dy * steps * t)
    }
    ctx.stroke()
    ctx.lineCap = 'butt'
  }

  /** Number of cells from `cell` along (dx, dy) before the ray leaves the board. */
  private stepsToEdge(board: Game['board'], cell: { x: number; y: number }, dx: number, dy: number): number {
    const maxX = dx > 0 ? board.width - 1 - cell.x : dx < 0 ? cell.x : board.width
    const maxY = dy > 0 ? board.height - 1 - cell.y : dy < 0 ? cell.y : board.height
    return Math.min(maxX, maxY)
  }

  private drawPieces(
    ctx: CanvasRenderingContext2D,
    game: Game,
    scoped: Array<{ e: Entity; full: boolean }>,
  ): void {
    const t = game.board.tile
    const entities = game.world.query(Position, Render, Health, PieceType)
    const sorted = entities.slice().sort((a, b) => game.world.require(a, Position).y - game.world.require(b, Position).y)

    // Target rings follow the same scope as orders/overlays: an explicit attack
    // order marks its victim red, while a *committed* auto-acquired target (AI or
    // Attack stance) marks it amber. A stationary pot shot rings nothing — it is
    // not pursuing the target, so it must not imply a lock-on.
    const targeted = new Set<Entity>()
    const autoTargeted = new Set<Entity>()
    for (const { e } of scoped) {
      const od = game.world.get(e, Order)
      if (od?.kind === 'attack' && od.target !== null) {
        targeted.add(od.target)
        continue
      }
      const auto = game.world.get(e, Target)?.entity ?? null
      if (auto !== null && game.world.isAlive(auto) && !targeted.has(auto) && this.committedTarget(game, e)) {
        autoTargeted.add(auto)
      }
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

      // Pieces have no default ring; a red ring marks a piece under attack order,
      // an amber ring an auto-acquired / retaliation target.
      if (targeted.has(e)) {
        ctx.strokeStyle = TRACK_COLOR
        ctx.lineWidth = 2.5 / this.camera.zoom
        ctx.beginPath()
        ctx.arc(pos.x, pos.y, size * 0.62, 0, Math.PI * 2)
        ctx.stroke()
      } else if (autoTargeted.has(e)) {
        ctx.strokeStyle = ENGAGE_COLOR
        ctx.lineWidth = 2.2 / this.camera.zoom
        ctx.beginPath()
        ctx.arc(pos.x, pos.y, size * 0.62, 0, Math.PI * 2)
        ctx.stroke()
      }

      ctx.fillStyle = render.tint
      ctx.font = `${size * 0.92}px "Segoe UI Symbol", "Apple Symbols", serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(render.glyph, pos.x, pos.y + size * 0.04)

      // Bars stack top-down, skipping any that are effectively full so a lone
      // recharge bar sits in the top slot instead of leaving a gap. Health is a
      // green->red fill (team-tinted outline), recharge a teal left-to-right
      // fill. Thin and tile-relative, so big pieces don't push them outside the
      // cell.
      const barW = t * 0.46
      const barH = Math.max(1, t * 0.035)
      const barY = pos.y - t * 0.4
      let barSlot = 0
      if (game.overlays.health) {
        const ratio = healthRatio(health, 0)
        if (ratio < BAR_HIDE_THRESHOLD) {
          this.drawBar(ctx, pos.x, barY, barW, barH, ratio, healthColor(ratio))
          barSlot++
        }
      }
      const weapon = game.world.get(e, Weapon)
      const kind = game.world.get(e, PieceType)?.kind
      const def = kind ? PIECES[kind] : undefined
      if (weapon && def && game.overlays.reload) {
        const cd = WEAPONS[def.weapon].cooldown
        const ratio = cd > 0 ? 1 - weapon.left / cd : 1
        // Like BAR, the bar only appears once the weapon has actually fired, so
        // a ready piece (including at the opening position) shows nothing.
        if (weapon.fired && cd >= RELOAD_MIN_COOLDOWN && ratio < BAR_HIDE_THRESHOLD) {
          this.drawBar(ctx, pos.x, barY + (barH + 1) * barSlot, barW, barH, ratio, RELOAD_FILL)
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
        ctx.strokeStyle = SELECT_COLOR
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
  ): void {
    const left = x - w / 2
    const r = Math.max(0, Math.min(1, ratio))
    // A fixed dark frame is always drawn full width; the coloured portion grows
    // inside it. No outline stroke — the frame itself is the container, as in BAR.
    ctx.fillStyle = BAR_BG
    ctx.fillRect(left, y, w, h)
    if (r > 0) {
      ctx.fillStyle = fill
      ctx.fillRect(left, y, w * r, h)
    }
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

  /**
   * King healing field: a pulsing green aura around each living king, a dashed
   * ring marking the exact two-square boundary, and wavy green tendrils to every
   * damaged piece actually gaining health inside it. Membership comes from the
   * shared `healingTargets`, so the overlay matches the mechanic exactly.
   */
  private drawHealing(ctx: CanvasRenderingContext2D, game: Game): void {
    const t = game.board.tile
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 3)
    for (const team of TEAM_IDS) {
      const field = healingTargets(game.world, team)
      if (!field) continue
      const kpos = game.world.get(field.king, Position)
      if (!kpos) continue
      const radius = (HEAL_RADIUS + 0.5) * t

      // Radial gradient so the aura glows at the king and fades at the edge.
      const gradient = ctx.createRadialGradient(kpos.x, kpos.y, t * 0.2, kpos.x, kpos.y, radius)
      gradient.addColorStop(0, `rgba(74,217,145,${0.2 + 0.12 * pulse})`)
      gradient.addColorStop(1, 'rgba(74,217,145,0)')
      ctx.fillStyle = gradient
      ctx.beginPath()
      ctx.arc(kpos.x, kpos.y, radius, 0, Math.PI * 2)
      ctx.fill()

      // Faint dashed ring at the exact two-square boundary.
      ctx.strokeStyle = `rgba(74,217,145,${0.2 + 0.14 * pulse})`
      ctx.lineWidth = 1.4 / this.camera.zoom
      ctx.setLineDash([4 / this.camera.zoom, 5 / this.camera.zoom])
      ctx.beginPath()
      ctx.arc(kpos.x, kpos.y, HEAL_RADIUS * t, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])

      let index = 0
      for (const e of field.targets) {
        const health = game.world.get(e, Health)
        if (!health || health.cur <= 0 || health.cur >= health.max) continue
        const pos = game.world.get(e, Position)
        if (!pos) continue
        this.drawHealingWave(ctx, kpos, pos, t * 0.18, this.time * 5 + index)
        index++
      }
    }
  }

  /** A sine wave from `from` to `to`, pinched at both ends, animated by `phase`. */
  private drawHealingWave(
    ctx: CanvasRenderingContext2D,
    from: { x: number; y: number },
    to: { x: number; y: number },
    amp: number,
    phase: number,
  ): void {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const len = dist(to.x, to.y, from.x, from.y) || 1
    const nx = -dy / len
    const ny = dx / len
    const segments = 24
    ctx.strokeStyle = HEAL_COLOR
    ctx.globalAlpha = 0.7
    ctx.lineWidth = 2 / this.camera.zoom
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    for (let i = 1; i <= segments; i++) {
      const s = i / segments
      const envelope = Math.sin(s * Math.PI)
      const offset = Math.sin(s * Math.PI * 4 - phase) * amp * envelope
      ctx.lineTo(from.x + dx * s + nx * offset, from.y + dy * s + ny * offset)
    }
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  private drawBorder(ctx: CanvasRenderingContext2D, game: Game): void {
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'
    ctx.lineWidth = 1 / this.camera.zoom
    ctx.strokeRect(0, 0, game.board.pixelWidth, game.board.pixelHeight)
  }
}
