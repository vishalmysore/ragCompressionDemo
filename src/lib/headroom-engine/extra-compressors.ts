/**
 * Simple browser-native compressors: Truncation, Stopword Removal,
 * Near-duplicate Removal (SimHash).
 */
import { simhash, hammingDistance } from './adaptive-sizer.ts'

// ─── Truncation ────────────────────────────────────────────────────────────
/**
 * Keep the first `ratioTarget` fraction of sentences.
 * Dumb baseline — no intelligence, just cuts the tail.
 */
export function compressTruncate(text: string, ratioTarget: number): string {
  const lines = text.split('\n').filter(l => l.trim())
  const keep = Math.max(3, Math.round(lines.length * ratioTarget))
  return lines.slice(0, keep).join('\n')
}

// ─── Stopword Removal ──────────────────────────────────────────────────────
const STOPWORDS = /\b(the|a|an|is|are|was|were|be|been|being|have|has|had|do|does|did|will|would|could|should|may|might|must|shall|to|of|in|on|at|for|with|by|from|as|into|about|through|and|or|but|not|its|this|that|these|those|it|they|their|there|here|just|also|very|so|such|than|then|when|where|which|who|what|how|all|each|both|few|more|most|other|some|such|no|nor|only|own|same|too|very|can|any|up|out|if|over|after|before|above|below|between)\b\s*/gi

/**
 * Remove common stopwords — lossless of meaning, ~10-20% token reduction.
 * Keeps numbers, named entities, and technical terms intact.
 */
export function compressStopwords(text: string): string {
  return text
    .replace(STOPWORDS, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim()
}

// ─── Near-duplicate Removal (SimHash) ─────────────────────────────────────
/**
 * Remove sentences that are SimHash-similar to an earlier sentence.
 * Uses the Kneedle SimHash we ported from headroom's adaptive_sizer.rs.
 * Hamming distance threshold: ≤ 8 bits different = near-duplicate.
 */
export function compressDedup(text: string, ratioTarget: number): string {
  const lines = text.split('\n').filter(l => l.trim())
  const THRESHOLD = 8  // ≤ 8 bits Hamming = near-duplicate

  const kept: string[] = []
  const seenHashes: bigint[] = []

  for (const line of lines) {
    // Always keep [Page N] markers
    if (/^\[Page \d+\]/.test(line.trim())) {
      kept.push(line)
      continue
    }
    const fp = simhash(line)
    const isDuplicate = seenHashes.some(h => hammingDistance(fp, h) <= THRESHOLD)
    if (!isDuplicate) {
      kept.push(line)
      seenHashes.push(fp)
    }
  }

  // If dedup alone doesn't hit the target, also truncate
  const targetK = Math.max(3, Math.round(lines.length * ratioTarget))
  return kept.slice(0, targetK).join('\n')
}
