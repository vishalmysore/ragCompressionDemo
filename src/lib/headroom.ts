/**
 * Compression integration module.
 * All compression runs client-side via the ported algorithms in headroom-engine/.
 * No external SDK or proxy required.
 */
import { compressContent, type SimResult } from './headroom-engine/index.ts'
import type { SimConfig } from './compression-sim.ts'

export interface HeadroomConfig extends SimConfig {
  proxyUrl?: string  // reserved for future use — not currently active
}

export interface CompressPayload {
  content: string
  config: HeadroomConfig
  query?: string
}

export interface CompressOutput extends SimResult {
  mode: 'local'
  ttfMs: number
}

export async function runCompress(payload: CompressPayload): Promise<CompressOutput> {
  const t0 = performance.now()
  const result = compressContent(payload.content, payload.config, payload.query ?? '')
  return { ...result, mode: 'local', ttfMs: performance.now() - t0 }
}
