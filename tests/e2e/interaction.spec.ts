import { expect, test } from '@playwright/test'
import { cellScreenPoint, loadGame, settle } from './helpers'

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

test('overlay options persist across a page reload', async ({ page }) => {
  const read = () =>
    page.evaluate(() => {
      const o = (window as any).game.overlays
      return { rangeArcs: o.rangeArcs, myOrders: o.myOrders, reload: o.reload }
    })
  const before = await read()

  await page.locator('label.toggle').filter({ hasText: 'range' }).click()
  await page.locator('label.toggle').filter({ hasText: 'my orders' }).click()
  await page.locator('label.toggle').filter({ hasText: 'firing recharge' }).click()
  const toggled = await read()
  expect(toggled.rangeArcs).toBe(!before.rangeArcs)
  expect(toggled.myOrders).toBe(!before.myOrders)
  expect(toggled.reload).toBe(!before.reload)

  await page.reload()
  await page.waitForFunction(() => Boolean((window as any).game && (window as any).__renderer))
  expect(await read()).toEqual(toggled)
})

test('the tab hotkey toggles the side rails', async ({ page }) => {
  const rails = page.locator('aside.rail')
  await expect(rails).toHaveCount(2)

  await page.keyboard.press('Tab')
  await expect(rails).toHaveCount(0)

  await page.keyboard.press('Tab')
  await expect(rails).toHaveCount(2)
})

test('hiding the side rails keeps the current zoom', async ({ page }) => {
  const canvas = page.locator('canvas.board-canvas')
  const box = (await canvas.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, -480)
  const before = await page.evaluate(() => (window as any).__renderer.camera.zoom)

  await page.keyboard.press('Tab')
  await settle(page)
  const after = await page.evaluate(() => (window as any).__renderer.camera.zoom)

  expect(after).toBeCloseTo(before)
})

test('the step hotkey advances the simulation one tick', async ({ page }) => {
  const before = await page.evaluate(() => (window as any).game.tick)
  await page.keyboard.press('s')
  const after = await page.evaluate(() => (window as any).game.tick)
  expect(after).toBe(before + 1)
})

test('two quick space presses buffer the second turn', async ({ page }) => {
  await page.keyboard.press('Space')
  await page.keyboard.press('Space')

  const { active, queued } = await page.evaluate(() => {
    const g = (window as any).game
    return { active: g.turnActive as boolean, queued: g.queuedTurns as number }
  })
  expect(active).toBe(true)
  expect(queued).toBe(1)
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

test('right-click on an enemy issues an attack order (context-sensitive)', async ({ page }) => {
  const attacker = await page.evaluate(() => {
    const g = (window as any).game
    const rook = g.toDebugJson().pieces.find((p: any) => p.team === 'blue' && p.kind === 'rook')
    g.selected = [rook.e]
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

test('the HUD splitter resizes the bottom panel and persists', async ({ page }) => {
  await page.keyboard.press('h')
  const splitter = page.locator('.splitter')
  await expect(splitter).toBeVisible()

  const before = await page.locator('.bottom').evaluate((el) => el.clientHeight)
  const box = (await splitter.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y - 200, { steps: 5 })
  await page.mouse.up()

  const after = await page.locator('.bottom').evaluate((el) => el.clientHeight)
  expect(after).toBeGreaterThan(before + 100)

  await page.reload()
  await page.waitForFunction(() => Boolean((window as any).game && (window as any).__renderer))
  const restored = await page.locator('.bottom').evaluate((el) => el.clientHeight)
  expect(restored).toBeGreaterThan(before + 100)
})

