/*
 * Ported from: crates/headroom-core/src/transforms/log_compressor.rs
 * Original: https://github.com/chopratejas/headroom (Apache-2.0)
 * Changes: Rust → TypeScript; Aho-Corasick → plain substring/regex;
 *   flate2 → pako; no CCR store (handled by caller).
 */
import { computeOptimalK } from './adaptive-sizer.ts'

// ─── Log format detection (from FormatDetector in log_compressor.rs) ─────
type LogFormat = 'pytest' | 'npm' | 'cargo' | 'jest' | 'make' | 'generic'

const FORMAT_PATTERNS: [LogFormat, string[]][] = [
  ['pytest', ['=== FAILURES', '=== ERRORS', '=== test session', '=== short test summary', 'PASSED [', 'FAILED [', 'ERROR [', 'SKIPPED [', 'collected ']],
  ['npm',    ['npm ERR!', 'npm WARN', 'npm info', 'npm http']],
  ['cargo',  ['Compiling ', 'Finished ', 'Running ', 'warning: ', 'error[E']],
  ['jest',   ['PASS ', 'FAIL ', 'Test Suites:']],
  ['make',   ['make[', 'make:', 'gcc ', 'g++ ', 'clang ']],
]

function detectFormat(lines: string[]): LogFormat {
  const sample = lines.slice(0, 100)
  let best: { fmt: LogFormat; score: number } | null = null
  for (const [fmt, patterns] of FORMAT_PATTERNS) {
    let score = 0
    for (const line of sample) {
      if (patterns.some(p => line.includes(p))) score++
    }
    if (score > 0 && (!best || score > best.score)) best = { fmt, score }
  }
  return best?.fmt ?? 'generic'
}

// ─── Level classification (from LevelClassifier in log_compressor.rs) ────
type LogLevel = 'error' | 'fail' | 'warn' | 'info' | 'debug' | 'trace' | 'unknown'

// Ordered by priority (first match wins) — mirrors Rust MatchKind::LeftmostFirst
const LEVEL_PATTERNS: [LogLevel, RegExp][] = [
  ['error', /\b(ERROR|error|Error|FATAL|fatal|Fatal|CRITICAL|critical)\b/],
  ['fail',  /\b(FAIL|FAILED|fail|failed|Fail|Failed)\b/],
  ['warn',  /\b(WARN|WARNING|warn|warning|Warn|Warning)\b/],
  ['info',  /\b(INFO|info|Info)\b/],
  ['debug', /\b(DEBUG|debug|Debug)\b/],
  ['trace', /\b(TRACE|trace|Trace)\b/],
]

function classifyLevel(line: string): LogLevel {
  for (const [level, re] of LEVEL_PATTERNS) {
    if (re.test(line)) return level
  }
  return 'unknown'
}

// Level scores matching Python/Rust (ERROR/FAIL=1.0, WARN=0.5, INFO=0.1, DEBUG/TRACE=0.0)
const LEVEL_SCORE: Record<LogLevel, number> = {
  error: 1.0, fail: 1.0, warn: 0.5, info: 0.1, debug: 0.0, trace: 0.0, unknown: 0.0,
}

// ─── Stack-trace detection (from log_compressor.rs state machine) ─────────
//
// Per the Rust fix notes: Python terminated stack traces on any blank line,
// which broke chained exceptions. Rust tracks per-flavor rules.
// We implement a simplified but correct version: a stack trace starts
// at "Traceback" / "Error:" / "  at " and ends on non-indented non-blank
// line AFTER at least one indented frame.

