/**
 * TextRank sentence scoring compressor.
 * Graph-based extractive summarisation — sentences that share
 * significant word overlap with many other sentences score higher.
 * Pure JS, no model needed. Inspired by Mihalcea & Tarau (2004).
 */

const STOPWORDS = new Set(['the','a','an','is','are','was','were','be','been',
  'have','has','had','do','does','did','will','would','could','should',
  'of','in','on','at','to','for','with','by','from','as','and','or','but',
  'not','it','its','this','that','they','he','she','we','you','i','can'])

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/)
      .filter(w => w.length > 2 && !STOPWORDS.has(w))
  )
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let overlap = 0
  for (const w of a) if (b.has(w)) overlap++
  // Normalise by log of lengths — standard TextRank formula
  return overlap / (Math.log(a.size + 1) + Math.log(b.size + 1))
}

function splitSentences(text: string): string[] {
  const sents: string[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    if (/^\[Page \d+\]/.test(t)) { sents.push(t); continue }
    sents.push(...t.split(/(?<=[.!?])\s+(?=[A-Z\[\(0-9])/).filter(s => s.length > 10))
  }
  return sents
}

export function compressTextRank(text: string, ratioTarget: number): string {
  const sentences = splitSentences(text)
  const n = sentences.length
  if (n <= 4) return text

  const tokens = sentences.map(tokenize)

  // Build similarity matrix (sparse — only non-zero edges)
  const graph: Map<number, Map<number, number>> = new Map()
  for (let i = 0; i < n; i++) {
    graph.set(i, new Map())
    for (let j = 0; j < n; j++) {
      if (i === j) continue
      const sim = similarity(tokens[i], tokens[j])
      if (sim > 0) graph.get(i)!.set(j, sim)
    }
  }

  // PageRank-style iteration (10 iterations, damping=0.85)
  const DAMPING = 0.85
  const ITERATIONS = 10
  let scores = new Array(n).fill(1.0 / n)

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const newScores = new Array(n).fill((1 - DAMPING) / n)
    for (let i = 0; i < n; i++) {
      const neighbours = graph.get(i)!
      const totalWeight = [...neighbours.values()].reduce((s, w) => s + w, 0)
      if (totalWeight === 0) continue
      for (const [j, w] of neighbours) {
        newScores[j] += DAMPING * scores[i] * (w / totalWeight)
      }
    }
    scores = newScores
  }

  const targetK = Math.max(3, Math.round(n * ratioTarget))
  const kept = sentences
    .map((sent, idx) => ({ sent, score: scores[idx], idx }))
    .sort((a, b) => b.score - a.score)
    .slice(0, targetK)
    .sort((a, b) => a.idx - b.idx)
    .map(s => s.sent)

  return kept.join('\n')
}
