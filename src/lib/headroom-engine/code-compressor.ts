/*
 * Code-aware compressor — JS port of CodeCompressor concept from
 * headroom (https://github.com/chopratejas/headroom, Apache-2.0).
 * Changes: uses regex-based AST approximation (no tree-sitter) for
 * browser compatibility. Preserves signatures, imports, class/type
 * definitions; stubs function bodies.
 */

export interface CodeCompressResult {
  compressed: string
  originalLines: number
  compressedLines: number
  compressionRatio: number
  ccrHash: string | null
}

// Lines that must always be kept
const KEEP_PATTERNS: RegExp[] = [
  /^(import |from |export |require\()/,           // imports
  /^(class |def |async def |function |const |let |var |type |interface |struct |enum |impl )/,
  /^\s*(public |private |protected |static |async |export )*(function |class |def |async def )/,
  /^\s*(@\w+)/,                                   // decorators
  /^\s*(return |raise |throw )/,                  // returns/raises at top of body are useful
  /^\s*#\s*(type:|noqa|pylint)/,                  // type comments
  /@(dataclass|property|staticmethod|classmethod)/,
]

// Patterns that signal the start of a function/method body to collapse
const BODY_START_RE = /^(\s+)(.*):(\s*#.*)?$/
const DEF_RE = /^(\s*)(async\s+)?def\s+\w+|^(\s*)(public|private|protected|static|\s)*(async\s+)?function\s+\w+/

// Comment removal pattern (keep type comments)
const COMMENT_RE = /\s+#(?! type:)[^\n]*/g

export function compressCode(text: string): CodeCompressResult {
  const lines = text.split('\n')
  const n = lines.length

  if (n <= 30) {
    return { compressed: text, originalLines: n, compressedLines: n, compressionRatio: 1.0, ccrHash: null }
  }

  const output: string[] = []
  let i = 0
  let bodyDepth = 0
  let bodyIndent = ''
  let inBody = false
  let bodyLineCount = 0

  while (i < n) {
    const line = lines[i]
    const trimmed = line.trimStart()
    const indent = line.slice(0, line.length - trimmed.length)

    // Collapse blank lines > 1
    if (!trimmed) {
      if (output.length > 0 && output[output.length - 1] !== '') {
        output.push('')
      }
      i++; continue
    }

    // If we're inside a body being collapsed
    if (inBody) {
      // Body ends when we hit a line at same or less indentation (non-blank)
      if (indent.length <= bodyIndent.length && trimmed) {
        inBody = false
        bodyLineCount = 0
        // fall through to process this line normally
      } else {
        // Skip body line, but emit stub on first body line
        if (bodyLineCount === 0) {
          output.push(`${bodyIndent}    ... # [body omitted — ${estimateBodyLines(lines, i, bodyIndent)} lines]`)
        }
        bodyLineCount++
        i++; continue
      }
    }

    // Check if this is a function/method definition
    if (DEF_RE.test(line)) {
      // Keep the signature line (strip inline comments except type comments)
      output.push(line.replace(COMMENT_RE, ''))
      // Next non-blank line starts the body
      inBody = true
      bodyIndent = indent
      bodyLineCount = 0
      i++; continue
    }

    // Check keep patterns
    const shouldKeep = KEEP_PATTERNS.some(re => re.test(line))
    if (shouldKeep) {
      output.push(line.replace(COMMENT_RE, ''))
      i++; continue
    }

    // Class bodies: keep class line + first docstring line
    if (/^(\s*)(class )\w+/.test(line)) {
      output.push(line)
      i++; continue
    }

    // Docstrings: keep first line of docstring
    if (/^\s*("""|\'\'\')/.test(trimmed)) {
      output.push(line)
      // If multiline, skip to end
      const quote = trimmed.startsWith('"""') ? '"""' : "'''"
      if (!trimmed.slice(3).includes(quote)) {
        i++
        while (i < n && !lines[i].includes(quote)) i++
        if (i < n) i++ // consume closing quote line
        continue
      }
      i++; continue
    }

    // Variable assignments at module level (indent=0) are usually important
    if (indent === '' && /^[A-Z_][A-Z0-9_]*\s*=/.test(trimmed)) {
      output.push(line)
      i++; continue
    }

    // Everything else: skip
    i++
  }

  // Clean up consecutive blank lines
  const cleaned = output.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  const compressedLines = cleaned.split('\n').length
  const ratio = compressedLines / n

  return {
    compressed: cleaned,
    originalLines: n,
    compressedLines,
    compressionRatio: ratio,
    ccrHash: ratio < 0.6 ? simpleHash(text) : null,
  }
}

function estimateBodyLines(lines: string[], startIdx: number, baseIndent: string): number {
  let count = 0
  for (let i = startIdx; i < lines.length; i++) {
    const t = lines[i].trimStart()
    if (!t) { count++; continue }
    const ind = lines[i].slice(0, lines[i].length - t.length)
    if (ind.length <= baseIndent.length) break
    count++
  }
  return count
}

function simpleHash(text: string): string {
  let h = 0n
  for (let i = 0; i < Math.min(text.length, 2000); i++) {
    h = (h * 31n + BigInt(text.charCodeAt(i))) & 0xFFFFFFFFFFFFFFFFn
  }
  return h.toString(16).padStart(12, '0').slice(0, 12)
}
