import type { NitroApp } from 'nitropack/types'
import { useRuntimeConfig } from '#imports'
import scriptContent from 'virtual:cos-loader'
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

export default (nitroApp: NitroApp) => {
  nitroApp.hooks.hook('render:html', (ctx) => {
    const assetsBase = resolveBuildAssetsBase(useRuntimeConfig().app)
    const entryRe = entryModuleScriptRe(assetsBase)
    const preloadRe = nuxtPreloadLinkRe(assetsBase)

    ctx.head = ctx.head.map(chunk =>
      chunk.replace(entryRe, '').replace(preloadRe, ''),
    )
    ctx.head.push(`<script id="cos-loader">${scriptContent}</script>`)
  })
}
