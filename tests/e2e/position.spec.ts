import { expect, test } from '@playwright/test'
import { loadGame } from './helpers'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await loadGame(page)
})

test('saves a named slot, survives reload, loads and deletes it', async ({ page }) => {
  await page.evaluate(() => (window as any).game.loadSize(16))
  await page.getByPlaceholder('slot name').fill('e2e position')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.locator('.slot-name')).toHaveText('e2e position')

  await page.evaluate(() => (window as any).game.loadSize(8))
  expect(await page.evaluate(() => (window as any).game.board.width)).toBe(8)

  page.on('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Load', exact: true }).click()
  expect(await page.evaluate(() => (window as any).game.board.width)).toBe(16)

  await page.reload()
  await page.waitForFunction(() => Boolean((window as any).game))
  await expect(page.locator('.slot-name')).toHaveText('e2e position')

  await page.getByRole('button', { name: 'Del', exact: true }).click()
  await expect(page.locator('.slot-name')).toHaveCount(0)
})

test('exports the position as a .json download', async ({ page }) => {
  const download = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export JSON' }).click(),
  ]).then(([d]) => d)
  expect(download.suggestedFilename()).toMatch(/^bar-chess-.*\.json$/)
})

test('imports a position from a JSON file', async ({ page }) => {
  const json = await page.evaluate(() => {
    const g = (window as any).game
    g.loadSize(16)
    const snapshot = g.exportPosition()
    g.loadSize(8)
    return JSON.stringify(snapshot)
  })
  expect(await page.evaluate(() => (window as any).game.board.width)).toBe(8)

  await page.setInputFiles('input[type=file]', {
    name: 'position.json',
    mimeType: 'application/json',
    buffer: Buffer.from(json),
  })

  await expect.poll(() => page.evaluate(() => (window as any).game.board.width)).toBe(16)
})

test('copies the shorthand and the LLM report', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.evaluate(() => (window as any).game.loadSize(8))

  await page.getByRole('button', { name: 'Copy shorthand' }).click()
  const shorthand = await page.evaluate(() => navigator.clipboard.readText())
  expect(shorthand).toContain('# board-8 8x8')
  expect(shorthand).toContain('# grid')
  expect(shorthand).toContain('# fmt:')

  await page.getByRole('button', { name: 'Copy for LLM' }).click()
  const llm = await page.evaluate(() => navigator.clipboard.readText())
  expect(llm).toContain('Bar Chess is a real-time')
  expect(llm).toContain('# board-8 8x8')
})

test('reports invalid imported JSON without breaking the game', async ({ page }) => {
  await page.setInputFiles('input[type=file]', {
    name: 'bad.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"version":999}'),
  })
  await expect(page.locator('.io-msg')).toContainText('unsupported position version')
})
