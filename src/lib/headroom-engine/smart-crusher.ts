/*
 * Ported from: crates/headroom-core/src/transforms/smart_crusher/
 * Original: https://github.com/chopratejas/headroom (Apache-2.0)
 * Changes: Rust → TypeScript; serde_json → JSON.parse; BigInt for u64.
 */
import { computeOptimalK } from './adaptive-sizer.ts'

// ─── Error keywords (from error_keywords.rs) ───────────────────────────────
const ERROR_KEYWORDS = ['error','exception','failed','failure','critical','fatal','crash','panic','abort','timeout','denied','rejected']

// ─── Array type classification (from classifier.rs) ────────────────────────
export type ArrayType = 'dict_array' | 'string_array' | 'number_array' | 'bool_array' | 'nested_array' | 'mixed_array' | 'empty'

export function classifyArray(items: unknown[]): ArrayType {
  if (!items.length) return 'empty'
  let hasBool = false, hasNumber = false, hasString = false
  let hasObject = false, hasArray = false, hasNull = false
  for (const item of items) {
    if (item === null) { hasNull = true; continue }
    if (typeof item === 'boolean') { hasBool = true; continue }
    if (typeof item === 'number') { hasNumber = true; continue }
    if (typeof item === 'string') { hasString = true; continue }
    if (Array.isArray(item)) { hasArray = true; continue }
    if (typeof item === 'object') { hasObject = true }
  }
  if (hasBool && !hasNumber && !hasString && !hasObject && !hasArray && !hasNull) return 'bool_array'
  if (hasObject && !hasBool && !hasNumber && !hasString && !hasArray && !hasNull) return 'dict_array'
  if (hasString && !hasBool && !hasNumber && !hasObject && !hasArray && !hasNull) return 'string_array'
  if (hasNumber && !hasBool && !hasString && !hasObject && !hasArray && !hasNull) return 'number_array'
  if (hasArray && !hasBool && !hasNumber && !hasString && !hasObject && !hasNull) return 'nested_array'
  return 'mixed_array'
}

// ─── Config (from config.rs) ───────────────────────────────────────────────
export interface SmartCrusherConfig {
  maxItemsAfterCrush: number   // 0 = uncapped
  firstFraction: number        // default 0.3
  lastFraction: number         // default 0.3
  varianceThreshold: number    // default 2.0
}

export const DEFAULT_CONFIG: SmartCrusherConfig = {
  maxItemsAfterCrush: 0,
  firstFraction: 0.3,
  lastFraction: 0.3,
  varianceThreshold: 2.0,
}

// ─── k-split (from crushers.rs compute_k_split) ────────────────────────────
function bankersRound(x: number): number {
  const floor = Math.floor(x)
  const frac = x - floor
  if (Math.abs(frac - 0.5) > 1e-10) return Math.round(x)
  return floor % 2 === 0 ? floor : floor + 1
}

function computeKSplit(items: string[], config: SmartCrusherConfig, bias: number): [number, number, number, number] {
  const maxK = config.maxItemsAfterCrush > 0 ? config.maxItemsAfterCrush : undefined
  const kTotal = computeOptimalK(items, bias, 3, maxK)
  const kFirstRaw = Math.max(1, bankersRound(kTotal * config.firstFraction))
  const kLastRaw = Math.max(1, bankersRound(kTotal * config.lastFraction))
  const kFirst = Math.min(kFirstRaw, kTotal)
  const kLast = Math.min(kLastRaw, Math.max(0, kTotal - kFirst))
  const kImportance = Math.max(0, kTotal - kFirst - kLast)
  return [kTotal, kFirst, kLast, kImportance]
}

// ─── mean / sample stdev helpers ──────────────────────────────────────────
function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}
function sampleStdev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1))
}

