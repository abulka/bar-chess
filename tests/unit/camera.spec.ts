import { describe, expect, it } from 'vitest'
import { Camera } from '../../src/render/camera'

function fitted(): Camera {
  const cam = new Camera()
  cam.viewportWidth = 800
  cam.viewportHeight = 600
  cam.fit(800, 600)
  return cam
}

describe('Camera eased recenter', () => {
  it('arms a recenter target instead of snapping when the zoom floor is reached', () => {
    const cam = fitted()
    cam.zoom = cam.maxZoom
    cam.x = 100
    cam.y = 100
    cam.zoomAt(400, 300, 0.001)

    expect(cam.zoom).toBeCloseTo(cam.minZoom)
    // The position is not snapped in the same call as the zoom.
    expect(cam.x).not.toBeCloseTo(cam.worldW / 2)
  })

  it('eases to the top-aligned fit over frames and settles exactly', () => {
    const cam = fitted()
    cam.zoom = cam.maxZoom
    cam.x = 100
    cam.y = 100
    cam.zoomAt(400, 300, 0.001)

    const startX = cam.x
    cam.update(1 / 60)
    expect(cam.x).toBeGreaterThan(startX)
    expect(cam.x).toBeLessThan(cam.worldW / 2)

    for (let i = 0; i < 120; i++) cam.update(1 / 60)
    expect(cam.x).toBeCloseTo(cam.worldW / 2)
    // The board is top-aligned, so its top edge settles near the top of the
    // viewport rather than the board centre.
    const top = cam.worldToScreen(0, 0).y
    expect(top).toBeGreaterThanOrEqual(0)
    expect(top).toBeLessThan(10)
  })

  it('preserves a zoomed-in view when the viewport grows', () => {
    const cam = fitted()
    cam.zoom = 3
    cam.x = 123
    cam.y = 45
    cam.viewportWidth = 1200
    cam.viewportHeight = 900

    cam.updateLimits(800, 600)

    expect(cam.zoom).toBe(3)
    expect(cam.x).toBe(123)
    expect(cam.y).toBe(45)
  })

  it('re-fits to the new floor when already fully zoomed out', () => {
    const cam = fitted()
    expect(cam.zoom).toBeCloseTo(cam.minZoom)
    const oldFit = cam.fitZoom
    cam.viewportWidth = 1200
    cam.viewportHeight = 900

    cam.updateLimits(800, 600)

    // A fully zoomed-out camera follows the floor so the board fills the area.
    expect(cam.fitZoom).toBeGreaterThan(oldFit)
    expect(cam.zoom).toBeCloseTo(cam.fitZoom)
    expect(cam.x).toBeCloseTo(cam.worldW / 2)
  })

  it('cancels a pending recenter when the user pans', () => {
    const cam = fitted()
    cam.zoom = cam.maxZoom
    cam.x = 100
    cam.zoomAt(400, 300, 0.001)
    cam.panBy(50, 0)

    const x = cam.x
    cam.update(1 / 60)
    expect(cam.x).toBe(x)
  })
})
