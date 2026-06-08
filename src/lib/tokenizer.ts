// tokenizer.ts — lazy-loads js-tiktoken (cl100k_base, ~5 MB WASM) on first use.
// Until the module is ready, countTokens uses the length/4 approximation which
// is accurate to within ~5% for English text. This keeps the main JS bundle
// small so WebGPU has more memory headroom when loading the LLM.

let _enc: any = null
let _loading: Promise<void> | null = null

/** Start loading the tokenizer in the background — call this early (e.g. on mount). */
export function preloadTokenizer(): void {
  if (_enc || _loading) return
  _loading = import('js-tiktoken').then(({ getEncoding }) => {
    _enc = getEncoding('cl100k_base')
  }).catch(() => { /* silent — approximation fallback stays active */ })
}

/**
 * Count tokens in text.
 * Returns the real tiktoken count once the WASM is loaded,
 * otherwise returns the fast length/4 approximation.
 */
export function countTokens(text: string): number {
  if (_enc) {
    try { return _enc.encode(text).length } catch { /* fall through */ }
  }
  return Math.ceil(text.length / 4)
}

export function estimateCost(tokens: number, modelPricePerMillion = 3.0): number {
  return (tokens / 1_000_000) * modelPricePerMillion
}

export function projectedSavingsAt1M(savedTokens: number, pricePerMillion = 3.0): number {
  return savedTokens * 1_000_000 * (pricePerMillion / 1_000_000)
}