// ─── crush_string_array (from crushers.rs) ────────────────────────────────
function crushStringArray(items: string[], config: SmartCrusherConfig, bias: number): { items: string[]; strategy: string } {
  const n = items.length
  if (n <= 8) return { items: [...items], strategy: 'string:passthrough' }

  const [kTotal, kFirst, kLast] = computeKSplit(items, config, bias)

  const errorIdx = new Set<number>()
  for (let i = 0; i < n; i++) {
    const lower = items[i].toLowerCase()
    if (ERROR_KEYWORDS.some(kw => lower.includes(kw))) errorIdx.add(i)
  }

  const lengths = items.map(s => s.length)
  const m = mean(lengths)
  const sd = sampleStdev(lengths)
  const anomalyIdx = new Set<number>()
  if (sd > 0) {
    const thr = config.varianceThreshold * sd
    for (let i = 0; i < n; i++) {
      if (Math.abs(lengths[i] - m) > thr) anomalyIdx.add(i)
    }
  }

  const keepIdx = new Set<number>([...errorIdx, ...anomalyIdx])
  for (let i = 0; i < Math.min(kFirst, n); i++) keepIdx.add(i)
  for (let i = Math.max(0, n - kLast); i < n; i++) keepIdx.add(i)

  const seen = new Set(Array.from(keepIdx).map(i => items[i]))
  const remaining = kTotal - keepIdx.size
  if (remaining > 0) {
    const cap = kTotal + errorIdx.size + anomalyIdx.size
    const stride = Math.max(1, Math.floor((n - 1) / (remaining + 1)))
    for (let i = 0; i < n && keepIdx.size < cap; i += stride) {
      if (!keepIdx.has(i) && !seen.has(items[i])) {
        keepIdx.add(i); seen.add(items[i])
      }
    }
  }

  const result = Array.from(keepIdx).sort((a, b) => a - b).map(i => items[i])
  return { items: result, strategy: `string:adaptive(${n}->${result.length})` }
}

// ─── crush_number_array ───────────────────────────────────────────────────
function crushNumberArray(items: number[], config: SmartCrusherConfig, bias: number): { items: number[]; strategy: string } {
  const n = items.length
  if (n <= 8) return { items: [...items], strategy: 'number:passthrough' }
  const strs = items.map(String)
  const [kTotal, kFirst, kLast] = computeKSplit(strs, config, bias)
  const keepIdx = new Set<number>()
  for (let i = 0; i < Math.min(kFirst, n); i++) keepIdx.add(i)
  for (let i = Math.max(0, n - kLast); i < n; i++) keepIdx.add(i)
  // Fill remaining with stride
  const remaining = kTotal - keepIdx.size
  if (remaining > 0) {
    const stride = Math.max(1, Math.floor(n / remaining))
    for (let i = 0; i < n && keepIdx.size < kTotal; i += stride) keepIdx.add(i)
  }
  const result = Array.from(keepIdx).sort((a, b) => a - b).map(i => items[i])
  return { items: result, strategy: `number:adaptive(${n}->${result.length})` }
}

// ─── crush_object (dict key capping) ─────────────────────────────────────
function crushObject(obj: Record<string, unknown>, config: SmartCrusherConfig): Record<string, unknown> {
  const keys = Object.keys(obj)
  if (keys.length <= 10) return obj
  // Score by key importance: error-adjacent keys, shorter values, etc.
  const scored = keys.map(k => {
    const vStr = JSON.stringify(obj[k]) ?? ''
    const isError = ERROR_KEYWORDS.some(kw => k.toLowerCase().includes(kw) || vStr.toLowerCase().includes(kw))
    return { k, score: (isError ? 100 : 0) + (vStr.length < 50 ? 1 : 0) }
  }).sort((a, b) => b.score - a.score)
  const maxK = config.maxItemsAfterCrush || 10
  const kept = scored.slice(0, maxK).map(x => x.k)
  const result: Record<string, unknown> = {}
  for (const k of kept) result[k] = obj[k]
  return result
}

// ─── crush_dict_array (main SmartCrusher path) ───────────────────────────
export interface SmartCrushResult {
  items: unknown[]
  strategy: string
  ccrHash: string | null
  droppedCount: number
}

