import { idbDelete, idbGet, idbGetAll, idbPut, MAPS_STORE, newId } from './idb'
import type { SavedMap } from './map'

/** Saved maps, newest first. */
export async function listMaps(): Promise<SavedMap[]> {
  try {
    const maps = await idbGetAll<SavedMap>(MAPS_STORE)
    return maps.sort((a, b) => b.savedAt - a.savedAt)
  } catch {
    return []
  }
}

export async function getMap(id: string): Promise<SavedMap | null> {
  try {
    return await idbGet<SavedMap>(MAPS_STORE, id)
  } catch {
    return null
  }
}

/** Persist a map, assigning an id and save time when missing. */
export async function saveMap(map: SavedMap): Promise<SavedMap> {
  const record: SavedMap = { ...map, id: map.id || newId(), savedAt: Date.now() }
  await idbPut<SavedMap>(MAPS_STORE, record)
  return record
}

export async function renameMap(id: string, name: string): Promise<SavedMap | null> {
  const map = await getMap(id)
  if (!map) return null
  const updated: SavedMap = { ...map, name: name.trim() || map.name, savedAt: Date.now() }
  await idbPut<SavedMap>(MAPS_STORE, updated)
  return updated
}

export async function deleteMap(id: string): Promise<void> {
  try {
    await idbDelete(MAPS_STORE, id)
  } catch {
    // Non-fatal.
  }
}
