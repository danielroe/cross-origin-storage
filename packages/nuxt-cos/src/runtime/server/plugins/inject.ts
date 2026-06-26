import type { NitroApp } from 'nitropack/types'
import scriptContent from 'virtual:cos-loader'

const ENTRY_MODULE_SCRIPT_RE = /<script\s(?=[^>]*(?<![\w-])type="module")(?=[^>]*(?<![\w-])src="\/_nuxt\/[^"]*")[^>]+><\/script>/g
const NUXT_PRELOAD_LINK_RE = /<link\s(?=[^>]*(?<![\w-])rel="(?:modulepreload|prefetch)")(?=[^>]*(?<![\w-])href="\/_nuxt\/[^"]*")[^>]+>/g

export default (nitroApp: NitroApp) => {
  nitroApp.hooks.hook('render:html', (ctx) => {
    ctx.head = ctx.head.map(chunk =>
      chunk
        .replace(ENTRY_MODULE_SCRIPT_RE, '')
        .replace(NUXT_PRELOAD_LINK_RE, ''),
    )
    ctx.head.push(`<script id="cos-loader">${scriptContent}</script>`)
  })
}
