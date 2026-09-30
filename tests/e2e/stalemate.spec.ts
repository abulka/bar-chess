import { expect, test } from '@playwright/test'
import { loadGame } from './helpers'

test.beforeEach(async ({ page }) => {
  await loadGame(page)
})

test('a both-kings-only standoff is declared a draw and freezes the controls', async ({ page }) => {
  await page.evaluate(() => {
    const g = (window as any).game
    g.clearPieces()
    g.placePiece('red', 'king', 4, 0)
    g.placePiece('blue', 'king', 4, 7)
    for (let t = 0; t < 4; t++) {
      g.queueTurn()
      let guard = 0
      while (g.turnActive && guard++ < 5000) g.runTicks(1)
    }
  })

  await expect.poll(() => page.evaluate(() => (window as any).game.drawn)).toBe(true)
  await expect(page.locator('.turnbar-label')).toContainText('draw')
  await expect(page.getByRole('button', { name: /Turn/ })).toBeDisabled()
  await expect(page.getByRole('button', { name: '⏭ Step' })).toBeDisabled()

  // Undo reopens the battle.
  await page.getByRole('button', { name: /Undo/ }).click()
  await expect.poll(() => page.evaluate(() => (window as any).game.drawn)).toBe(false)
  await expect(page.getByRole('button', { name: /Turn/ })).toBeEnabled()
})
