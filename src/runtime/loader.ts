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
  /** Bare specifier of the entry chunk to import once the import map is ready. */
  entry: string
  /** Map of bare specifier to `{ file, hash }` for every managed chunk. */
  chunks: Record<string, { file: string, hash: string }>
}

export async function runCosLoader(manifest: CosManifest): Promise<void> {
  const cos = navigator.crossOriginStorage
  const imports: Record<string, string> = {}

  async function resolveChunk(hash: string, file: string): Promise<string> {
    if (cos) {
      try {
        const [handle] = await cos.requestFileHandles([{ algorithm: 'SHA-256', value: hash }])
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
    const blob = new Blob([await response.blob()], { type: 'text/javascript' })

    if (cos) {
      try {
        const [handle] = await cos.requestFileHandles([{ algorithm: 'SHA-256', value: hash }], { create: true })
        if (handle) {
          const writable = await handle.createWritable()
          await writable.write(blob)
          await writable.close()
        }
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

  const script = document.createElement('script')
  script.type = 'importmap'
  script.textContent = JSON.stringify({ imports })
  document.head.appendChild(script)

  await new Promise(resolve => setTimeout(resolve, 0))
  await import(/* @vite-ignore */ manifest.entry)
}
