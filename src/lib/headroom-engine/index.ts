/*
 * Main entry point for the compression engine.
 * Algorithms ported from https://github.com/chopratejas/headroom (Apache-2.0)
 */
import { smartCrush, DEFAULT_CONFIG as SC_DEFAULT } from './smart-crusher.ts'
import { compressLogs, DEFAULT_LOG_CONFIG } from './log-compressor.ts'
import { compressCode } from './code-compressor.ts'
import { compressText } from './text-compressor.ts'
import type { SimConfig, SimResult, DiffChunk } from '../compression-sim.ts'

export type { SimResult, DiffChunk }

type ContentType = 'json' | 'code' | 'logs' | 'text'

function detectContentType(content: string): ContentType {
  const trimmed = content.trimStart()
  // Distinguish real JSON arrays from [Page N] markers in PDF chunks
  if (trimmed.startsWith('{') || (trimmed.startsWith('[') && !trimmed.startsWith('[Page'))) return 'json'
  if (/^(import |from |def |async def |class |function |const |let |#!\/)/m.test(content)) return 'code'
  if (/\[(INFO|DEBUG|WARN|ERROR|FATAL)\]/i.test(content)) return 'logs'
  return 'text'
}

function rough(s: string): number { return Math.ceil(s.length / 4) }

function toBias(ratioTarget: number): number {
  return 0.3 + (ratioTarget / 0.9) * 1.2
}

export function compressContent(content: string, config: SimConfig, query = ''): SimResult {
  const type = detectContentType(content)
  const bias = toBias(config.compressionRatioTarget)

  if (type === 'json') {
    const sc = { ...SC_DEFAULT }
    if (config.tokenBudget < 4000) sc.maxItemsAfterCrush = 10
    else if (config.tokenBudget < 8000) sc.maxItemsAfterCrush = 20
    else sc.maxItemsAfterCrush = 0

    const result = smartCrush(content, sc, bias)
    const tokensBefore = rough(content)
    const tokensAfter = rough(result.compressed)
    const diffs: DiffChunk[] = result.droppedCount > 0
      ? [{ type: 'remove', original: `[${result.droppedCount} items offloaded]` }]
      : []
    return { compressed: result.compressed, tokensBefore, tokensAfter, compressionRatio: tokensAfter / tokensBefore, tokensSaved: tokensBefore - tokensAfter, pipeline: 'SmartCrusher', diffs }
  }

  if (type === 'logs') {
    const result = compressLogs(content, DEFAULT_LOG_CONFIG)
    const tokensBefore = rough(content)
    const tokensAfter = rough(result.compressed)
    const diffs: DiffChunk[] = [{ type: 'remove', original: `[${result.originalLineCount - result.compressedLineCount} log lines dropped]` }]
    return { compressed: result.compressed, tokensBefore, tokensAfter, compressionRatio: result.compressionRatio, tokensSaved: tokensBefore - tokensAfter, pipeline: `LogCompressor(${result.format})`, diffs }
  }

  if (type === 'code') {
    const result = compressCode(content)
    const tokensBefore = rough(content)
    const tokensAfter = rough(result.compressed)
    return { compressed: result.compressed, tokensBefore, tokensAfter, compressionRatio: result.compressionRatio, tokensSaved: tokensBefore - tokensAfter, pipeline: 'CodeAwareCompressor', diffs: [] }
  }

  // General text / PDF chunks — sentence-level compression with query awareness
  const result = compressText(content, config.compressionRatioTarget, query)
  const tokensBefore = rough(content)
  const tokensAfter = rough(result.compressed)
  return {
    compressed: result.compressed,
    tokensBefore,
    tokensAfter,
    compressionRatio: result.compressionRatio,
    tokensSaved: tokensBefore - tokensAfter,
    pipeline: `TextCompressor(${result.keptLines}/${result.originalLines} lines)`,
    diffs: [],
  }
}
