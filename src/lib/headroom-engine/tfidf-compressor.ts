/**
 * TF-IDF sentence scoring compressor.
 * Scores each sentence by term-frequency × inverse-document-frequency
 * against the query terms. Classic NLP baseline — no model needed.
 */

const STOPWORDS = new Set(['the','a','an','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','could','should','may','might',
  'of','in','on','at','to','for','with','by','from','as','into','about','through',
  'and','or','but','not','it','its','this','that','these','those','they','their',
  'he','she','we','you','i','my','your','his','her','our','can','also','so'])

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !STOPWORDS.has(w))
}

function splitSentences(text: string): string[] {
  const sents: string[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    if (/^\[Page \d+\]/.test(t)) { sents.push(t); continue }
    const parts = t.split(/(?<=[.!?])\s+(?=[A-Z\[\(0-9])/)
    sents.push(...parts.filter(s => s.length > 10))
  }
  return sents
}

export function compressTfIdf(text: string, ratioTarget: number, query: string): string {
  const sentences = splitSentences(text)
  const n = sentences.length
  if (n <= 4) return text

  const queryTerms = tokenize(query)
  if (queryTerms.length === 0) return text

  // Build IDF: log(N / df) for each query term
  const df: Record<string, number> = {}
  for (const sent of sentences) {
    const words = new Set(tokenize(sent))
    for (const qt of queryTerms) {
      if (words.has(qt)) df[qt] = (df[qt] ?? 0) + 1
    }
  }
  const idf: Record<string, number> = {}
  for (const qt of queryTerms) {
    idf[qt] = Math.log((n + 1) / ((df[qt] ?? 0) + 1)) + 1
  }

  // Score each sentence: sum of TF × IDF for query terms
  const scored = sentences.map((sent, idx) => {
    const words = tokenize(sent)
    const len = Math.max(words.length, 1)
    let score = 0
    for (const qt of queryTerms) {
      const tf = words.filter(w => w === qt).length / len
      score += tf * (idf[qt] ?? 1)
    }
    // Boost [Page N] markers
    if (/^\[Page \d+\]/.test(sent)) score = Math.max(score, 0.1)
    return { sent, score, idx }
  })

  const targetK = Math.max(3, Math.round(n * ratioTarget))
  const kept = scored.slice().sort((a, b) => b.score - a.score)
    .slice(0, targetK)
    .sort((a, b) => a.idx - b.idx)
    .map(s => s.sent)

  return kept.join('\n')
}
