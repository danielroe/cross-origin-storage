import type { NitroApp } from 'nitropack/types'
import { useRuntimeConfig } from '#imports'
import scriptContent, { headers } from 'virtual:cos-loader'
import { resolveBuildAssetsBase } from '../../utils/assets-base'

function entryModuleScriptRe(assetsBase: string): RegExp {
  // /<script\s(?=[^>]*(?<![\w-])type="module")(?=[^>]*(?<![\w-])src="\/_nuxt\/[^"]*")[^>]+><\/script>/g
  return new RegExp(
    `<script\\s(?=[^>]*(?<![\\w-])type="module")(?=[^>]*(?<![\\w-])src="${assetsBase}[^"]*")[^>]+><\\/script>`,
    'g',
  )
}

function nuxtPreloadLinkRe(assetsBase: string): RegExp {
  //  /<link\s(?=[^>]*(?<![\w-])rel="(?:modulepreload|prefetch)")(?=[^>]*(?<![\w-])href="\/_nuxt\/[^"]*")[^>]+>/gÒ
  return new RegExp(
    `<link\\s(?=[^>]*(?<![\\w-])rel="(?:modulepreload|prefetch)")(?=[^>]*(?<![\\w-])href="${assetsBase}[^"]*")[^>]+>`,
    'g',
  )
}

const importMapRe = /(<script\s[^>]*?(?<![\w-])type=")importmap(")/g

export default (nitroApp: NitroApp) => {
  nitroApp.hooks.hook('render:html', (ctx) => {
    const assetsBase = resolveBuildAssetsBase(useRuntimeConfig().app)
    const entryRe = entryModuleScriptRe(assetsBase)
    const preloadRe = nuxtPreloadLinkRe(assetsBase)

    ctx.head = ctx.head.map(chunk =>
      chunk.replace(entryRe, '').replace(preloadRe, '').replace(importMapRe, '$1cos-importmap$2'),
    )
    ctx.head.push(`<script id="cos-loader">${scriptContent}</script>`)
  })

  // The loader's writes are bounded by the headers of the page that runs it, so only rendered
  // pages need them. A header the app already sets, for example through `routeRules`, wins.
  nitroApp.hooks.hook('render:response', (response, { event }) => {
    if (!String(response.headers?.['content-type'] ?? '').startsWith('text/html')) {
      return
    }
    response.headers ??= {}
    for (const [name, value] of Object.entries(headers)) {
      if (!event.node.res.hasHeader(name) && response.headers[name.toLowerCase()] === undefined) {
        response.headers[name.toLowerCase()] = value
      }
    }
  })
}
