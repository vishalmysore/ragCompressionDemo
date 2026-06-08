/*
 * Main compression engine entry point.
 * Algorithms ported from https://github.com/chopratejas/headroom (Apache-2.0):
 *   SmartCrusher, LogCompressor, adaptive-sizer, keyword signals.
 * Additional techniques: TF-IDF, TextRank, Truncation, Stopwords, Dedup.
 *
 * Code-splitting strategy:
 *   EAGER  — none / headroom-smart / headroom-aggressive (default columns)
 *            text-compressor, smart-crusher, log-compressor, code-compressor
 *   LAZY   — tfidf, textrank, stopwords, dedup, truncation
 *            loaded via dynamic import() on first use, then cached
 */

// ── Eager imports (always in initial bundle) ──────────────────────────────
import { smartCrush, DEFAULT_CONFIG as SC_DEFAULT } from './smart-crusher.ts'
import { compressLogs, DEFAULT_LOG_CONFIG } from './log-compressor.ts'
import { compressCode } from './code-compressor.ts'
import { compressText } from './text-compressor.ts'
import type { SimConfig, SimResult, DiffChunk } from '../compression-sim.ts'

export type { SimResult, DiffChunk }

export type CompressionMethod =
  | 'none'
  | 'headroom-smart'
  | 'headroom-aggressive'
  | 'tfidf'
  | 'textrank'
  | 'truncation'
  | 'stopwords'
  | 'dedup'

export interface MethodInfo {
  key: CompressionMethod
  label: string
  desc: string
  category: 'baseline' | 'smart' | 'classic' | 'advanced'
  color: string
}

export const METHODS: MethodInfo[] = [
  { key: 'none',                label: 'No Compression',      desc: 'Full context, no reduction',                          category: 'baseline', color: 'red'    },
  { key: 'headroom-smart',      label: 'Smart Compress',       desc: 'Keyword signals + Kneedle K (~40-60% reduction)',     category: 'smart',    color: 'cyan'   },
  { key: 'headroom-aggressive', label: 'Aggressive Compress',  desc: 'Same signals, higher ratio (~70-85% reduction)',      category: 'smart',    color: 'blue'   },
  { key: 'tfidf',               label: 'TF-IDF',               desc: 'Score sentences by query term frequency × IDF',       category: 'classic',  color: 'yellow' },
  { key: 'textrank',            label: 'TextRank',             desc: 'Graph-based importance (PageRank for sentences)',     category: 'classic',  color: 'orange' },
  { key: 'truncation',          label: 'Truncation',           desc: 'Keep first N sentences — dumb baseline',             category: 'baseline', color: 'gray'   },
  { key: 'stopwords',           label: 'Stopword Removal',     desc: 'Strip "the/a/is/of…" — lossless, ~10-20% reduction', category: 'advanced', color: 'purple' },
  { key: 'dedup',               label: 'SimHash Dedup',        desc: 'Remove near-duplicate sentences via SimHash',         category: 'advanced', color: 'green'  },
]

// ── Lazy module cache ─────────────────────────────────────────────────────
// Each entry is a Promise that resolves once the chunk is loaded.
// After the first call the same Promise is returned (no double-load).

let _tfidfMod:   Promise<typeof import('./tfidf-compressor.ts')>   | null = null
let _textrankMod:Promise<typeof import('./textrank-compressor.ts')>| null = null
let _extraMod:   Promise<typeof import('./extra-compressors.ts')>  | null = null

function loadTfIdf()    { return (_tfidfMod    ??= import('./tfidf-compressor.ts'))    }
function loadTextRank() { return (_textrankMod ??= import('./textrank-compressor.ts')) }
function loadExtra()    { return (_extraMod    ??= import('./extra-compressors.ts'))   }

// ── Content-type detector ─────────────────────────────────────────────────

