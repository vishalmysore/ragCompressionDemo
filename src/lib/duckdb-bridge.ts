import DuckWorker from '../workers/duckdb.worker.ts?worker'

let worker: Worker | null = null
let pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>()
let msgId = 0

function getWorker(): Worker {
  if (!worker) {
    worker = new DuckWorker()
    worker.onmessage = (e) => {
      const { id, ok, result, error } = e.data
      const p = pending.get(id)
      if (!p) return
      pending.delete(id)
      if (ok) p.resolve(result)
      else p.reject(new Error(error))
    }
  }
  return worker
}

function call(type: string, payload?: any): Promise<any> {
  const id = String(msgId++)
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    getWorker().postMessage({ id, type, payload })
  })
}

export const duckdb = {
  init: () => call('init'),
  query: (sql: string) => call('query', { sql }),
  insertPayload: (id: string, label: string, content: string, contentType: string, tokenCount: number) =>
    call('insertPayload', { id, label, content, contentType, tokenCount }),
  insertPdfChunks: (chunks: any[]) => call('insertPdfChunks', { chunks }),
  searchPdf: (query: string, topK = 3) => call('searchPdf', { query, topK }),
}
