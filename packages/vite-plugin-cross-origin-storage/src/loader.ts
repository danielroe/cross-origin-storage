declare global {
  interface CrossOriginStorageRequestFileHandleHash {
    value: string
    algorithm: string
  }

  interface CrossOriginStorageRequestFileHandleOptions {
    create?: boolean
    origins?: string[] | string
  }

  interface CrossOriginStorageManager {
    requestFileHandle: (
      hash: CrossOriginStorageRequestFileHandleHash,
      options?: CrossOriginStorageRequestFileHandleOptions,
    ) => Promise<FileSystemFileHandle>
  }

  interface Navigator {
    readonly crossOriginStorage?: CrossOriginStorageManager
  }

  interface Window {
    /** The manifest the loader ran with, exposed for introspection (e.g. devtools, demo UIs). */
    __cosManifest?: CosManifest
  }
}

export interface CosManifest {
  /** Public base path that managed chunks are served from, e.g. `/_nuxt/`. */
  base: string
  /**
   * The entry chunk to import once the import map is ready. It is app-specific, so it is
   * loaded straight from the network rather than stored in COS by a content hash.
   */
  entry: { specifier: string, file: string }
  /**
   * Map of content-addressed specifier to `{ file, hash, name }` for every COS-managed chunk.
   * `name` is the npm package the chunk was bundled from (e.g. `vue`, `@vue/reactivity`), when
   * it could be derived from the resolved module path; absent for chunks it couldn't be.
   */
  chunks: Record<string, { file: string, hash: string, name?: string }>
}

export async function runCosLoader(manifest: CosManifest): Promise<void> {
  window.__cosManifest = manifest

  const cos = navigator.crossOriginStorage
  const imports: Record<string, string> = {}

  async function resolveChunk(hash: string, file: string): Promise<string> {
    if (cos) {
      try {
        const handle = await cos.requestFileHandle({ algorithm: 'SHA-256', value: hash })
        const blob = await handle.getFile()
        return URL.createObjectURL(new Blob([blob], { type: 'text/javascript' }))
      }
      catch (error) {
        if ((error as Error)?.name !== 'NotFoundError') {
          console.error('[cos] lookup failed', error)
        }
      }
    }

    const response = await fetch(file)
    if (!response.ok) {
      throw new Error(`[cos] failed to fetch chunk ${file}: ${response.status} ${response.statusText}`)
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType && !/javascript|ecmascript/i.test(contentType)) {
      throw new Error(`[cos] chunk ${file} served as ${contentType}, expected JavaScript`)
    }
    const blob = new Blob([await response.blob()], { type: 'text/javascript' })

    if (cos) {
      try {
        const handle = await cos.requestFileHandle({ algorithm: 'SHA-256', value: hash }, { create: true, origins: '*' })
        const writable = await handle.createWritable()
        await writable.write(blob)
        await writable.close()
      }
      catch (error) {
        console.error('[cos] store failed', error)
      }
    }

    return URL.createObjectURL(blob)
  }

  await Promise.all(
    Object.entries(manifest.chunks).map(async ([specifier, { file, hash }]) => {
      imports[specifier] = await resolveChunk(hash, manifest.base + file)
    }),
  )

  imports[manifest.entry.specifier] = new URL(manifest.base + manifest.entry.file, location.origin).href

  const script = document.createElement('script')
  script.type = 'importmap'
  script.textContent = JSON.stringify({ imports })
  document.head.appendChild(script)

  await new Promise(resolve => setTimeout(resolve, 0))
  await import(/* @vite-ignore */ manifest.entry.specifier)
}
