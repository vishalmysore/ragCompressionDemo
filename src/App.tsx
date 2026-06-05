import React, { useEffect, useState, useCallback, useRef } from 'react'
import { duckdb } from './lib/duckdb-bridge.ts'
import { parsePdf } from './lib/pdf-parser.ts'
import { countTokens } from './lib/tokenizer.ts'
import { compressContent } from './lib/headroom-engine/index.ts'

const MODELS = [
  { id: 'Qwen2-0.5B-Instruct-q4f16_1-MLC',   label: 'Qwen2 0.5B',   size: '~400 MB' },
  { id: 'Qwen2-1.5B-Instruct-q4f16_1-MLC',   label: 'Qwen2 1.5B',   size: '~900 MB' },
  { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 1B', size: '~700 MB' },
  { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 3B', size: '~2 GB'   },
  { id: 'Phi-3.5-mini-instruct-q4f16_1-MLC',  label: 'Phi-3.5 Mini', size: '~2.2 GB' },
  { id: 'gemma-2-2b-it-q4f16_1-MLC',          label: 'Gemma 2 2B',   size: '~1.5 GB' },
]

type ModelStatus = 'idle' | 'loading' | 'ready' | 'no-webgpu'

const MODES = [
  { key: 'none',       label: 'No Compression',  ratio: 1.0,  color: 'red',    desc: 'Full context' },
  { key: 'smart',      label: 'Smart Compress',   ratio: 0.5,  color: 'yellow', desc: '~40-60% reduction' },
  { key: 'aggressive', label: 'Aggressive',       ratio: 0.15, color: 'green',  desc: '~70-85% reduction' },
] as const
type ModeKey = typeof MODES[number]['key']

export default function App() {
  const [dbReady, setDbReady]           = useState(false)
  const [pdfStatus, setPdfStatus]       = useState<{ msg: string; type: 'idle'|'ok'|'err'|'info' }>({ msg: '', type: 'idle' })
  const [totalChunks, setTotalChunks]   = useState(0)
  const [selectedModel, setSelectedModel] = useState(MODELS[0].id)
  const [modelStatus, setModelStatus]   = useState<ModelStatus>('idle')
  const [modelProgress, setModelProgress] = useState('')
  const engineRef = useRef<any>(null)

  const [question, setQuestion]     = useState('')
  const [rawChunks, setRawChunks]   = useState<{pageNumber:number;content:string;tokens:number}[]>([])
  const [rawContext, setRawContext]  = useState('')
  const [contexts, setContexts]     = useState<Record<ModeKey, string>>({ none: '', smart: '', aggressive: '' })
  const [answers, setAnswers]       = useState<Record<ModeKey, string>>({ none: '', smart: '', aggressive: '' })
  const [generating, setGenerating] = useState<Record<ModeKey, boolean>>({ none: false, smart: false, aggressive: false })
  const [searching, setSearching]   = useState(false)
  const [activeContext, setActiveContext] = useState<ModeKey>('smart')

  useEffect(() => { duckdb.init().then(() => setDbReady(true)).catch(console.error) }, [])

  // ── PDF ────────────────────────────────────────────────────────────────
  const onPdfFile = useCallback(async (file: File) => {
    setPdfStatus({ msg: `Reading ${file.name}…`, type: 'info' })
    setTotalChunks(0); setRawChunks([]); setRawContext('')
    setContexts({ none: '', smart: '', aggressive: '' })
    setAnswers({ none: '', smart: '', aggressive: '' })
    try {
      const buf = await file.arrayBuffer()
      const { chunks, numPages, totalChars } = await parsePdf(buf)
      if (chunks.length === 0) { setPdfStatus({ msg: `No text found in "${file.name}" — may be a scanned image PDF.`, type: 'err' }); return }
      setPdfStatus({ msg: `Storing ${chunks.length} chunks…`, type: 'info' })
      await duckdb.query('DELETE FROM pdf_context')
      await duckdb.insertPdfChunks(chunks.map((c, i) => ({
        chunkId: `p${c.pageNumber}_c${i}`, pageNumber: c.pageNumber,
        chunkIndex: i, content: c.content, tokenCount: countTokens(c.content),
      })))
      setTotalChunks(chunks.length)
      const warn = totalChars < 200 ? ' (sparse text)' : ''
      setPdfStatus({ msg: `✓ "${file.name}" — ${chunks.length} chunks · ${numPages} pages${warn}`, type: 'ok' })
    } catch (err: any) { setPdfStatus({ msg: `Error: ${err.message}`, type: 'err' }) }
  }, [])

  // ── Model ──────────────────────────────────────────────────────────────
  const loadModel = useCallback(async () => {
    if (!(navigator as any).gpu) { setModelStatus('no-webgpu'); return }
    setModelStatus('loading'); engineRef.current = null
    try {
      const { CreateMLCEngine } = await import('@mlc-ai/web-llm')
      engineRef.current = await CreateMLCEngine(selectedModel, {
        initProgressCallback: (p: any) => setModelProgress(`${(p.progress * 100).toFixed(0)}% — ${p.text ?? ''}`),
      })
      setModelStatus('ready'); setModelProgress('')
    } catch (err: any) { setModelStatus('idle'); setModelProgress(`Failed: ${err.message}`) }
  }, [selectedModel])

  // ── Build contexts for all 3 modes ─────────────────────────────────────
  const buildContexts = useCallback((raw: string, q: string) => {
    const result: Record<ModeKey, string> = { none: raw, smart: '', aggressive: '' }
    for (const mode of MODES) {
      if (mode.key === 'none') continue
      result[mode.key] = compressContent(raw, {
        compressionRatioTarget: mode.ratio,
        useEntropyPreservation: true,
        tokenBudget: 4000,
      }, q).compressed
    }
    return result
  }, [])

  // ── Search RAG ─────────────────────────────────────────────────────────
  const searchRag = useCallback(async () => {
    if (!question.trim() || !dbReady) return
    setSearching(true)
    setAnswers({ none: '', smart: '', aggressive: '' })
    setRawChunks([]); setRawContext('')
    try {
      const results = await duckdb.searchPdf(question, 5)
      if (!results.length) { setSearching(false); return }
      const chunks = results.map((r: any) => ({ pageNumber: r.page_number, content: r.content, tokens: countTokens(r.content) }))
      setRawChunks(chunks)
      const raw = chunks.map((c: {pageNumber:number;content:string;tokens:number}) => `[Page ${c.pageNumber}]\n${c.content}`).join('\n\n')
      setRawContext(raw)
      setContexts(buildContexts(raw, question))
    } finally { setSearching(false) }
  }, [question, dbReady, buildContexts])

  // Rebuild contexts when question changes (after search)
  useEffect(() => {
    if (rawContext) setContexts(buildContexts(rawContext, question))
  }, [rawContext, question, buildContexts])

  // ── Ask LLM for one mode ───────────────────────────────────────────────
  const askLlm = useCallback(async (mode: ModeKey) => {
    if (!engineRef.current || !contexts[mode] || !question.trim()) return
    setGenerating(g => ({ ...g, [mode]: true }))
    setAnswers(a => ({ ...a, [mode]: '' }))
    try {
      const msgs = [
        { role: 'system', content: 'Answer based only on the provided context. Be concise.' },
        { role: 'user', content: `Context:\n${contexts[mode]}\n\nQuestion: ${question}` },
      ]
      const stream = await engineRef.current.chat.completions.create({ messages: msgs, stream: true, max_tokens: 512 })
      let full = ''
      for await (const chunk of stream) { full += chunk.choices[0]?.delta?.content ?? ''; setAnswers(a => ({ ...a, [mode]: full })) }
    } catch (err: any) { setAnswers(a => ({ ...a, [mode]: `Error: ${err.message}` })) }
    finally { setGenerating(g => ({ ...g, [mode]: false })) }
  }, [contexts, question])

  const rawTokens = countTokens(rawContext)

  return (
    <div className="h-screen bg-gray-950 text-gray-100 font-mono flex flex-col overflow-hidden">

      {/* Header */}
      <header className="px-4 py-2.5 border-b border-gray-800 bg-gray-900 flex items-center gap-3 shrink-0">
        <span className="text-cyan-400 font-black">◈ RAG Compression Demo</span>
        <span className={`text-[10px] px-2 py-0.5 rounded border ${dbReady ? 'text-green-400 border-green-800' : 'text-yellow-400 border-yellow-800'}`}>DuckDB {dbReady ? '✓' : '…'}</span>
        <span className={`text-[10px] px-2 py-0.5 rounded border ${modelStatus === 'ready' ? 'text-green-400 border-green-800' : modelStatus === 'loading' ? 'text-yellow-400 border-yellow-800' : 'text-gray-600 border-gray-700'}`}>
          {modelStatus === 'ready' ? `LLM ✓ ${MODELS.find(m=>m.id===selectedModel)?.label}` : modelStatus === 'loading' ? 'LLM loading…' : 'LLM not loaded'}
        </span>
        {totalChunks > 0 && <span className="text-[10px] text-orange-400 border border-orange-800 px-2 py-0.5 rounded">{totalChunks} chunks</span>}
      </header>

      <div className="flex flex-1 overflow-hidden">

        {/* ── Left sidebar ─────────────────────────────────── */}
        <aside className="w-60 shrink-0 flex flex-col gap-4 p-3 border-r border-gray-800 overflow-y-auto bg-gray-900/30">

          {/* Step 1 */}
          <div>
            <StepLabel n="1" color="cyan">Upload PDF</StepLabel>
            <label className="flex flex-col items-center justify-center h-16 border-2 border-dashed border-gray-700 hover:border-cyan-600 rounded-lg cursor-pointer text-[11px] text-gray-500 hover:text-gray-300 transition-colors mt-2"
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f?.type === 'application/pdf') onPdfFile(f) }}>
              <span className="text-lg">📄</span>
              <span>Drop PDF or <span className="text-cyan-400 underline">browse</span></span>
              <input type="file" accept=".pdf" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) onPdfFile(f); e.target.value = '' }} />
            </label>
            {pdfStatus.msg && (
              <div className={`mt-2 text-[10px] p-1.5 rounded leading-relaxed ${pdfStatus.type==='ok' ? 'text-green-400 bg-green-950/30 border border-green-800/40' : pdfStatus.type==='err' ? 'text-red-400 bg-red-950/30 border border-red-800/40' : 'text-gray-400 bg-gray-800/60'}`}>
                {pdfStatus.msg}
              </div>
            )}
          </div>

          {/* Step 2 */}
          <div>
            <StepLabel n="2" color="purple">Load LLM</StepLabel>
            <select value={selectedModel} onChange={e => { setSelectedModel(e.target.value); setModelStatus('idle') }}
              disabled={modelStatus==='loading'}
              className="w-full mt-2 bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 mb-2 focus:outline-none focus:border-purple-500 disabled:opacity-50">
              {MODELS.map(m => <option key={m.id} value={m.id}>{m.label} ({m.size})</option>)}
            </select>
            {modelStatus==='no-webgpu' && <div className="text-[10px] text-amber-400 bg-amber-950/30 border border-amber-700/40 rounded p-1.5 mb-2">WebGPU not available — use Chrome 113+</div>}
            {modelStatus!=='ready'
              ? <button onClick={loadModel} disabled={modelStatus==='loading'} className="w-full py-1.5 bg-purple-800 hover:bg-purple-700 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded text-xs font-bold transition-colors">
                  {modelStatus==='loading' ? 'Loading…' : 'Load Model'}
                </button>
              : <div className="text-[10px] text-green-400 bg-green-950/30 border border-green-800/40 rounded p-1.5">✓ {MODELS.find(m=>m.id===selectedModel)?.label} ready</div>
            }
            {modelProgress && modelStatus==='loading' && <div className="mt-1 text-[10px] text-gray-500 break-words">{modelProgress}</div>}
          </div>
        </aside>

        {/* ── Main area ─────────────────────────────────────── */}
        <div className="flex-1 flex flex-col overflow-hidden">

          {/* Step 3 — Question */}
          <div className="px-4 py-2.5 border-b border-gray-800 bg-gray-900/40 shrink-0">
            <StepLabel n="3" color="blue">Ask a question — BM25 searches your PDF chunks</StepLabel>
            <div className="flex gap-2 mt-2">
              <input value={question} onChange={e => setQuestion(e.target.value)} onKeyDown={e => e.key==='Enter' && searchRag()}
                placeholder={totalChunks > 0 ? 'e.g. What are the main symptoms?' : 'Upload a PDF first…'}
                disabled={totalChunks===0}
                className="flex-1 bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500 disabled:opacity-40" />
              <button onClick={searchRag} disabled={searching || !question.trim() || totalChunks===0}
                className="px-4 py-1.5 bg-blue-700 hover:bg-blue-600 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded text-xs font-bold whitespace-nowrap transition-colors">
                {searching ? 'Searching…' : '🔍 Search'}
              </button>
            </div>
          </div>

          {/* Context tab selector + token bar */}
          {rawContext && (
            <div className="px-4 py-2 border-b border-gray-800 bg-gray-900/20 shrink-0 flex items-center gap-3 text-[11px]">
              <span className="text-gray-500">View context:</span>
              {MODES.map(m => {
                const tok = countTokens(contexts[m.key] || '')
                return (
                  <button key={m.key} onClick={() => setActiveContext(m.key)}
                    className={`px-2 py-0.5 rounded border text-[10px] font-bold transition-colors ${activeContext===m.key ? 'border-cyan-600 bg-cyan-900/40 text-cyan-300' : 'border-gray-700 text-gray-500 hover:border-gray-500'}`}>
                    {m.label}: <span className={activeContext===m.key ? 'text-white' : ''}>{tok.toLocaleString()} tok</span>
                  </button>
                )
              })}
              {rawTokens > 0 && (() => {
                const aggTok = countTokens(contexts.aggressive || '')
                const saved = Math.round((1 - aggTok/rawTokens)*100)
                return <span className="ml-auto text-green-400 font-bold">max savings: -{saved}%</span>
              })()}
            </div>
          )}

          {/* Split: context view | 3 answer columns */}
          <div className="flex-1 flex overflow-hidden">

            {/* Context panel (left half) */}
            <div className="flex-1 flex flex-col border-r border-gray-800 overflow-hidden">
              <div className="px-3 py-1.5 border-b border-gray-800 bg-gray-900/30 flex items-center gap-2 shrink-0">
                <span className="text-[10px] text-gray-500 uppercase font-bold tracking-wider">
                  {MODES.find(m=>m.key===activeContext)?.label} — Context
                </span>
                <span className={`ml-auto text-[10px] font-bold ${activeContext==='none' ? 'text-red-400' : 'text-green-400'}`}>
                  {countTokens(contexts[activeContext] || '').toLocaleString()} tokens
                </span>
              </div>
              <div className="flex-1 overflow-y-auto p-3">
                {activeContext === 'none' && rawChunks.length > 0 ? (
                  <div className="space-y-2">
                    {rawChunks.map((c,i) => (
                      <div key={i} className="border border-gray-800 rounded p-2 bg-gray-900/20">
                        <div className="text-[9px] text-gray-600 mb-1">Page {c.pageNumber} · {c.tokens} tok</div>
                        <div className="text-[11px] text-gray-300 leading-relaxed whitespace-pre-wrap">{c.content}</div>
                      </div>
                    ))}
                  </div>
                ) : contexts[activeContext] ? (
                  <pre className="text-[11px] text-gray-300 leading-relaxed whitespace-pre-wrap">{contexts[activeContext]}</pre>
                ) : (
                  <div className="text-gray-600 text-xs text-center mt-10">
                    {totalChunks > 0 ? 'Ask a question to retrieve chunks' : 'Upload a PDF to get started'}
                  </div>
                )}
              </div>
            </div>

            {/* Step 5 — 3 answer columns */}
            <div className="w-[600px] shrink-0 flex flex-col overflow-hidden">
              <div className="px-3 py-1.5 border-b border-gray-800 bg-gray-900/30 shrink-0 flex items-center gap-2">
                <StepLabel n="5" color="green">LLM Answers — Compare All 3 Modes</StepLabel>
              </div>
              <div className="flex-1 flex overflow-hidden">
                {MODES.map((mode, i) => {
                  const tok = countTokens(contexts[mode.key] || '')
                  const isGenerating = generating[mode.key]
                  const ans = answers[mode.key]
                  const canAsk = modelStatus==='ready' && !!contexts[mode.key] && !!question.trim()
                  const colors = { none: 'red', smart: 'yellow', aggressive: 'green' } as const
                  const borderColor = { red: 'border-red-900/40', yellow: 'border-yellow-900/40', green: 'border-green-900/40' }[colors[mode.key]]
                  const btnColor = { red: 'bg-red-900 hover:bg-red-800', yellow: 'bg-yellow-800 hover:bg-yellow-700', green: 'bg-green-800 hover:bg-green-700' }[colors[mode.key]]
                  const tokColor = { red: 'text-red-400', yellow: 'text-yellow-400', green: 'text-green-400' }[colors[mode.key]]

                  return (
                    <div key={mode.key} className={`flex-1 flex flex-col ${i < 2 ? 'border-r border-gray-800' : ''} overflow-hidden`}>
                      {/* Column header */}
                      <div className={`px-2 py-1.5 border-b ${borderColor} bg-gray-900/20 shrink-0`}>
                        <div className="text-[10px] font-bold text-gray-300">{mode.label}</div>
                        <div className={`text-[10px] font-black ${tokColor}`}>{tok.toLocaleString()} tokens</div>
                        {mode.key !== 'none' && rawTokens > 0 && (
                          <div className="text-[9px] text-gray-600">-{Math.round((1-tok/rawTokens)*100)}% vs raw</div>
                        )}
                      </div>
                      {/* Ask button */}
                      <div className="px-2 py-1.5 border-b border-gray-800 shrink-0">
                        <button onClick={() => askLlm(mode.key)} disabled={!canAsk || isGenerating}
                          className={`w-full py-1 ${btnColor} disabled:bg-gray-700 disabled:text-gray-500 text-white rounded text-[10px] font-bold transition-colors`}>
                          {isGenerating ? 'Generating…' : canAsk ? `Ask (${tok.toLocaleString()} tok)` : modelStatus!=='ready' ? 'Load model first' : 'Search first'}
                        </button>
                      </div>
                      {/* Answer */}
                      <div className="flex-1 overflow-y-auto p-2">
                        {ans
                          ? <p className="text-[11px] text-gray-200 leading-relaxed whitespace-pre-wrap">{ans}</p>
                          : <p className="text-gray-600 text-[10px] text-center mt-6">{modelStatus==='ready' ? 'Click Ask to generate' : 'Load model first'}</p>
                        }
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  )
}

function StepLabel({ n, color, children }: { n: string; color: string; children: React.ReactNode }) {
  const bg: Record<string,string> = { cyan: 'bg-cyan-900/60 border-cyan-800 text-cyan-400', purple: 'bg-purple-900/60 border-purple-800 text-purple-400', blue: 'bg-blue-900/60 border-blue-800 text-blue-400', green: 'bg-green-900/60 border-green-800 text-green-400', orange: 'bg-orange-900/60 border-orange-800 text-orange-400' }
  return (
    <div className="flex items-center gap-2">
      <span className={`text-[9px] font-black px-1.5 py-0.5 rounded border ${bg[color]}`}>STEP {n}</span>
      <span className="text-xs font-bold text-gray-300">{children}</span>
    </div>
  )
}
