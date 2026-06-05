/*
 * Ported from: crates/headroom-core/src/transforms/adaptive_sizer.rs
 * Original: https://github.com/chopratejas/headroom (Apache-2.0)
 * Changes: Rust → TypeScript; flate2 → pako; MD5 via spark-md5; BigInt for u64.
 */
import SparkMD5 from 'spark-md5'
import { deflate } from 'pako'

// ─── SimHash ───────────────────────────────────────────────────────────────

// Cap input length for simhash — beyond ~150 chars the fingerprint is
// already saturated. This keeps the algorithm correct while avoiding
// tens of thousands of MD5 calls on large serialized JSON objects.
const SIMHASH_INPUT_CAP = 150

/**
 * 64-bit SimHash fingerprint.
 * Port of `_simhash` (adaptive_sizer.py). Uses character 4-grams, MD5,
 * bit-voting. Returns a BigInt representing the 64-bit fingerprint.
 */
export function simhash(text: string): bigint {
  const lower = text.toLowerCase().slice(0, SIMHASH_INPUT_CAP)
  const chars = [...lower] // codepoint-correct split (matches Rust's char iteration)
  const n = chars.length
  const iterCount = n <= 3 ? 1 : n - 3
  const votes = new Int32Array(64)

  for (let i = 0; i < iterCount; i++) {
    const gram = chars.slice(i, i + 4).join('')
    const hex = SparkMD5.hash(gram) // 32 hex chars = 16 bytes
    // Take first 16 hex chars (8 bytes) as big-endian u64
    const hi = parseInt(hex.slice(0, 8), 16)
    const lo = parseInt(hex.slice(8, 16), 16)
    const h = (BigInt(hi) << 32n) | BigInt(lo)
    for (let j = 0; j < 64; j++) {
      if ((h >> BigInt(j)) & 1n) votes[j]++
      else votes[j]--
    }
  }

  let fp = 0n
  for (let j = 0; j < 64; j++) {
    if (votes[j] > 0) fp |= (1n << BigInt(j))
  }
  return fp
}

export function hammingDistance(a: bigint, b: bigint): number {
  let diff = a ^ b
  let count = 0
  while (diff) { if (diff & 1n) count++; diff >>= 1n }
  return count
}

/**
 * Count distinct items via SimHash greedy clustering.
 * Port of `count_unique_simhash` (adaptive_sizer.py).
 * For large arrays (>50 items), samples every 3rd item to stay fast
 * while preserving statistical accuracy.
 */
export function countUniqueSimhash(items: string[], threshold = 3): number {
  if (!items.length) return 0
  // Sample for large arrays — still statistically representative
  const sample = items.length > 50
    ? items.filter((_, i) => i % 3 === 0)
    : items
  const fingerprints = sample.map(simhash)
  const clusters: bigint[] = []
  for (const fp of fingerprints) {
    if (!clusters.some(rep => hammingDistance(fp, rep) <= threshold)) {
      clusters.push(fp)
    }
  }
  // Scale unique count back to full array size
  return items.length > 50
    ? Math.round(clusters.length * (items.length / sample.length))
    : clusters.length
}

// ─── Bigram coverage curve ─────────────────────────────────────────────────

/**
 * Cumulative unique word-bigram coverage curve.
 * Port of `compute_unique_bigram_curve` (adaptive_sizer.py).
 */
export function computeUniqueBigramCurve(items: string[]): number[] {
  const seen = new Set<string>()
  const curve: number[] = []
  for (const item of items) {
    const words = item.toLowerCase().slice(0, 200).split(/\s+/).filter(Boolean)
    if (words.length < 2) {
      seen.add(`${words[0] ?? ''}\x00`)
    } else {
      for (let j = 0; j < words.length - 1; j++) {
        seen.add(`${words[j]}\x00${words[j + 1]}`)
      }
    }
    curve.push(seen.size)
  }
  return curve
}

// ─── Kneedle ───────────────────────────────────────────────────────────────

/**
 * Find the knee in a monotonically-increasing curve (Kneedle algorithm).
 * Port of `find_knee` (adaptive_sizer.py). Returns 1-indexed count.
 */
export function findKnee(curve: number[]): number | null {
  const n = curve.length
  if (n < 3) return null
  const yMin = curve[0]
  const yMax = curve[n - 1]
  if (Math.abs(yMax - yMin) < Number.EPSILON) return 1 // flat curve

  const xRange = n - 1
  const yRange = yMax - yMin
  let maxDiff = -1
  let kneeIdx: number | null = null

  for (let i = 0; i < n; i++) {
    const xNorm = i / xRange
    const yNorm = (curve[i] - yMin) / yRange
    const diff = yNorm - xNorm
    if (diff > maxDiff) { maxDiff = diff; kneeIdx = i }
  }

  if (maxDiff < 0.05) return null
  return kneeIdx! + 1
}

// ─── zlib validation ───────────────────────────────────────────────────────

function zlibLen(text: string): number {
  return deflate(text, { level: 1 }).length
}

/**
 * Bump k by 20% if the chosen subset compresses much better than the full set.
 * Port of `_validate_with_zlib` (adaptive_sizer.py).
 */
export function validateWithZlib(items: string[], k: number, maxK: number, tolerance = 0.15): number {
  if (k >= items.length || k >= maxK) return k
  const fullText = items.join('\n')
  const subsetText = items.slice(0, k).join('\n')
  if (fullText.length < 200) return k

  const fullRatio = zlibLen(fullText) / fullText.length
  const subsetRatio = zlibLen(subsetText) / subsetText.length
  if (Math.abs(fullRatio - subsetRatio) > tolerance) {
    return Math.min(Math.floor(k * 1.2), maxK)
  }
  return k
}

// ─── Main entry ────────────────────────────────────────────────────────────

/**
 * Compute optimal number of items to keep via information saturation (Kneedle).
 * Port of `compute_optimal_k` (adaptive_sizer.py).
 */
export function computeOptimalK(items: string[], bias: number, minK: number, maxK?: number): number {
  const n = items.length
  const effectiveMax = maxK ?? n

  if (n <= 8) return n

  const uniqueCount = countUniqueSimhash(items, 3)
  if (uniqueCount <= 3) {
    return Math.min(Math.max(minK, uniqueCount), effectiveMax)
  }

  const curve = computeUniqueBigramCurve(items)
  const diversityRatio = uniqueCount / n
  let knee = findKnee(curve)

  if (knee === null) {
    const keepFraction = 0.3 + 0.7 * diversityRatio
    knee = Math.max(minK, Math.floor(n * keepFraction))
  } else if (diversityRatio > 0.7) {
    const floor = Math.max(minK, Math.floor(n * (0.3 + 0.7 * diversityRatio)))
    knee = Math.max(knee, floor)
  }

  let k = Math.max(minK, Math.floor(knee * bias))
  k = Math.min(k, effectiveMax)
  k = validateWithZlib(items, k, effectiveMax, 0.15)
  return Math.max(minK, Math.min(k, effectiveMax))
}
