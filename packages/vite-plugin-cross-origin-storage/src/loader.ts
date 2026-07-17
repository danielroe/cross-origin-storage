declare global {
  interface Navigator {
    crossOriginStorage?: {
      requestFileHandles: (
        descriptors: Array<{ algorithm: string, value: string }>,
        options?: { create?: boolean },
      ) => Promise<Array<{
        getFile: () => Promise<File>
        createWritable: () => Promise<{
          write: (data: Blob) => Promise<void>
          close: () => Promise<void>
        }>
      }>>
    }
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
  /** Map of content-addressed specifier to `{ file, hash }` for every COS-managed chunk. */
  chunks: Record<string, { file: string, hash: string }>
}

export async function runCosLoader(manifest: CosManifest): Promise<void> {
  const cos = navigator.crossOriginStorage
  const imports: Record<string, string> = {}

  let cosQueue: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const result = cosQueue.then(task, task)
    cosQueue = result.catch(() => {})
    return result
  }

  async function resolveChunk(hash: string, file: string): Promise<string> {
    if (cos) {
      try {
        const [handle] = await enqueue(() => cos.requestFileHandles([{ algorithm: 'SHA-256', value: hash }]))
        if (handle) {
          const blob = await handle.getFile()
          return URL.createObjectURL(new Blob([blob], { type: 'text/javascript' }))
        }
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
        await enqueue(async () => {
          const [handle] = await cos.requestFileHandles([{ algorithm: 'SHA-256', value: hash }], { create: true })
          if (handle) {
            const writable = await handle.createWritable()
            await writable.write(blob)
            await writable.close()
          }
        })
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
