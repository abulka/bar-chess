import { expect, test } from '@playwright/test'
import { cellScreenPoint, loadGame } from './helpers'

test.beforeEach(async ({ page }) => {
  await loadGame(page)
})

test('drag box-selects the pieces it touches', async ({ page }) => {
  const canvas = page.locator('canvas.board-canvas')
  const box = (await canvas.boundingBox())!
  await page.mouse.move(box.x + 4, box.y + 4)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 4, box.y + box.height - 4, { steps: 8 })
  await page.mouse.up()

  const selected = await page.evaluate(() => (window as any).game.selected.length)
  expect(selected).toBe(32)
})

test('the step hotkey advances the simulation one tick', async ({ page }) => {
  const before = await page.evaluate(() => (window as any).game.tick)
  await page.keyboard.press('s')
  const after = await page.evaluate(() => (window as any).game.tick)
  expect(after).toBe(before + 1)
})

test('wheel zooms the camera in', async ({ page }) => {
  const canvas = page.locator('canvas.board-canvas')
  const box = (await canvas.boundingBox())!
  const before = await page.evaluate(() => (window as any).__renderer.camera.zoom)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, -240)
  const after = await page.evaluate(() => (window as any).__renderer.camera.zoom)
  expect(after).toBeGreaterThan(before)
})

test('a second right-click queues a move behind the active order', async ({ page }) => {
  const attacker = await page.evaluate(() => {
    const g = (window as any).game
    const rook = g.toDebugJson().pieces.find((p: any) => p.team === 'blue' && p.kind === 'rook')
    g.selected = [rook.e]
    g.orderMode = 'move'
    return rook.e as number
  })

  const canvas = page.locator('canvas.board-canvas')
  const box = (await canvas.boundingBox())!
  const first = await cellScreenPoint(page, { x: 0, y: 5 })
  await page.mouse.click(box.x + first.x, box.y + first.y, { button: 'right' })
  const second = await cellScreenPoint(page, { x: 0, y: 4 })
  await page.mouse.click(box.x + second.x, box.y + second.y, { button: 'right' })

  const state = await page.evaluate((e) => {
    const g = (window as any).game
    const store = g.world.allStores.find((s: any) => s.name === 'Order')
    const order = store.map.get(e)
    return { kind: order.kind, queue: order.queue.map((s: any) => s.kind) }
  }, attacker)

  expect(state.kind).toBe('goto')
  expect(state.queue).toEqual(['goto'])
})

test('right-click on an enemy issues an attack order in attack mode', async ({ page }) => {
  const attacker = await page.evaluate(() => {
    const g = (window as any).game
    const rook = g.toDebugJson().pieces.find((p: any) => p.team === 'blue' && p.kind === 'rook')
    g.selected = [rook.e]
    g.orderMode = 'attack'
    return rook.e as number
  })

  const targetCell = await page.evaluate(() => {
    const g = (window as any).game
    const piece = g.toDebugJson().pieces.find((p: any) => p.team === 'red' && p.kind === 'rook')
    return piece.cell as { x: number; y: number }
  })

  const canvas = page.locator('canvas.board-canvas')
  const box = (await canvas.boundingBox())!
  const point = await cellScreenPoint(page, targetCell)
  await page.mouse.click(box.x + point.x, box.y + point.y, { button: 'right' })

  const orderKind = await page.evaluate((e) => {
    const g = (window as any).game
    const store = g.world.allStores.find((s: any) => s.name === 'Order')
    return store.map.get(e).kind
  }, attacker)
  expect(orderKind).toBe('attack')
})
