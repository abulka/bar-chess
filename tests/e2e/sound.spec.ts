import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { loadGame } from './helpers'

async function openSoundTab(page: Page): Promise<void> {
  await page.keyboard.press('h')
  await page.getByRole('button', { name: 'Sound' }).click()
}

async function openPawnSynth(page: Page): Promise<void> {
  await page.locator('summary:has-text("Pawn")').click()
  await page.locator('button[aria-label="edit synth shot.pawnShot"]').click()
  await expect(page.locator('.synth')).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await loadGame(page)
  await openSoundTab(page)
})

test('each layer has its own remove button and the loop toggles', async ({ page }) => {
  await openPawnSynth(page)
  await expect(page.locator('.synth .event-tab')).toHaveCount(1)

  await page.getByRole('button', { name: '+ tone' }).click()
  await expect(page.locator('.synth .event-tab')).toHaveCount(2)

  await page.locator('.synth .event-tab').first().locator('.event-tab-x').click()
  await expect(page.locator('.synth .event-tab')).toHaveCount(1)

  const loop = page.locator('.synth-actions input[type=checkbox]')
  await loop.check()
  await expect(loop).toBeChecked()
  await loop.uncheck()
  await expect(loop).not.toBeChecked()
})

test('edits persist as an override, show a badge, and survive reload', async ({ page }) => {
  await openPawnSynth(page)

  await page.evaluate(() => {
    const ta = document.querySelector('.synth textarea') as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(ta, JSON.stringify([{ type: 'square', from: 321, duration: 0.11, gain: 0.22 }], null, 2))
    ta.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await expect(page.locator('.synth .override-badge')).toHaveText('override loaded (saved)')

  await page.locator('.synth-head button:has-text("Close")').click()
  await expect(page.locator('.synth')).toHaveCount(0)
  await expect(page.locator('.override-bar b')).toHaveText('1')
  await expect(page.locator('code.cue-id.overridden.local')).toHaveCount(1)

  await page.reload()
  await page.waitForFunction(() => Boolean((window as any).game && (window as any).__renderer))
  await page.getByRole('button', { name: 'Sound' }).click()
  await openPawnSynth(page)

  await expect(page.locator('.synth .override-badge')).toHaveText('override loaded (saved)')
  await expect(page.locator('.synth .knob').first().locator('.knob-input')).toHaveValue('321')
})
