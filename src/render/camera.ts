import { clamp } from '../game/math'

export class Camera {
  x = 0
  y = 0
  zoom = 1
  minZoom = 0.15
  maxZoom = 4

  viewportWidth = 0
  viewportHeight = 0

  fit(worldW: number, worldH: number, padding = 40): void {
    if (this.viewportWidth === 0 || this.viewportHeight === 0) return
    const zoomX = (this.viewportWidth - padding) / worldW
    const zoomY = (this.viewportHeight - padding) / worldH
    this.zoom = clamp(Math.min(zoomX, zoomY), this.minZoom, this.maxZoom)
    this.x = worldW / 2
    this.y = worldH / 2
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
  }
}
