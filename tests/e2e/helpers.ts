import type { Page } from '@playwright/test'

/** Minimal shape of the objects the app exposes on `window` in dev mode. */
interface DevWindow {
  game: {
    board: { tile: number }
    snapshot(): unknown
    toDebugJson(): { pieces: Array<{ e: number; team: string; kind: string; cell: { x: number; y: number } }> }
    world: { allStores: Array<{ name: string; map: Map<number, unknown> }> }
  }
  __renderer: { camera: { worldToScreen(x: number, y: number): { x: number; y: number } } }
}

export async function loadGame(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => {
    const w = window as unknown as Partial<DevWindow>
    return Boolean(w.game && w.__renderer)
  })
  await settle(page)
}

/** Wait for the renderer to draw once more. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )
}

/** Read the rendered canvas pixel at a world-space coordinate. */
export async function probeWorld(page: Page, x: number, y: number): Promise<number[]> {
  return page.evaluate(([wx, wy]) => {
    const w = window as unknown as DevWindow
    const canvas = document.querySelector('canvas.board-canvas') as HTMLCanvasElement
    const p = w.__renderer.camera.worldToScreen(wx, wy)
    const dpr = window.devicePixelRatio || 1
    const ctx = canvas.getContext('2d')!
    const d = ctx.getImageData(Math.round(p.x * dpr), Math.round(p.y * dpr), 1, 1).data
    return [d[0], d[1], d[2], d[3]]
  }, [x, y])
}

/** Canvas-relative screen position of a board cell centre. */
export async function cellScreenPoint(
  page: Page,
  cell: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  return page.evaluate((c) => {
    const w = window as unknown as DevWindow
    const tile = w.game.board.tile
    return w.__renderer.camera.worldToScreen((c.x + 0.5) * tile, (c.y + 0.5) * tile)
  }, cell)
}
