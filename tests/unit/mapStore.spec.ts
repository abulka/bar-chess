import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../../src/game/idb'
import { emptyMap } from '../../src/game/map'
import { deleteMap, getMap, listMaps, renameMap, saveMap } from '../../src/game/mapStore'

async function clearMaps(): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('maps', 'readwrite')
    tx.objectStore('maps').clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

describe('map store', () => {
  beforeEach(clearMaps)

  it('saves, lists, loads, renames and deletes maps', async () => {
    const saved = await saveMap(emptyMap(8, 'first'))
    expect(saved.id).toBeTruthy()

    const listed = await listMaps()
    expect(listed.map((m) => m.name)).toEqual(['first'])
    expect((await getMap(saved.id))?.board.width).toBe(8)

    const renamed = await renameMap(saved.id, 'renamed')
    expect(renamed?.name).toBe('renamed')
    expect((await getMap(saved.id))?.name).toBe('renamed')

    await deleteMap(saved.id)
    expect(await listMaps()).toEqual([])
    expect(await getMap(saved.id)).toBeNull()
  })

  it('keeps several maps and returns the newest first', async () => {
    const a = await saveMap(emptyMap(8, 'a'))
    const b = await saveMap(emptyMap(16, 'b'))
    const listed = await listMaps()
    expect(listed).toHaveLength(2)
    expect(listed.map((m) => m.id).sort()).toEqual([a.id, b.id].sort())
    expect(listed[0].savedAt).toBeGreaterThanOrEqual(listed[1].savedAt)
  })
})
