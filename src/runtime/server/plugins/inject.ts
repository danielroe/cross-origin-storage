import type { NitroApp } from 'nitropack/types'
import scriptContent from 'virtual:cos-loader'

export default (nitroApp: NitroApp) => {
  nitroApp.hooks.hook('render:html', (ctx) => {
    ctx.head = ctx.head.filter(tag => !tag.includes('<script type="module" src="/_nuxt'))
    ctx.head.push(`<script id="cos-loader">${scriptContent}</script>`)
  })
}
