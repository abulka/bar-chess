import { expect, test } from '@playwright/test'
import { loadGame } from './helpers'

async function playTurns(page: import('@playwright/test').Page, turns: number): Promise<void> {
  await page.evaluate((n) => {
    const g = (window as any).game
    for (let i = 0; i < n; i++) {
      g.beginTurn()
      let guard = 0
      while (g.turnActive && guard++ < 4000) g.runTicks(1)
    }
  }, turns)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await loadGame(page)
})

test('lists turns, jumps to one, and replays forward without forking', async ({ page }) => {
  await playTurns(page, 2)
  // The turn list lives in the left rail's "turns" tab (hidden by default).
  await page.getByRole('button', { name: 'turns', exact: true }).click()
  const rows = page.locator('.turn-panel .list .row')
  await expect(rows).toHaveCount(3)

  // Backtrack to the opening: the warning and fork button appear.
  await page.keyboard.press('u')
  await page.keyboard.press('u')
  await expect(page.locator('.turn-panel .hint')).toBeVisible()
  await expect(page.locator('.turn-panel .row.active .fork')).toBeVisible()
  expect(await page.evaluate(() => (window as any).game.snapshot().historyIndex)).toBe(0)

  // Space replays the next recorded beat forward, keeping the redo branch.
  await page.keyboard.press('Space')
  await expect.poll(() => page.evaluate(() => (window as any).game.snapshot().replaying)).toBe(true)
  await expect
    .poll(() => page.evaluate(() => (window as any).game.snapshot().replaying))
    .toBe(false)
  expect(await page.evaluate(() => (window as any).game.snapshot().canRedo)).toBe(true)

  // Clicking the newest row jumps straight to it.
  await rows.first().click()
  await expect.poll(() => page.evaluate(() => (window as any).game.snapshot().historyIndex)).toBe(2)
})

test('fork discards the redo branch without playing a turn', async ({ page }) => {
  await playTurns(page, 2)
  await page.keyboard.press('u')
  expect(await page.evaluate(() => (window as any).game.snapshot().canRedo)).toBe(true)

  // The fork button lives in the left rail's "turns" tab (hidden by default).
  await page.getByRole('button', { name: 'turns', exact: true }).click()
  // First click only arms the inline confirmation; the branch is still intact.
  await page.locator('.turn-panel .row.active .fork').click()
  await expect(page.locator('.turn-panel .fork-confirm')).toBeVisible()
  expect(await page.evaluate(() => (window as any).game.snapshot().canRedo)).toBe(true)

  // Confirming discards the future but does not start a turn.
  await page.locator('.turn-panel .fork-actions button', { hasText: 'Discard' }).click()
  await expect.poll(() => page.evaluate(() => (window as any).game.snapshot().canRedo)).toBe(false)
  expect(await page.evaluate(() => (window as any).game.snapshot().turnActive)).toBe(false)

  // Space now plays a normal turn from the boundary.
  await page.keyboard.press('Space')
  await expect.poll(() => page.evaluate(() => (window as any).game.snapshot().turnActive)).toBe(true)
})

test('keeps the backtrack hint pinned in view on a long turn list', async ({ page }) => {
  await playTurns(page, 14)
  await page.getByRole('button', { name: 'turns', exact: true }).click()
  // Backtrack so the hint appears; the active row scrolls near the top, leaving
  // the hint's natural position far below the fold.
  await page.keyboard.press('u')
  const foot = page.locator('.turn-panel .turn-foot')
  await expect(foot).toBeVisible()
  await expect(foot).toBeInViewport()
  await expect(page.locator('.turn-panel .hint')).toContainText('viewing turn')
})
