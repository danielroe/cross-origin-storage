import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import type { Browser, BrowserContext } from 'playwright-core'

export const extensionDir = fileURLToPath(new URL('../.cos-extension', import.meta.url))

/**
 * The COS extension only loads in a full, headed Chrome for Testing build:
 * headless mode and the `chrome-headless-shell` binary both disable extensions,
 * and the system Chrome blocks `--load-extension`.
 */
function hasFullChromium(): boolean {
  try {
    const executable = chromium.executablePath()
    return existsSync(executable) && !executable.includes('headless-shell')
  }
  catch {
    return false
  }
}

/**
 * Whether the COS test may skip itself. A missing extension-capable browser is
 * fatal by default so CI cannot pass green without running the real COS path;
 * only an environment that explicitly cannot run a headed browser (e.g. a
 * sandbox, via `COS_SKIP_EXTENSION_TEST=1`) is allowed to skip.
 */
export function skipExtensionTest(): boolean {
  return process.env.COS_SKIP_EXTENSION_TEST === '1'
}

export function assertExtensionRunnable(): void {
  if (!existsSync(extensionDir)) {
    throw new Error(
      `COS extension missing at ${extensionDir}. Global setup should have cloned it; `
      + `run the suite via vitest so global-setup runs, or clone it manually.`,
    )
  }
  if (!hasFullChromium()) {
    throw new Error(
      'COS test requires a full Chrome for Testing build (extensions do not load in '
      + 'headless mode or chrome-headless-shell). Run `npx playwright-core install chromium`. '
      + 'Set COS_SKIP_EXTENSION_TEST=1 only in an environment that genuinely cannot run a headed browser.',
    )
  }
}

export async function launchPlainBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true })
}

export async function launchWithExtension(userDataDir: string): Promise<BrowserContext> {
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })
  // Give the extension's service worker time to register before navigating.
  await new Promise(resolve => setTimeout(resolve, 2000))
  return context
}
