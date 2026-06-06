/*
 * Main compression engine entry point.
 * Algorithms ported from https://github.com/chopratejas/headroom (Apache-2.0):
 *   SmartCrusher, LogCompressor, adaptive-sizer, keyword signals.
 * Additional techniques: TF-IDF, TextRank, Truncation, Stopwords, Dedup.
 */
import { smartCrush, DEFAULT_CONFIG as SC_DEFAULT } from './smart-crusher.ts'
import { compressLogs, DEFAULT_LOG_CONFIG } from './log-compressor.ts'
import { compressCode } from './code-compressor.ts'
import { compressText } from './text-compressor.ts'
import { compressTfIdf } from './tfidf-compressor.ts'
import { compressTextRank } from './textrank-compressor.ts'
import { compressTruncate, compressStopwords, compressDedup } from './extra-compressors.ts'
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
  category: 'baseline' | 'headroom' | 'classic' | 'advanced'
  color: string
}

export const METHODS: MethodInfo[] = [
  { key: 'none',               label: 'No Compression',      desc: 'Full context, no reduction',                          category: 'baseline', color: 'red'    },
  { key: 'headroom-smart',     label: 'Headroom Smart',       desc: 'Keyword signals + Kneedle K (~40-60% reduction)',     category: 'headroom', color: 'cyan'   },
  { key: 'headroom-aggressive',label: 'Headroom Aggressive',  desc: 'Same signals, higher ratio (~70-85% reduction)',      category: 'headroom', color: 'blue'   },
  { key: 'tfidf',              label: 'TF-IDF',               desc: 'Score sentences by query term frequency × IDF',       category: 'classic',  color: 'yellow' },
  { key: 'textrank',           label: 'TextRank',             desc: 'Graph-based importance (PageRank for sentences)',     category: 'classic',  color: 'orange' },
  { key: 'truncation',         label: 'Truncation',           desc: 'Keep first N sentences — dumb baseline',             category: 'baseline', color: 'gray'   },
  { key: 'stopwords',          label: 'Stopword Removal',     desc: 'Strip "the/a/is/of…" — lossless, ~10-20% reduction', category: 'advanced', color: 'purple' },
  { key: 'dedup',              label: 'SimHash Dedup',        desc: 'Remove near-duplicate sentences via SimHash',         category: 'advanced', color: 'green'  },
]

function detectContentType(content: string): 'json' | 'code' | 'logs' | 'text' {
  const t = content.trimStart()
  if (t.startsWith('{') || (t.startsWith('[') && !t.startsWith('[Page'))) return 'json'
  if (/^(import |from |def |async def |class |function |const |let |#!\/)/m.test(content)) return 'code'
  if (/\[(INFO|DEBUG|WARN|ERROR|FATAL)\]/i.test(content)) return 'logs'
  return 'text'
}

const rough = (s: string) => Math.ceil(s.length / 4)

export function compressContent(content: string, config: SimConfig, query = '', method: CompressionMethod = 'headroom-smart'): SimResult {
  const type = detectContentType(content)

  // Structured types always use their dedicated headroom compressors
  if (type === 'json') {
    const sc = { ...SC_DEFAULT, maxItemsAfterCrush: config.tokenBudget < 8000 ? 20 : 0 }
    const r = smartCrush(content, sc, 0.3 + (config.compressionRatioTarget / 0.9) * 1.2)
    const tb = rough(content), ta = rough(r.compressed)
    return { compressed: r.compressed, tokensBefore: tb, tokensAfter: ta, compressionRatio: ta/tb, tokensSaved: tb-ta, pipeline: 'SmartCrusher', diffs: [] }
  }
  if (type === 'logs') {
    const r = compressLogs(content, DEFAULT_LOG_CONFIG)
    const tb = rough(content), ta = rough(r.compressed)
    return { compressed: r.compressed, tokensBefore: tb, tokensAfter: ta, compressionRatio: r.compressionRatio, tokensSaved: tb-ta, pipeline: `LogCompressor(${r.format})`, diffs: [] }
  }
  if (type === 'code') {
    const r = compressCode(content)
    const tb = rough(content), ta = rough(r.compressed)
    return { compressed: r.compressed, tokensBefore: tb, tokensAfter: ta, compressionRatio: r.compressionRatio, tokensSaved: tb-ta, pipeline: 'CodeAwareCompressor', diffs: [] }
  }

  // General text / PDF — route by selected method
  let compressed = content
  let pipeline = 'None'
  const ratio = config.compressionRatioTarget

  switch (method) {
    case 'none':
      compressed = content
      pipeline = 'No Compression'
      break
    case 'headroom-smart':
      compressed = compressText(content, 0.5, query).compressed
      pipeline = 'Headroom·KeywordSignals(smart)'
      break
    case 'headroom-aggressive':
      compressed = compressText(content, 0.15, query).compressed
      pipeline = 'Headroom·KeywordSignals(aggressive)'
      break
    case 'tfidf':
      compressed = compressTfIdf(content, ratio, query)
      pipeline = 'TF-IDF'
      break
    case 'textrank':
      compressed = compressTextRank(content, ratio)
      pipeline = 'TextRank'
      break
    case 'truncation':
      compressed = compressTruncate(content, ratio)
      pipeline = 'Truncation'
      break
    case 'stopwords':
      compressed = compressStopwords(content)
      pipeline = 'StopwordRemoval'
      break
    case 'dedup':
      compressed = compressDedup(content, ratio)
      pipeline = 'SimHash·Dedup'
      break
  }

  const tb = rough(content), ta = rough(compressed)
  return { compressed, tokensBefore: tb, tokensAfter: ta, compressionRatio: ta/tb, tokensSaved: tb-ta, pipeline, diffs: [] }
}
