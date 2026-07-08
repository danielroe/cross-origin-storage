export interface BuildAssetsAppConfig {
  baseURL?: string
  buildAssetsDir: string
  cdnURL?: string
}

export function resolveBuildAssetsBase(app: BuildAssetsAppConfig): string {
  const publicBase = app.cdnURL || app.baseURL || '/'
  if (publicBase.includes('://')) {
    const url = new URL(publicBase)
    url.pathname = app.buildAssetsDir
    return url.href
  }
  return app.buildAssetsDir
}
