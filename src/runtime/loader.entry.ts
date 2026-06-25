import { runCosLoader } from './loader'
import type { CosManifest } from './loader'

declare const __COS_MANIFEST__: CosManifest

runCosLoader(__COS_MANIFEST__)
