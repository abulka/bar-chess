import { expect, test } from '@playwright/test'
import { loadGame, probeWorld, settle } from './helpers'

const isRed = (p: number[]) => p[0] > 120 && p[0] - p[1] > 40 && p[0] - p[2] > 40

test('a clear attack draws a solid red firing line between attacker and target', async ({ page }) => {
  await loadGame(page)

  await page.evaluate(() => {
    const g = (window as any).game
    const stores: Record<string, any> = Object.fromEntries(
      g.world.allStores.map((s: any) => [s.name, s]),
    )
    const dbg = g.toDebugJson()
    const rook = dbg.pieces.find((p: any) => p.team === 'blue' && p.kind === 'rook')
    const pawn = dbg.pieces.find((p: any) => p.team === 'red' && p.kind === 'pawn')

    const setCell = (e: number, x: number, y: number) => {
      const cell = stores.Cell.map.get(e)
      cell.x = x
      cell.y = y
      const pos = stores.Position.map.get(e)
      const centre = g.board.cellCenter(x, y)
      pos.x = centre.x
      pos.y = centre.y
    }
    setCell(rook.e, 3, 4)
    setCell(pawn.e, 3, 5)

    g.selected = [rook.e]
    g.orderAt({ x: 3, y: 5 })
  })

  await settle(page)

  const tile = await page.evaluate(() => (window as any).game.board.tile)
  const onLine = await probeWorld(page, 3.5 * tile, 5.0 * tile)
  const offLine = await probeWorld(page, 1.5 * tile, 3.5 * tile)

  expect(isRed(onLine), `pixel on the firing line was ${onLine}`).toBe(true)
  expect(isRed(offLine), `pixel off the firing line was ${offLine}`).toBe(false)
})
