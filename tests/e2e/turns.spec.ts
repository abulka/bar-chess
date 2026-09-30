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

test('space pauses a play burst instead of starting a turn', async ({ page }) => {
  await page.keyboard.press('Shift+Space')
  await expect.poll(() => page.evaluate(() => (window as any).game.snapshot().playing)).toBe(true)

  // Space during play pauses the mega turn; it must not start a normal turn.
  await page.keyboard.press('Space')
  await expect.poll(() => page.evaluate(() => (window as any).game.snapshot().playing)).toBe(false)
  expect(await page.evaluate(() => (window as any).game.snapshot().turnActive)).toBe(false)
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

/** Give a blue piece a move order while paused so `ordersTouched` becomes true. */
async function editOrders(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const g = (window as any).game
    const rook = g.toDebugJson().pieces.find((p: any) => p.team === 'blue' && p.kind === 'rook')
    g.selected = [rook.e]
    g.orderAt({ x: 0, y: 5 })
    g.selected = []
  })
}

test('changing orders while backtracked prompts to fork before space continues', async ({ page }) => {
  await playTurns(page, 2)
  await page.keyboard.press('u')
  await page.getByRole('button', { name: 'turns', exact: true }).click()

  await editOrders(page)
  await expect(page.locator('.turn-panel .order-changed')).toBeVisible()

  // Space no longer silently replays: it opens the fork prompt first.
  await page.keyboard.press('Space')
  const prompt = page.locator('.turn-panel .fork-confirm', { hasText: 'Orders changed here' })
  await expect(prompt).toBeVisible()
  expect(await page.evaluate(() => (window as any).game.snapshot().canRedo)).toBe(true)

  // Fork & continue discards the future and starts a fresh turn from here.
  await prompt.getByRole('button', { name: 'Fork & continue' }).click()
  await expect.poll(() => page.evaluate(() => (window as any).game.snapshot().canRedo)).toBe(false)
  await expect.poll(() => page.evaluate(() => (window as any).game.snapshot().turnActive)).toBe(true)
})

test('space answers the orders-changed prompt by forking and continuing', async ({ page }) => {
  await playTurns(page, 2)
  await page.keyboard.press('u')
  await page.getByRole('button', { name: 'turns', exact: true }).click()

  await editOrders(page)
  // Wait for the edit to reach the UI before pressing space.
  await expect(page.locator('.turn-panel .order-changed')).toBeVisible()
  // The first space opens the fork prompt instead of silently replaying.
  await page.keyboard.press('Space')
  await expect(
    page.locator('.turn-panel .fork-confirm', { hasText: 'Orders changed here' }),
  ).toBeVisible()

  // A second space takes the prompt's default: fork and continue.
  await page.keyboard.press('Space')
  await expect.poll(() => page.evaluate(() => (window as any).game.snapshot().canRedo)).toBe(false)
  await expect.poll(() => page.evaluate(() => (window as any).game.snapshot().turnActive)).toBe(true)
})

test('discarding changed orders replays the recorded beat forward', async ({ page }) => {
  await playTurns(page, 2)
  await page.keyboard.press('u')
  await page.getByRole('button', { name: 'turns', exact: true }).click()

  await editOrders(page)
  await expect(page.locator('.turn-panel .order-changed')).toBeVisible()

  await page.keyboard.press('Space')
  const prompt = page.locator('.turn-panel .fork-confirm', { hasText: 'Orders changed here' })
  await prompt.getByRole('button', { name: 'Discard changes' }).click()

  await expect.poll(() => page.evaluate(() => (window as any).game.snapshot().replaying)).toBe(true)
  await expect.poll(() => page.evaluate(() => (window as any).game.snapshot().replaying)).toBe(false)
  // It replayed the recorded beat forward and discarded the edits.
  const state = await page.evaluate(() => (window as any).game.snapshot())
  expect(state.historyIndex).toBe(state.historyLength - 1)
  expect(state.turnActive).toBe(false)
})

test('Restore orders reverts the edits in place and keeps the redo branch', async ({ page }) => {
  await playTurns(page, 2)
  await page.keyboard.press('u')
  await page.getByRole('button', { name: 'turns', exact: true }).click()

  await editOrders(page)
  const warning = page.locator('.turn-panel .order-changed')
  await expect(warning).toBeVisible()
  expect(await page.evaluate(() => (window as any).game.snapshot().canRedo)).toBe(true)

  await warning.getByRole('button', { name: 'Restore orders' }).click()

  // The edits are gone, but the cursor stays put so the future is still there.
  await expect(warning).toHaveCount(0)
  const state = await page.evaluate(() => (window as any).game.snapshot())
  expect(state.ordersTouched).toBe(false)
  expect(state.canRedo).toBe(true)
  expect(state.turnActive).toBe(false)
})

test('reveals the turns tab when a prompt needs attention', async ({ page }) => {
  await playTurns(page, 2)
  await page.keyboard.press('u')

  // View the games tab, then hide the rails so the prompt would be invisible.
  await page.getByRole('button', { name: 'games', exact: true }).click()
  await page.keyboard.press('Tab')
  await expect(page.locator('.rail-tabs')).toHaveCount(0)

  // Editing orders makes `ordersTouched` true: the app must reveal the rail and
  // switch to the turns tab so the "orders changed" warning is on screen.
  await editOrders(page)
  await expect(page.locator('.turn-panel .order-changed')).toBeVisible()
  await expect(page.getByRole('button', { name: 'turns', exact: true })).toHaveClass(/active/)

  // Space opens the blocking fork prompt on the same tab, so it can be answered.
  await page.keyboard.press('Space')
  await expect(
    page.locator('.turn-panel .fork-confirm', { hasText: 'Orders changed here' }),
  ).toBeVisible()
})
