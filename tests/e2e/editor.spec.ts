import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { cellScreenPoint, loadGame } from './helpers'

async function cellPoint(page: Page, cell: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const box = (await page.locator('canvas.board-canvas').boundingBox())!
  const p = await cellScreenPoint(page, cell)
  return { x: box.x + p.x, y: box.y + p.y }
}

test.beforeEach(async ({ page }) => {
  await loadGame(page)
})

test('click-places a piece in the editor and erases it', async ({ page }) => {
  await page.getByRole('button', { name: 'Editor', exact: true }).click()
  await expect(page.locator('.editor-panel')).toBeVisible()

  await page.locator('aside.roster.left .unit-card').filter({ hasText: 'Pawn' }).click()
  const point = await cellPoint(page, { x: 4, y: 4 })
  await page.mouse.click(point.x, point.y)
  await expect.poll(() => page.evaluate(() => (window as any).game.pieceAt(4, 4) !== null)).toBe(true)

  await page.getByRole('button', { name: 'Eraser', exact: true }).click()
  await page.mouse.click(point.x, point.y)
  await expect.poll(() => page.evaluate(() => (window as any).game.pieceAt(4, 4) !== null)).toBe(false)
})

test('drag from the roster places a piece on a square', async ({ page }) => {
  await page.getByRole('button', { name: 'Editor', exact: true }).click()
  const card = page.locator('aside.roster.left .unit-card').filter({ hasText: 'Knight' })
  const cardBox = (await card.boundingBox())!
  const target = await cellPoint(page, { x: 5, y: 5 })

  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x, target.y, { steps: 10 })
  await page.mouse.up()

  await expect.poll(() => page.evaluate(() => (window as any).game.pieceAt(5, 5) !== null)).toBe(true)
})

test('saves a map, shows a preview, and starts a game from it', async ({ page }) => {
  await page.getByRole('button', { name: 'Editor', exact: true }).click()
  await page.getByPlaceholder('map name').fill('e2e map')
  await page.getByRole('button', { name: 'Save map', exact: true }).click()
  await expect(page.locator('.map-toast')).toContainText('e2e map')

  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.locator('.editor-panel')).toHaveCount(0)

  await page.getByRole('button', { name: 'New from template…' }).click()
  await expect(page.locator('.maps-modal')).toBeVisible()
  await expect(page.locator('.map-card')).toHaveCount(1)
  await expect(page.locator('.map-thumb')).toBeVisible()

  await page.locator('.map-card').first().getByRole('button', { name: 'Play', exact: true }).click()
  await expect(page.locator('.maps-modal')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => (window as any).game.board.data.name)).toBe('e2e map')
})

test('undo steps back over an editor session', async ({ page }) => {
  await page.getByRole('button', { name: 'Editor', exact: true }).click()
  await page.locator('aside.roster.left .unit-card').filter({ hasText: 'Queen' }).click()
  const point = await cellPoint(page, { x: 4, y: 4 })
  await page.mouse.click(point.x, point.y)
  await page.getByRole('button', { name: 'Done', exact: true }).click()

  expect(await page.evaluate(() => (window as any).game.pieceAt(4, 4) !== null)).toBe(true)
  await page.getByRole('button', { name: /Undo/ }).click()
  await expect.poll(() => page.evaluate(() => (window as any).game.pieceAt(4, 4) !== null)).toBe(false)
})
