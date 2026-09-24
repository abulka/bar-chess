const DB_NAME = 'bar-chess'
const DB_VERSION = 1

export const SAVES_STORE = 'saves'
export const SAVE_INDEX_STORE = 'saveIndex'
export const MAPS_STORE = 'maps'

const STORES = [SAVES_STORE, SAVE_INDEX_STORE, MAPS_STORE]

let dbPromise: Promise<IDBDatabase> | null = null

function indexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined'
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!indexedDbAvailable()) {
      reject(new Error('indexedDB unavailable'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('could not open indexedDB'))
    request.onblocked = () => reject(new Error('indexedDB upgrade blocked'))
  })
}

/** Open (and cache) the shared database; a failed open can be retried. */
export function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = open().catch((error) => {
      dbPromise = null
      throw error
    })
  }
  return dbPromise
}

/** Run one request in its own transaction, resolving after the transaction commits. */
function withStore<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (objectStore: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode)
        let result: T
        let hasResult = false
        tx.oncomplete = () => resolve(hasResult ? result : (undefined as T))
        tx.onerror = () => reject(tx.error ?? new Error('indexedDB transaction failed'))
        tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'))
        try {
          const request = run(tx.objectStore(store))
          request.onsuccess = () => {
            result = request.result
            hasResult = true
          }
        } catch (error) {
          reject(error)
          tx.abort()
        }
      }),
  )
}

export function idbGet<T>(store: string, key: IDBValidKey): Promise<T | null> {
  return withStore<T | undefined>(store, 'readonly', (s) => s.get(key)).then((value) => value ?? null)
}

export function idbGetAll<T>(store: string): Promise<T[]> {
  return withStore<T[]>(store, 'readonly', (s) => s.getAll())
}

export function idbPut<T>(store: string, value: T): Promise<void> {
  return withStore(store, 'readwrite', (s) => s.put(value)).then(() => undefined)
}

export function idbDelete(store: string, key: IDBValidKey): Promise<void> {
  return withStore(store, 'readwrite', (s) => s.delete(key)).then(() => undefined)
}

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
