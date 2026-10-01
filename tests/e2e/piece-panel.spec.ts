import { expect, test } from '@playwright/test'
import { loadGame, settle } from './helpers'

test.beforeEach(async ({ page }) => {
  await loadGame(page)
})

test('the piece panel shows health % and two threshold notches with region hints', async ({ page }) => {
  await page.evaluate(() => {
    const g = (window as any).game
    const rook = g.toDebugJson().pieces.find((p: any) => p.team === 'blue' && p.kind === 'rook')
    g.selected = [rook.e]
  })

  const panel = page.locator('.piece-panel')
  await expect(panel).toBeVisible()
  // Percentage only, inline at the end of the health bar.
  await expect(panel.locator('.stat.health .num')).toContainText('%')
  // Two notches: the critical line and the retreat line.
  await expect(panel.locator('.bar .notch')).toHaveCount(2)
  // The old rules text block is gone.
  await expect(panel.locator('.collapsible')).toHaveCount(0)
  // Self-preservation reads as a passive, active rule beside the status pill.
  await expect(panel.locator('.status-pill.preserve.on')).toContainText('self-preservation')
  await expect(panel.locator('.status-pill.preserve.on')).toContainText('on')

  // Instant hover hints, one per bar region.
  await panel.locator('.bar .zone').nth(2).hover()
  await expect(panel.locator('.bar-tip')).toContainText('no automatic retreat')
  await panel.locator('.bar .zone').nth(1).hover()
  await expect(panel.locator('.bar-tip')).toContainText('pulls back')
  await panel.locator('.bar .zone').nth(0).hover()
  await expect(panel.locator('.bar-tip')).toContainText('critical')
})

test('pawns show no notches and a "never retreat" hint', async ({ page }) => {
  await page.evaluate(() => {
    const g = (window as any).game
    const pawn = g.toDebugJson().pieces.find((p: any) => p.team === 'blue' && p.kind === 'pawn')
    g.selected = [pawn.e]
  })

  const panel = page.locator('.piece-panel')
  await expect(panel.locator('.bar .notch')).toHaveCount(0)
  // Pawns never retreat, so they carry no self-preservation pill either.
  await expect(panel.locator('.status-pill.preserve')).toHaveCount(0)
  await panel.locator('.bar .zone').first().hover()
  await expect(panel.locator('.bar-tip')).toContainText('never retreat')
})

test('a force order flips the pill off and counts down to auto-restore', async ({ page }) => {
  await page.evaluate(() => {
    const g = (window as any).game
    const knight = g.toDebugJson().pieces.find((p: any) => p.team === 'blue' && p.kind === 'knight')
    g.selected = [knight.e]
    const orders = g.world.allStores.find((s: any) => s.name === 'Order')
    orders.map.get(knight.e).noPreserveUntil = g.turn + 3
  })
  await settle(page)

  const panel = page.locator('.piece-panel')
  await expect(panel.locator('.status-pill.preserve.off')).toContainText('off')
  // Paused on the turn the order was issued: two turns of suspension remain.
  await expect(panel.locator('.line.preserve-note')).toContainText('auto-restores in 2 turns')
})
