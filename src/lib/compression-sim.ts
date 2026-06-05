/**
 * Client-side compression simulation that approximates Headroom's 3-stage pipeline.
 * Used when no Headroom proxy is configured. Results are educational approximations.
 */

export interface SimResult {
  compressed: string
  tokensBefore: number
  tokensAfter: number
  compressionRatio: number
  tokensSaved: number
  pipeline: string
  diffs: DiffChunk[]
}

export interface DiffChunk {
  type: 'keep' | 'remove' | 'replace'
  original: string
  replacement?: string
}

export interface SimConfig {
  compressionRatioTarget: number
  useEntropyPreservation: boolean
  tokenBudget: number
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const HASH_RE = /\b[0-9a-f]{32,64}\b/gi
const TOKEN_RE = /\b(tok_|jwt_|key_|secret_|api_|sess_)[A-Za-z0-9_\-]{8,}\b/g

function detectPipeline(content: string): string {
  const trimmed = content.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'SmartCrusher'
  if (/^(import |from |def |class |async def |@dataclass)/m.test(trimmed)) return 'CodeAwareCompressor'
  if (/\[(INFO|DEBUG|WARN|ERROR|FATAL)\]/i.test(trimmed)) return 'LogCompressor'
  return 'TextCompressor'
}

// Preserve entropy-sensitive tokens (UUIDs, hashes, API tokens)
function extractEntropyTokens(text: string): Set<string> {
  const tokens = new Set<string>()
  ;[...text.matchAll(UUID_RE)].forEach(m => tokens.add(m[0]))
  ;[...text.matchAll(HASH_RE)].forEach(m => tokens.add(m[0]))
  ;[...text.matchAll(TOKEN_RE)].forEach(m => tokens.add(m[0]))
  return tokens
}

function simSmartCrusher(content: string, config: SimConfig): SimResult {
  const entropyTokens = config.useEntropyPreservation ? extractEntropyTokens(content) : new Set<string>()
  const diffs: DiffChunk[] = []
  let compressed = content

  // Collapse long string values in JSON (keep first 60 chars)
  compressed = compressed.replace(/"([^"]{80,})"/g, (match, val) => {
    const isEntropy = [...entropyTokens].some(t => val.includes(t))
    if (isEntropy) {
      diffs.push({ type: 'keep', original: match })
      return match
    }
    const short = val.slice(0, 60) + '…'
    diffs.push({ type: 'replace', original: match, replacement: `"${short}"` })
    return `"${short}"`
  })

  // Collapse repeated whitespace/indentation beyond depth 2
  compressed = compressed.replace(/^( {8,})/gm, (m) => {
    diffs.push({ type: 'replace', original: m, replacement: '  ' })
    return '  '
  })

  // Remove verbose metadata keys if over budget
  const metaKeys = ['biography', 'description', 'bio', 'full_name', 'avatar_url', 'timezone', 'language']
  for (const key of metaKeys) {
    const re = new RegExp(`"${key}":\\s*"[^"]*",?\\n?`, 'g')
    compressed = compressed.replace(re, (m) => {
      diffs.push({ type: 'remove', original: m })
      return ''
    })
  }

  return buildResult(content, compressed, 'SmartCrusher', diffs)
}

function simCodeCompressor(content: string, _config: SimConfig): SimResult {
  const diffs: DiffChunk[] = []
  let compressed = content

  // Strip function bodies (keep signature + docstring, replace body with pass)
  compressed = compressed.replace(/(def \w+\([^)]*\)[^:]*:)(\s*"""[\s\S]*?""")?(\s[\s\S]*?)(?=\n\S|\n    def |\n\nclass |\n\ndef |$)/g,
    (match, sig, doc, body) => {
      if (!body || body.trim().split('\n').length <= 3) return match
      const replacement = `${sig}${doc || ''}\n    ... # body omitted by compressor`
      diffs.push({ type: 'replace', original: match, replacement })
      return replacement
    }
  )

  // Strip inline comments
  compressed = compressed.replace(/\s+#(?! type:)[^\n]+/g, (m) => {
    diffs.push({ type: 'remove', original: m })
    return ''
  })

  // Collapse blank lines > 1
  compressed = compressed.replace(/\n{3,}/g, '\n\n')

  return buildResult(content, compressed, 'CodeAwareCompressor', diffs)
}

function simLogCompressor(content: string, _config: SimConfig): SimResult {
  const diffs: DiffChunk[] = []
  const lines = content.split('\n')
  const kept: string[] = []

  for (const line of lines) {
    const isError = /\[(ERROR|FATAL|WARN)\]/.test(line)
    const isStackTrace = /^\s+at /.test(line) || /Error:/.test(line)
    const isTimestamp = /^\d{4}-\d{2}-\d{2}/.test(line)
    const isInfo = /\[INFO\]/.test(line)
    const isDebug = /\[DEBUG\]/.test(line)

    if (isError || isStackTrace) {
      kept.push(line)
    } else if (isDebug) {
      // Drop most debug lines
      diffs.push({ type: 'remove', original: line })
    } else if (isInfo) {
      // Keep 1 in 3 info lines
      if (Math.random() < 0.33) {
        kept.push(line)
      } else {
        diffs.push({ type: 'remove', original: line })
      }
    } else if (isTimestamp) {
      kept.push(line)
    } else {
      diffs.push({ type: 'remove', original: line })
    }
  }

  const compressed = kept.join('\n')
  return buildResult(content, compressed, 'LogCompressor', diffs)
}

function simTextCompressor(content: string, _config: SimConfig): SimResult {
  const diffs: DiffChunk[] = []
  let compressed = content

  // Remove repeated blank lines
  compressed = compressed.replace(/\n{3,}/g, '\n\n')

  // Truncate very long paragraphs
  compressed = compressed.replace(/([^\n]{300,})/g, (m) => {
    const short = m.slice(0, 250) + ' […]'
    diffs.push({ type: 'replace', original: m, replacement: short })
    return short
  })

  return buildResult(content, compressed, 'TextCompressor', diffs)
}

function buildResult(original: string, compressed: string, pipeline: string, diffs: DiffChunk[]): SimResult {
  const rough = (s: string) => Math.ceil(s.length / 4)
  const tokensBefore = rough(original)
  const tokensAfter = rough(compressed)
  return {
    compressed,
    tokensBefore,
    tokensAfter,
    compressionRatio: tokensAfter / tokensBefore,
    tokensSaved: tokensBefore - tokensAfter,
    pipeline,
    diffs,
  }
}

export function simulateCompression(content: string, config: SimConfig): SimResult {
  const pipeline = detectPipeline(content)
  switch (pipeline) {
    case 'SmartCrusher': return simSmartCrusher(content, config)
    case 'CodeAwareCompressor': return simCodeCompressor(content, config)
    case 'LogCompressor': return simLogCompressor(content, config)
    default: return simTextCompressor(content, config)
  }
}
