import { expect, test } from '@playwright/test'
import { loadGame } from './helpers'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await loadGame(page)
})

test('study tab runs a batch on the live board and can be cancelled', async ({ page }) => {
  await page.getByRole('button', { name: 'Show HUD' }).click()
  await page.getByRole('button', { name: 'Study' }).click()

  await page.getByLabel('games').fill('2')
  await page.getByLabel('max turns').fill('4')

  await page.getByRole('button', { name: /Run \d+ games/ }).click()
  await expect(page.locator('.study-status')).toContainText('study in progress')

  await page.getByRole('button', { name: 'Cancel all' }).click()
  await expect(page.locator('.study-status')).toHaveCount(0)
})
