import React, { useCallback, useState } from 'react'
import { extractPdf } from '../lib/pdf-bridge.ts'
import { duckdb } from '../lib/duckdb-bridge.ts'
import { countTokens } from '../lib/tokenizer.ts'

export interface PdfMeta { chunkCount: number; pageCount: number; fileName: string }

interface Props {
  onChunksLoaded: (preview: string, meta: PdfMeta) => void
}

export function PdfUpload({ onChunksLoaded }: Props) {
  const [status, setStatus] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [loading, setLoading] = useState(false)

  const processFile = useCallback(async (file: File) => {
    setLoading(true)
    setStatus(`Extracting text from ${file.name}…`)
    try {
      const buf = await file.arrayBuffer()
      const { chunks, numPages } = await extractPdf(buf)

      setStatus(`Extracted ${chunks.length} chunks from ${numPages} pages — inserting into DuckDB…`)

      const dbChunks = chunks.map((c, i) => ({
        chunkId: `${file.name.replace(/[^a-z0-9]/gi, '_')}__p${c.pageNumber}__c${i}`,
        pageNumber: c.pageNumber,
        chunkIndex: i,
        content: c.content,
        tokenCount: countTokens(c.content),
      }))

      await duckdb.insertPdfChunks(dbChunks)

      // Preview: first 5 chunks
      const preview = dbChunks.slice(0, 5)
        .map(c => `[Page ${c.pageNumber} · Chunk ${c.chunkIndex}]\n${c.content}`)
        .join('\n\n---\n\n')

      const meta: PdfMeta = { chunkCount: chunks.length, pageCount: numPages, fileName: file.name }
      setStatus(`✓ ${chunks.length} chunks · ${numPages} pages · showing first 5`)
      onChunksLoaded(preview, meta)
    } catch (err: any) {
      setStatus(`Error: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }, [onChunksLoaded])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file?.type === 'application/pdf') processFile(file)
  }, [processFile])

  const onInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) processFile(file)
    e.target.value = ''
  }, [processFile])

  return (
    <div className="flex flex-col gap-2">
      <label
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`flex flex-col items-center justify-center h-16 rounded-lg border-2 border-dashed cursor-pointer transition-colors text-xs
          ${loading ? 'border-cyan-700 bg-cyan-950/20 text-cyan-400 animate-pulse' :
            dragging ? 'border-cyan-500 bg-cyan-950/30 text-cyan-300' :
            'border-gray-600 hover:border-gray-500 text-gray-500'}`}
      >
        <span className="text-base">{loading ? '⏳' : '📄'}</span>
        <span>{loading ? 'Processing…' : 'Drop PDF or '}<span className="text-cyan-400 underline">browse</span></span>
        <input type="file" accept=".pdf" onChange={onInput} className="hidden" disabled={loading} />
      </label>

      {status && (
        <div className={`text-[10px] rounded p-1.5 break-words leading-relaxed
          ${status.startsWith('✓') ? 'text-green-400 bg-green-950/30 border border-green-800/40' :
            status.startsWith('Error') ? 'text-red-400 bg-red-950/30 border border-red-800/40' :
            'text-gray-400 bg-gray-800'}`}>
          {status}
        </div>
      )}
    </div>
  )
}
