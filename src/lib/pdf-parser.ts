/**
 * PDF text extraction — mirrors advancedRag/src/utils/pdfParser.js exactly.
 * Uses window.pdfjsLib loaded via CDN script tag in index.html (v3.4.120).
 */

declare const window: Window & { pdfjsLib: any }

function initPdfWorker() {
  if (typeof window !== 'undefined' && window.pdfjsLib && !window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js'
  }
}

export interface PdfChunk {
  pageNumber: number
  chunkIndex: number
  content: string
}

export interface PdfParseResult {
  chunks: PdfChunk[]
  numPages: number
  totalChars: number
}

const CHUNK_SIZE = 500
const OVERLAP = 100

function chunkText(text: string, pageNumber: number): PdfChunk[] {
  const out: PdfChunk[] = []
  let i = 0, idx = 0
  while (i < text.length) {
    const slice = text.slice(i, i + CHUNK_SIZE).trim()
    if (slice.length > 0) out.push({ pageNumber, chunkIndex: idx++, content: slice })
    i += CHUNK_SIZE - OVERLAP
  }
  return out
}

export async function parsePdf(arrayBuffer: ArrayBuffer): Promise<PdfParseResult> {
  initPdfWorker()

  if (!window.pdfjsLib) {
    throw new Error('PDF.js not loaded — check internet connection')
  }

  const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise
  const chunks: PdfChunk[] = []
  let totalChars = 0

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const textContent = await page.getTextContent()

    // Exact same extraction as advancedRag
    const text = textContent.items
      .map((item: any) => item.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()

    totalChars += text.length

    const pageChunks = chunkText(text, i)
    if (pageChunks.length === 0 && text.length > 0) {
      chunks.push({ pageNumber: i, chunkIndex: 0, content: text })
    } else {
      chunks.push(...pageChunks)
    }
  }

  return { chunks, numPages: pdf.numPages, totalChars }
}
