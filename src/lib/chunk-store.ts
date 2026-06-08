// chunk-store.ts — lightweight in-memory replacement for DuckDB.
// DuckDB-WASM (~8 MB) was overkill here: we only ever do keyword LIKE searches
// over a handful of PDF chunks. A plain JS array is faster, simpler, and leaves
// WebGPU memory headroom for the LLM.

export interface PdfChunk {
  chunkId: string
  pageNumber: number
  chunkIndex: number
  content: string
  tokenCount: number
}

let _chunks: PdfChunk[] = []

export const chunkStore = {
  /** Replace all stored chunks (call before inserting a new PDF). */
  reset() {
    _chunks = []
  },

  /** Bulk-insert chunks. */
  insert(chunks: PdfChunk[]) {
    _chunks.push(...chunks)
  },

  count() {
    return _chunks.length
  },

  /**
   * Keyword search — scores each chunk by how many query terms appear in it,
   * then returns the top-K by score. Same logic as the old DuckDB LIKE query
   * but without the SQL round-trip.
   */
  search(query: string, topK = 5): PdfChunk[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.length) return []

    return _chunks
      .map(c => ({
        chunk: c,
        score: terms.filter(t => c.content.toLowerCase().includes(t)).length,
      }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(x => x.chunk)
  },
}
