import { clamp } from '../game/math'

const FIT_PADDING = 24

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

  private computeFit(worldW: number, worldH: number): number | null {
    if (this.viewportWidth === 0 || this.viewportHeight === 0) return null
    const zoomX = (this.viewportWidth - FIT_PADDING) / worldW
    const zoomY = (this.viewportHeight - FIT_PADDING) / worldH
    return clamp(Math.min(zoomX, zoomY), 0.01, this.maxZoom)
  }

  /** Fit the whole board and set that as the zoom-out floor. */
  fit(worldW: number, worldH: number): void {
    this.worldW = worldW
    this.worldH = worldH
    const z = this.computeFit(worldW, worldH)
    if (z === null) return
    this.fitZoom = z
    this.minZoom = z
    this.zoom = z
    this.x = worldW / 2
    this.y = worldH / 2
  }

  /**
   * Recompute the fit floor after a viewport resize. The current zoom is only
   * raised if it would otherwise sit below the new floor (never zoomed out past
   * the board).
   */
  updateLimits(worldW: number, worldH: number): void {
    this.worldW = worldW
    this.worldH = worldH
    const z = this.computeFit(worldW, worldH)
    if (z === null) return
    this.fitZoom = z
    this.minZoom = z
    if (this.zoom < z) this.zoom = z
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
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.screenToWorld(sx, sy)
    this.zoom = clamp(this.zoom * factor, this.minZoom, this.maxZoom)
    const after = this.screenToWorld(sx, sy)
    this.x += before.x - after.x
    this.y += before.y - after.y
    // At the fully zoomed-out limit, snap back to centre so a panned board
    // always re-fits cleanly instead of drifting off to one side.
    if (this.zoom <= this.minZoom + 1e-6 && this.worldW > 0) {
      this.x = this.worldW / 2
      this.y = this.worldH / 2
    }
  }
}