export function crushDictArray(items: Record<string, unknown>[], config: SmartCrusherConfig, bias: number): SmartCrushResult {
  const n = items.length
  if (n <= 8) return { items: [...items], strategy: 'dict:passthrough', ccrHash: null, droppedCount: 0 }

  const strs = items.map(it => JSON.stringify(it))
  const [kTotal, kFirst, kLast, kImportance] = computeKSplit(strs, config, bias)

  // Always keep: items containing error keywords
  const errorIdx = new Set<number>()
  for (let i = 0; i < n; i++) {
    const lower = strs[i].toLowerCase()
    if (ERROR_KEYWORDS.some(kw => lower.includes(kw))) errorIdx.add(i)
  }

  const keepIdx = new Set<number>([...errorIdx])
  for (let i = 0; i < Math.min(kFirst, n); i++) keepIdx.add(i)
  for (let i = Math.max(0, n - kLast); i < n; i++) keepIdx.add(i)

  // Stride fill for importance budget
  if (kImportance > 0 && keepIdx.size < kTotal) {
    const stride = Math.max(1, Math.floor(n / kImportance))
    for (let i = kFirst; i < n - kLast && keepIdx.size < kTotal; i += stride) keepIdx.add(i)
  }

  const keptItems = Array.from(keepIdx).sort((a, b) => a - b).map(i => crushObject(items[i], config))
  const dropped = n - keptItems.length
  const ccrHash = dropped > 0 ? hashForCcr(strs.join('')) : null

  return {
    items: keptItems,
    strategy: `dict:adaptive(${n}->${keptItems.length},first=${kFirst},last=${kLast},imp=${kImportance})`,
    ccrHash,
    droppedCount: dropped,
  }
}

function hashForCcr(text: string): string {
  // Simple fast hash for CCR key (not crypto-secure, but fine for cache keys)
  let h = 0n
  for (let i = 0; i < Math.min(text.length, 2000); i++) {
    h = (h * 31n + BigInt(text.charCodeAt(i))) & 0xFFFFFFFFFFFFFFFFn
  }
  return h.toString(16).padStart(12, '0').slice(0, 12)
}

// ─── Top-level SmartCrusher ────────────────────────────────────────────────
export interface CrushResult {
  compressed: string
  strategy: string
  ccrHash: string | null
  droppedCount: number
}

export function smartCrush(jsonText: string, config = DEFAULT_CONFIG, bias = 1.0): CrushResult {
  let parsed: unknown
  try { parsed = JSON.parse(jsonText) } catch {
    return { compressed: jsonText, strategy: 'passthrough:parse_error', ccrHash: null, droppedCount: 0 }
  }

  // Find the top-level array to compress
  let arr: unknown[] | null = null
  let wrapper: Record<string, unknown> | null = null
  let wrapKey = ''

  if (Array.isArray(parsed)) {
    arr = parsed
  } else if (parsed && typeof parsed === 'object') {
    // Look for a data array key (common API pattern)
    const obj = parsed as Record<string, unknown>
    for (const key of Object.keys(obj)) {
      if (Array.isArray(obj[key]) && (obj[key] as unknown[]).length > 8) {
        arr = obj[key] as unknown[]
        wrapper = obj
        wrapKey = key
        break
      }
    }
  }

  if (!arr) {
    return { compressed: jsonText, strategy: 'passthrough:no_array', ccrHash: null, droppedCount: 0 }
  }

  const arrType = classifyArray(arr)
  let result: SmartCrushResult

  if (arrType === 'dict_array') {
    result = crushDictArray(arr as Record<string, unknown>[], config, bias)
  } else if (arrType === 'string_array') {
    const { items, strategy } = crushStringArray(arr as string[], config, bias)
    result = { items, strategy, ccrHash: items.length < arr.length ? hashForCcr(jsonText) : null, droppedCount: arr.length - items.length }
  } else if (arrType === 'number_array') {
    const { items, strategy } = crushNumberArray(arr as number[], config, bias)
    result = { items, strategy, ccrHash: null, droppedCount: arr.length - items.length }
  } else {
    return { compressed: jsonText, strategy: `passthrough:${arrType}`, ccrHash: null, droppedCount: 0 }
  }

  let output: unknown
  if (wrapper && wrapKey) {
    output = { ...wrapper, [wrapKey]: result.items }
    // Keep metadata keys but drop verbose pagination/meta if over budget
    const outObj = output as Record<string, unknown>
    if (result.droppedCount > 0) {
      outObj['_headroom'] = `${result.droppedCount} items offloaded` + (result.ccrHash ? ` <<ccr:${result.ccrHash}>>` : '')
    }
  } else {
    output = result.items
  }

  return {
    compressed: JSON.stringify(output, null, 2),
    strategy: result.strategy,
    ccrHash: result.ccrHash,
    droppedCount: result.droppedCount,
  }
}
