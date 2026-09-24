import { clamp, dist } from '../game/math'

/**
 * Total inset (both sides) left around the board when fitting. It must clear
 * the margin coordinate labels drawn outside the board edge (`drawCoords`:
 * up to ~13px font + offset), or they get clipped at full zoom-out.
 */
const FIT_PADDING = 44

export class Camera {
  x = 0
  y = 0
  zoom = 1
  /** smallest allowed zoom: the zoom at which the whole board fits the viewport */
  minZoom = 0.02
  maxZoom = 8
  fitZoom = 0.02

  viewportWidth = 0
  viewportHeight = 0
  worldW = 0
  worldH = 0

  /**
   * Pending board-centre target for the zoom-out floor. Instead of snapping
   * `x/y` the instant the floor is reached (a jarring jump), the camera eases
   * toward it in `update`; user input cancels it.
   */
  private recenter: { x: number; y: number } | null = null

  private computeFit(worldW: number, worldH: number): number | null {
    if (this.viewportWidth === 0 || this.viewportHeight === 0) return null
    const zoomX = (this.viewportWidth - FIT_PADDING) / worldW
    const zoomY = (this.viewportHeight - FIT_PADDING) / worldH
    return clamp(Math.min(zoomX, zoomY), 0.01, this.maxZoom)
  }

  /** Store the board size and recompute the fit floor; null when not sized yet. */
  private applyFit(worldW: number, worldH: number): number | null {
    this.worldW = worldW
    this.worldH = worldH
    const z = this.computeFit(worldW, worldH)
    if (z === null) return null
    this.fitZoom = z
    this.minZoom = z
    return z
  }

  /** Fit the whole board and set that as the zoom-out floor. */
  fit(worldW: number, worldH: number): void {
    const z = this.applyFit(worldW, worldH)
    if (z === null) return
    this.zoom = z
    this.x = worldW / 2
    this.y = worldH / 2
    this.recenter = null
  }

  /**
   * Recompute the fit floor after a viewport resize. The current zoom is only
   * raised if it would otherwise sit below the new floor (never zoomed out past
   * the board).
   */
  updateLimits(worldW: number, worldH: number): void {
    const z = this.applyFit(worldW, worldH)
    if (z === null) return
    if (this.zoom < z) this.zoom = z
    this.recenter = null
  }

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return {
      x: (wx - this.x) * this.zoom + this.viewportWidth / 2,
      y: (wy - this.y) * this.zoom + this.viewportHeight / 2,
    }
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return {
      x: (sx - this.viewportWidth / 2) / this.zoom + this.x,
      y: (sy - this.viewportHeight / 2) / this.zoom + this.y,
    }
  }

  panBy(dxScreen: number, dyScreen: number): void {
    this.x -= dxScreen / this.zoom
    this.y -= dyScreen / this.zoom
    this.recenter = null
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.screenToWorld(sx, sy)
    this.zoom = clamp(this.zoom * factor, this.minZoom, this.maxZoom)
    const after = this.screenToWorld(sx, sy)
    this.x += before.x - after.x
    this.y += before.y - after.y
    // At the fully zoomed-out limit, ease back to centre so a panned board
    // re-fits cleanly instead of drifting off to one side. The move is applied
    // by `update`, so the snap is a smooth glide rather than a jump; zooming
    // back in or panning cancels it.
    if (this.zoom <= this.minZoom + 1e-6 && this.worldW > 0) {
      this.recenter = { x: this.worldW / 2, y: this.worldH / 2 }
    } else {
      this.recenter = null
    }
  }

  /**
   * Ease a pending board-centre recenter toward its target. Called once per
   * rendered frame with the frame delta (seconds); exponential smoothing so the
   * motion is frame-rate independent.
   */
  update(dt: number): void {
    if (!this.recenter) return
    const target = this.recenter
    const k = 1 - Math.exp(-dt * 12)
    this.x += (target.x - this.x) * k
    this.y += (target.y - this.y) * k
    if (dist(target.x, target.y, this.x, this.y) < 0.25) {
      this.x = target.x
      this.y = target.y
      this.recenter = null
    }
  }
}
