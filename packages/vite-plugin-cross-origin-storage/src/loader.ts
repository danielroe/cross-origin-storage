/// <reference types="wicg-cross-origin-storage" />

declare global {
  interface Window {
    /** The manifest the loader ran with, exposed for introspection (e.g. devtools, demo UIs). */
    __cosManifest?: CosManifest
  }
}

export interface CosManifest {
  /** Public base path that managed chunks are served from, e.g. `/_nuxt/`. */
  base: string
  /** The build recipe the chunks were emitted with (`RECIPE`). */
  recipe: number
  /**
   * The entry chunk to import once the import map is ready. It is app-specific, so it is
   * loaded straight from the network rather than stored in COS by a content hash.
   */
  entry: { specifier: string, file: string }
  /**
   * Map of specifier to `{ file, hash, name, size }` for every COS-managed chunk. The specifier
   * is `cos1:<hash>`, or `cos1:<group hash>-<n>` for a module in an import cycle. `hash` is the
   * SHA-256 of the chunk's bytes and `size` their length. `name` is the npm package the chunk was
   * bundled from (e.g. `vue`, `@vue/reactivity`), when it could be derived from the resolved
   * module path; absent for chunks it couldn't be.
   */
  chunks: Record<string, { file: string, hash: string, name?: string, size: number }>
  /**
   * Map of content-addressed specifier to `{ file, hash, name }` for every file a managed chunk
   * references through `new URL(…, import.meta.url)`, such as a decoder's `.wasm`. The import map
   * points these at the network, so they load only when the app requests them.
   */
  assets?: Record<string, { file: string, hash: string, name?: string }>
}

/**
 * Lookups per load for chunks this site has not stored itself. Browsers may cap these per
 * top-level site, shared by every frame on the page, and report anything past the cap as missing.
 */
const CROSS_SITE_LOOKUPS = 8
const STORED_KEY = 'cos:stored'
const MAX_STORED = 2048

function readStored(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORED_KEY) ?? '[]')
    return Array.isArray(stored) ? stored : []
  }
  catch {
    return []
  }
}

function writeStored(hashes: Set<string>): void {
  try {
    const others = readStored().filter(hash => !hashes.has(hash))
    localStorage.setItem(STORED_KEY, JSON.stringify([...others, ...hashes].slice(-MAX_STORED)))
  }
  catch {
    // Storage is unavailable, e.g. in a sandboxed frame.
  }
}

function integrity(hash: string): string {
  const bytes = hash.match(/../g)!.map(byte => Number.parseInt(byte, 16))
  return `sha256-${btoa(String.fromCharCode(...bytes))}`
}

function readPageImports(): Record<string, string> {
  const imports: Record<string, string> = {}
  for (const script of document.querySelectorAll('script[type="cos-importmap"]')) {
    try {
      Object.assign(imports, JSON.parse(script.textContent || '{}').imports)
    }
    catch (error) {
      console.error('[cos] invalid import map', error)
    }
  }
  return imports
}

export async function runCosLoader(manifest: CosManifest): Promise<void> {
  window.__cosManifest = manifest

  let cos = typeof navigator.crossOriginStorage?.getFileHandle === 'function' ? navigator.crossOriginStorage : undefined
  let canStore = true
  const imports = readPageImports()

  const chunks = Object.values(manifest.chunks)
  const hashes = new Set(chunks.map(chunk => chunk.hash))
  const own = new Set(readStored().filter(hash => hashes.has(hash)))
  const lookups = new Set([
    ...own,
    ...chunks
      .filter(chunk => !own.has(chunk.hash))
      .sort((a, b) => b.size - a.size)
      .slice(0, CROSS_SITE_LOOKUPS)
      .map(chunk => chunk.hash),
  ])
  const stored = new Set<string>()
  const stores: Array<Promise<void>> = []

  let cosQueue: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(task: (cos: CrossOriginStorageManager) => Promise<T>): Promise<T | undefined> => {
    const run = (): Promise<T | undefined> => cos ? task(cos) : Promise.resolve(undefined)
    const result = cosQueue.then(run, run)
    cosQueue = result.catch(() => {})
    return result
  }

  const isBlocked = (error: unknown): boolean => {
    if ((error as Error)?.name !== 'NotAllowedError') {
      return false
    }
    cos = undefined
    return true
  }

  async function lookup(hash: string): Promise<Blob | undefined> {
    try {
      const handle = await enqueue(cos => cos.getFileHandle({ algorithm: 'SHA-256', value: hash }))
      return await handle?.getFile()
    }
    catch (error) {
      if ((error as Error)?.name !== 'NotFoundError' && !isBlocked(error)) {
        console.error('[cos] lookup failed', error)
      }
    }
  }

  async function store(hash: string, blob: Blob): Promise<void> {
    try {
      const written = await enqueue(async (cos) => {
        if (!canStore) {
          return false
        }
        const handle = await cos.getFileHandle({ algorithm: 'SHA-256', value: hash }, { create: true, origins: '*' })
        const writable = await handle.createWritable()
        await writable.write(blob)
        await writable.close()
        return true
      })
      if (written) {
        stored.add(hash)
      }
    }
    catch (error) {
      if ((error as Error)?.name === 'QuotaExceededError') {
        canStore = false
      }
      else if (!isBlocked(error)) {
        console.error('[cos] store failed', error)
      }
    }
  }

  async function resolveChunk(hash: string, file: string): Promise<string> {
    const hit = cos && lookups.has(hash) ? await lookup(hash) : undefined
    if (hit) {
      // Only a write records this site as a storing origin, which exempts its later lookups from
      // the cross-site cap.
      if (own.has(hash)) {
        stored.add(hash)
      }
      else {
        stores.push(store(hash, hit))
      }
      return URL.createObjectURL(new Blob([hit], { type: 'text/javascript' }))
    }

    const response = await fetch(file, { integrity: integrity(hash) })
    if (!response.ok) {
      throw new Error(`[cos] failed to fetch chunk ${file}: ${response.status} ${response.statusText}`)
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType && !/javascript|ecmascript/i.test(contentType)) {
      throw new Error(`[cos] chunk ${file} served as ${contentType}, expected JavaScript`)
    }
    const blob = new Blob([await response.blob()], { type: 'text/javascript' })
    if (cos) {
      stores.push(store(hash, blob))
    }
    return URL.createObjectURL(blob)
  }

  const urls = new Map<string, Promise<string>>()
  await Promise.all(
    Object.entries(manifest.chunks).map(async ([specifier, { file, hash }]) => {
      if (!urls.has(hash)) {
        urls.set(hash, resolveChunk(hash, manifest.base + file))
      }
      imports[specifier] = await urls.get(hash)!
    }),
  )

  imports[manifest.entry.specifier] = new URL(manifest.base + manifest.entry.file, document.baseURI).href
  for (const [specifier, { file }] of Object.entries(manifest.assets ?? {})) {
    imports[specifier] = new URL(manifest.base + file, document.baseURI).href
  }

  const script = document.createElement('script')
  script.type = 'importmap'
  script.textContent = JSON.stringify({ imports })
  document.head.appendChild(script)

  void Promise.all(stores).then(() => {
    if (stored.size) {
      writeStored(stored)
    }
  })

  await new Promise(resolve => setTimeout(resolve, 0))
  await import(/* @vite-ignore */ manifest.entry.specifier)
}