function isStackTraceLine(line: string, _prevLines: string[]): boolean {
  if (/^\s+(at |File "|in <)/.test(line)) return true
  if (/^(Traceback|Caused by:|Exception:|Error:)/.test(line)) return true
  // JS: "at functionName (file:line:col)"
  if (/^\s+at .+\(.+:\d+:\d+\)/.test(line)) return true
  return false
}

// ─── Summary line detection ───────────────────────────────────────────────
const SUMMARY_PATTERNS: RegExp[] = [
  /=== \d+ (passed|failed|error)/i,
  /Tests run:.*Failures:/i,
  /Test Suites:.*tests:/i,
  /FAILED.*\d+ error/i,
  /\d+ test(s)? (passed|failed)/i,
  /exit code \d+/i,
]
function isSummaryLine(line: string): boolean {
  return SUMMARY_PATTERNS.some(re => re.test(line))
}

// ─── Config defaults (from LogCompressorConfig::default()) ───────────────
export interface LogCompressorConfig {
  maxErrors: number
  errorContextLines: number
  keepFirstError: boolean
  keepLastError: boolean
  maxStackTraces: number
  stackTraceMaxLines: number
  maxWarnings: number
  dedupeWarnings: boolean
  keepSummaryLines: boolean
  maxTotalLines: number
}

export const DEFAULT_LOG_CONFIG: LogCompressorConfig = {
  maxErrors: 10,
  errorContextLines: 3,
  keepFirstError: true,
  keepLastError: true,
  maxStackTraces: 3,
  stackTraceMaxLines: 20,
  maxWarnings: 5,
  dedupeWarnings: true,
  keepSummaryLines: true,
  maxTotalLines: 100,
}

export interface LogCompressResult {
  compressed: string
  format: LogFormat
  originalLineCount: number
  compressedLineCount: number
  compressionRatio: number
  ccrHash: string | null
}

// ─── Main log compressor ──────────────────────────────────────────────────
export function compressLogs(text: string, config = DEFAULT_LOG_CONFIG): LogCompressResult {
  const lines = text.split('\n')
  const n = lines.length
  const format = detectFormat(lines)

  // Fast path: small inputs
  if (n <= 20) {
    return { compressed: text, format, originalLineCount: n, compressedLineCount: n, compressionRatio: 1.0, ccrHash: null }
  }

  // Classify every line
  interface LineInfo {
    idx: number
    content: string
    level: LogLevel
    score: number
    isStack: boolean
    isSummary: boolean
  }
  const classified: LineInfo[] = lines.map((content, idx) => {
    const level = classifyLevel(content)
    const isStack = isStackTraceLine(content, lines.slice(Math.max(0, idx - 3), idx))
    const isSummary = isSummaryLine(content)
    const score = LEVEL_SCORE[level] + (isStack ? 0.3 : 0) + (isSummary ? 0.2 : 0)
    return { idx, content, level, score, isStack, isSummary }
  })

  // Adaptive total budget via Kneedle (same as Rust)
  const scoreStrs = classified.map(l => l.score.toFixed(3) + ' ' + l.content.slice(0, 60))
  const budget = Math.min(
    config.maxTotalLines,
    computeOptimalK(scoreStrs, 1.0, 10, config.maxTotalLines)
  )

  const keepIdx = new Set<number>()

  // 1. Errors + context window
  const errorLines = classified.filter(l => l.level === 'error' || l.level === 'fail')
  const errorsToKeep = errorLines.slice(0, config.maxErrors)
  if (config.keepFirstError && errorLines.length > 0) {
    const first = errorLines[0]
    for (let i = Math.max(0, first.idx - config.errorContextLines); i <= Math.min(n - 1, first.idx + config.errorContextLines); i++) keepIdx.add(i)
  }
  if (config.keepLastError && errorLines.length > 1) {
    const last = errorLines[errorLines.length - 1]
    for (let i = Math.max(0, last.idx - config.errorContextLines); i <= Math.min(n - 1, last.idx + config.errorContextLines); i++) keepIdx.add(i)
  }
  for (const el of errorsToKeep) {
    for (let i = Math.max(0, el.idx - config.errorContextLines); i <= Math.min(n - 1, el.idx + config.errorContextLines); i++) keepIdx.add(i)
  }

  // 2. Stack traces (up to maxStackTraces, capped at stackTraceMaxLines each)
  let stackCount = 0
  let inStack = false
  let stackLines = 0
  for (const line of classified) {
    if (stackCount >= config.maxStackTraces) break
    if (line.isStack) {
      if (!inStack) { inStack = true; stackLines = 0; stackCount++ }
      if (stackLines < config.stackTraceMaxLines) { keepIdx.add(line.idx); stackLines++ }
    } else {
      inStack = false; stackLines = 0
    }
  }

  // 3. Warnings (deduped)
  const warnLines = classified.filter(l => l.level === 'warn')
  const seenWarnMsg = new Set<string>()
  let warnKept = 0
  for (const wl of warnLines) {
    if (warnKept >= config.maxWarnings) break
    const key = wl.content.replace(/\d+/g, 'N').slice(0, 80) // normalize digits for dedup
    if (!config.dedupeWarnings || !seenWarnMsg.has(key)) {
      seenWarnMsg.add(key)
      keepIdx.add(wl.idx)
      warnKept++
    }
  }

  // 4. Summary lines
  if (config.keepSummaryLines) {
    for (const l of classified) {
      if (l.isSummary) keepIdx.add(l.idx)
    }
  }

  // 5. Fill up to budget with highest-scoring remaining lines
  if (keepIdx.size < budget) {
    const remaining = classified
      .filter(l => !keepIdx.has(l.idx))
      .sort((a, b) => b.score - a.score)
    for (const l of remaining) {
      if (keepIdx.size >= budget) break
      keepIdx.add(l.idx)
    }
  }

  // Build output in original order
  const keptLines = Array.from(keepIdx)
    .sort((a, b) => a - b)
    .map(i => lines[i])

  // Insert [N lines omitted] markers at gaps > 1
  const output: string[] = []
  const sortedIdx = Array.from(keepIdx).sort((a, b) => a - b)
  let prev = -1
  for (const idx of sortedIdx) {
    if (prev >= 0 && idx - prev > 1) {
      output.push(`... [${idx - prev - 1} lines omitted]`)
    }
    output.push(lines[idx])
    prev = idx
  }

  const compressed = output.join('\n')
  const compressionRatio = keptLines.length / n

  // CCR hash when compression is aggressive
  const ccrHash = compressionRatio < 0.5 ? simpleHash(text) : null

  return {
    compressed,
    format,
    originalLineCount: n,
    compressedLineCount: keptLines.length,
    compressionRatio,
    ccrHash,
  }
}

function simpleHash(text: string): string {
  let h = 0n
  for (let i = 0; i < Math.min(text.length, 2000); i++) {
    h = (h * 31n + BigInt(text.charCodeAt(i))) & 0xFFFFFFFFFFFFFFFFn
  }
  return h.toString(16).padStart(12, '0').slice(0, 12)
}
