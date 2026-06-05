import PdfWorker from '../workers/pdf.worker.ts?worker'

let worker: Worker | null = null
let pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>()
let msgId = 0

function getWorker(): Worker {
  if (!worker) {
    worker = new PdfWorker()
    worker.onmessage = (e) => {
      const { id, ok, chunks, numPages, error } = e.data
      const p = pending.get(id)
      if (!p) return
      pending.delete(id)
      if (ok) p.resolve({ chunks, numPages })
      else p.reject(new Error(error))
    }
  }
  return worker
}

export function extractPdf(arrayBuffer: ArrayBuffer): Promise<{ chunks: any[]; numPages: number }> {
  const id = String(msgId++)
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    getWorker().postMessage({ id, arrayBuffer }, [arrayBuffer])
  })
}