function detectContentType(content: string): 'json' | 'code' | 'logs' | 'text' {
  const t = content.trimStart()
  if (t.startsWith('{') || (t.startsWith('[') && !t.startsWith('[Page'))) return 'json'
  if (/^(import |from |def |async def |class |function |const |let |#!\/)/m.test(content)) return 'code'
  if (/\[(INFO|DEBUG|WARN|ERROR|FATAL)\]/i.test(content)) return 'logs'
  return 'text'
}

const rough = (s: string) => Math.ceil(s.length / 4)

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Synchronous fast-path for the three default methods (none / smart / aggressive).
 * Returns null for lazy methods so the caller knows to await compressContentAsync.
 */
export function compressContentSync(
  content: string,
  config: SimConfig,
  query = '',
  method: CompressionMethod = 'headroom-smart',
): SimResult | null {
  const type = detectContentType(content)

  // Structured content — always handled eagerly
  if (type === 'json') {
    const sc = { ...SC_DEFAULT, maxItemsAfterCrush: config.tokenBudget < 8000 ? 20 : 0 }
    const r  = smartCrush(content, sc, 0.3 + (config.compressionRatioTarget / 0.9) * 1.2)
    const tb = rough(content), ta = rough(r.compressed)
    return { compressed: r.compressed, tokensBefore: tb, tokensAfter: ta, compressionRatio: ta/tb, tokensSaved: tb-ta, pipeline: 'SmartCrusher', diffs: [] }
  }
  if (type === 'logs') {
    const r  = compressLogs(content, DEFAULT_LOG_CONFIG)
    const tb = rough(content), ta = rough(r.compressed)
    return { compressed: r.compressed, tokensBefore: tb, tokensAfter: ta, compressionRatio: r.compressionRatio, tokensSaved: tb-ta, pipeline: `LogCompressor(${r.format})`, diffs: [] }
  }
  if (type === 'code') {
    const r  = compressCode(content)
    const tb = rough(content), ta = rough(r.compressed)
    return { compressed: r.compressed, tokensBefore: tb, tokensAfter: ta, compressionRatio: r.compressionRatio, tokensSaved: tb-ta, pipeline: 'CodeAwareCompressor', diffs: [] }
  }

  // Eager text methods
  switch (method) {
    case 'none':
      return mkResult(content, content, 'No Compression')
    case 'headroom-smart':
      return mkResult(content, compressText(content, 0.5,  query).compressed, 'Headroom·KeywordSignals(smart)')
    case 'headroom-aggressive':
      return mkResult(content, compressText(content, 0.15, query).compressed, 'Headroom·KeywordSignals(aggressive)')
    default:
      // Lazy methods — caller must use compressContentAsync
      return null
  }
}

/**
 * Async version — handles ALL methods including the lazy-loaded ones.
 * Falls back to compressContentSync for eager methods so there's no overhead.
 */
export async function compressContent(
  content: string,
  config: SimConfig,
  query = '',
  method: CompressionMethod = 'headroom-smart',
): Promise<SimResult> {
  // Try the fast synchronous path first
  const sync = compressContentSync(content, config, query, method)
  if (sync) return sync

  const ratio = config.compressionRatioTarget
  switch (method) {
    case 'tfidf': {
      const { compressTfIdf } = await loadTfIdf()
      return mkResult(content, compressTfIdf(content, ratio, query), 'TF-IDF')
    }
    case 'textrank': {
      const { compressTextRank } = await loadTextRank()
      return mkResult(content, compressTextRank(content, ratio), 'TextRank')
    }
    case 'truncation': {
      const { compressTruncate } = await loadExtra()
      return mkResult(content, compressTruncate(content, ratio), 'Truncation')
    }
    case 'stopwords': {
      const { compressStopwords } = await loadExtra()
      return mkResult(content, compressStopwords(content), 'StopwordRemoval')
    }
    case 'dedup': {
      const { compressDedup } = await loadExtra()
      return mkResult(content, compressDedup(content, ratio), 'SimHash·Dedup')
    }
    default:
      return mkResult(content, content, 'None')
  }
}

function mkResult(original: string, compressed: string, pipeline: string): SimResult {
  const tb = rough(original), ta = rough(compressed)
  return { compressed, tokensBefore: tb, tokensAfter: ta, compressionRatio: ta/tb, tokensSaved: tb-ta, pipeline, diffs: [] }
}
