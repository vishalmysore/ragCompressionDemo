import * as pdfjs from 'pdfjs-dist'
// Vite ?url import — Vite resolves and serves the worker file as a static asset
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl

const CHUNK_SIZE = 500
const OVERLAP = 100

function chunkText(text: string, pageNumber: number) {
  const chunks: { pageNumber: number; chunkIndex: number; content: string }[] = []
  if (!text.trim()) return chunks
  let i = 0
  let chunkIndex = 0
  while (i < text.length) {
    const slice = text.slice(i, i + CHUNK_SIZE)
    if (slice.trim().length > 20) {
      chunks.push({ pageNumber, chunkIndex, content: slice.trim() })
      chunkIndex++
    }
    i += CHUNK_SIZE - OVERLAP
  }
  return chunks
}

self.onmessage = async (e) => {
  const { id, arrayBuffer } = e.data
  try {
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) }).promise
    const allChunks: { pageNumber: number; chunkIndex: number; content: string }[] = []

    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p)
      const textContent = await page.getTextContent()

      const text = textContent.items
        .map((item: any) => {
          const s = item.str ?? item.text ?? ''
          return (item.hasEOL ? s + '\n' : s + ' ')
        })
        .join('')
        .replace(/\s{3,}/g, '  ')
        .trim()

      const pageChunks = chunkText(text, p)

      // Fallback: if page produced no chunks but had some text, use whole page as one chunk
      if (pageChunks.length === 0 && text.length > 20) {
        allChunks.push({ pageNumber: p, chunkIndex: 0, content: text })
      } else {
        allChunks.push(...pageChunks)
      }
    }

    self.postMessage({ id, ok: true, chunks: allChunks, numPages: pdf.numPages })
  } catch (err: any) {
    self.postMessage({ id, ok: false, error: err.message ?? String(err) })
  }
}
