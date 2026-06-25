import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const COS_EXTENSION_REPO = 'https://github.com/web-ai-community/cross-origin-storage-extension'

/**
 * Clone the Cross-Origin Storage browser extension so the e2e suite can
 * exercise the real COS cache path. A failed clone is fatal: the COS test
 * must not silently skip just because setup couldn't fetch the extension.
 */
export default function setup(): void {
  const extensionDir = fileURLToPath(new URL('./.cos-extension', import.meta.url))
  if (existsSync(extensionDir)) {
    return
  }
  execSync(`git clone --depth 1 ${COS_EXTENSION_REPO} ${extensionDir}`, { stdio: 'inherit' })
}
