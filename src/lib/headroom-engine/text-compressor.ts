/*
 * Ported from: crates/headroom-core/src/signals/keyword_detector.rs
 *              crates/headroom-core/src/signals/line_importance.rs
 * Original: https://github.com/chopratejas/headroom (Apache-2.0)
 * Changes: Rust → TypeScript; Aho-Corasick → plain includes/regex;
 *   compute_optimal_k used for adaptive K selection.
 *
 * Scores each line/sentence using headroom's KeywordRegistry priority
 * tiers, then keeps the top-K using the Kneedle adaptive sizer.
 */
import { computeOptimalK } from './adaptive-sizer.ts'

// ── KeywordRegistry (from keyword_detector.rs) ────────────────────────
// Priorities match the Rust constants exactly
const PRIORITY = {
  error:      0.95,
  security:   0.85,
  warning:    0.75,
  importance: 0.60,
  markdown:   0.45,
} as const

const KEYWORDS = {
  error: [
    'error','exception','fail','failed','failure','fatal','critical',
    'crash','panic','abort','timeout','denied','rejected',
  ],
  warning: ['warn','warning'],
  // 'token' deliberately excluded — false-positives on LLM token counts (bug fix from headroom)
  security: ['password','secret','private','credential','auth','api_key','access_key'],
  importance: [
    'important','note','conclusion','summary','result','key','finding',
    'recommend','must','should','required','critical path','takeaway',
  ],
  // Markdown prefixes — only checked at line start
  markdownPrefixes: ['# ','## ','### ','> ','**'],
}

// ── ImportanceContext::Text scorer ────────────────────────────────────
function scoreLine(line: string): number {
  const lower = line.toLowerCase()

  // Markdown structure (prefix check — matches headroom's prefix-only rule)
  for (const prefix of KEYWORDS.markdownPrefixes) {
    if (line.trimStart().startsWith(prefix)) return PRIORITY.markdown
  }

  // Error keywords (highest priority)
  for (const kw of KEYWORDS.error) {
    if (lower.includes(kw)) return PRIORITY.error
  }

  // Security keywords
  for (const kw of KEYWORDS.security) {
    if (lower.includes(kw)) return PRIORITY.security
  }

  // Warning keywords
  for (const kw of KEYWORDS.warning) {
    if (lower.includes(kw)) return PRIORITY.warning
  }

  // Importance keywords
  for (const kw of KEYWORDS.importance) {
    if (lower.includes(kw)) return PRIORITY.importance
  }

  // No keyword match → neutral (0)
  return 0.0
}

export interface TextCompressResult {
  compressed: string
  originalLines: number
  keptLines: number
  compressionRatio: number
}

export function compressText(text: string, ratioTarget: number, query = ''): TextCompressResult {
  // Split into sentences — PDF chunks are dense single-line blobs, so we
  // must go sentence-level or there's nothing to drop.
  const rawLines = text.split('\n')
  const sentences: string[] = []
  for (const line of rawLines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // Keep [Page N] markers as atomic units
    if (/^\[Page \d+\]/.test(trimmed)) { sentences.push(trimmed); continue }
    // Split line into sentences on . ! ? followed by space+capital
    const parts = trimmed.split(/(?<=[.!?])\s+(?=[A-Z\[\(0-9])/)
    sentences.push(...parts.filter(s => s.trim().length > 10))
  }
  const lines = sentences
  const n = lines.length

  if (n <= 5) {
    return { compressed: text, originalLines: n, keptLines: n, compressionRatio: 1.0 }
  }

  // Score every line using headroom's keyword detector
  const queryTerms = query.toLowerCase().split(/\s+/).filter(w => w.length > 2)

  const scored = lines.map((line, idx) => {
    let score = scoreLine(line)

    // Query relevance — RAG-specific enhancement on top of headroom's signals
    // This is our addition since headroom doesn't have a query at compression time
    if (queryTerms.length > 0) {
      const lower = line.toLowerCase()
      const hits = queryTerms.filter(t => lower.includes(t)).length
      if (hits > 0) score = Math.max(score, 0.3 + (hits / queryTerms.length) * 0.4)
    }

    // Always keep [Page N] boundary markers and non-empty structural lines
    if (/^\[Page \d+\]/.test(line)) score = Math.max(score, 0.5)

    return { line, score, idx }
  })

  // Use compute_optimal_k (Kneedle) to decide how many lines to keep
  // Feed scored strings so the bigram curve reflects actual content diversity
  const scoreStrs = scored.map(s => s.score.toFixed(2) + ' ' + s.line.slice(0, 80))
  const maxK = Math.max(3, Math.round(n * ratioTarget))
  const adaptiveK = computeOptimalK(scoreStrs, ratioTarget < 0.3 ? 0.5 : 1.0, 3, maxK)

  // Select top-K by score, restore original order
  const kept = scored
    .slice() // copy
    .sort((a, b) => b.score - a.score)
    .slice(0, adaptiveK)
    .sort((a, b) => a.idx - b.idx)
    .map(s => s.line)

  return {
    compressed: kept.join('\n'),
    originalLines: n,
    keptLines: kept.length,
    compressionRatio: kept.length / n,
  }
}
