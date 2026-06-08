import { useEffect, useState, useCallback, type ReactNode } from 'react'
import { chunkStore } from './lib/chunk-store.ts'
import { llmBridge, type ProgressEvent } from './lib/llm-bridge.ts'
import { parsePdf } from './lib/pdf-parser.ts'
import { countTokens } from './lib/tokenizer.ts'
import { compressContent, METHODS, type CompressionMethod } from './lib/headroom-engine/index.ts'

// Model IDs match advancedRag (proven to work); q4f32_1 for 1B, q4f16_1 for larger
const MODELS = [
  { id: 'Qwen2-0.5B-Instruct-q4f16_1-MLC',     label: 'Qwen2 0.5B ✓ recommended',   size: '~400 MB', safe: true  },
  { id: 'Llama-3.2-1B-Instruct-q4f32_1-MLC',  label: 'Llama 3.2 1B',               size: '~0.9 GB', safe: true  },
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',  label: 'Qwen 2.5 1.5B',              size: '~1.1 GB', safe: true  },
  { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',  label: '⚠ Llama 3.2 3B',            size: '~2 GB',   safe: false },
  { id: 'gemma-2-2b-it-q4f16_1-MLC',           label: '⚠ Gemma 2 2B',              size: '~1.5 GB', safe: false },
  { id: 'Phi-3.5-mini-instruct-q4f16_1-MLC',   label: '⚠ Phi-3.5 Mini',            size: '~2.2 GB', safe: false },
]

type ModelStatus = 'idle' | 'loading' | 'ready' | 'no-webgpu' | 'error'

const CATEGORY_COLORS: Record<string, string> = {
  baseline: 'text-gray-400',
  smart:    'text-cyan-400',
  classic:  'text-yellow-400',
  advanced: 'text-purple-400',
}

const DEFAULT_COLUMNS: [CompressionMethod, CompressionMethod, CompressionMethod] =
  ['none', 'headroom-smart', 'tfidf']

export default function App() {
  const [pdfStatus, setPdfStatus]         = useState<{msg:string;type:'idle'|'ok'|'err'|'info'}>({msg:'',type:'idle'})
  const [totalChunks, setTotalChunks]     = useState(0)
  const [selectedModel, setSelectedModel] = useState(MODELS[0].id)
  const [modelStatus, setModelStatus]     = useState<ModelStatus>('idle')
  const [modelProgress, setModelProgress] = useState('')

  const [question, setQuestion]     = useState('')
  const [rawContext, setRawContext]  = useState('')
  const [searching, setSearching]   = useState(false)

  // 3 independently configurable columns
  const [colMethods, setColMethods]       = useState<[CompressionMethod,CompressionMethod,CompressionMethod]>(DEFAULT_COLUMNS)
  const [colContexts, setColContexts]     = useState<[string,string,string]>(['','',''])
  const [colAnswers, setColAnswers]       = useState<[string,string,string]>(['','',''])
  const [colGenerating, setColGenerating] = useState<[boolean,boolean,boolean]>([false,false,false])

  // Sync modelStatus with llmBridge on mount (in case of hot-reload)
  useEffect(() => {
    const s = llmBridge.getStatus()
    if (s === 'ready') setModelStatus('ready')
  }, [])

  // ── PDF ─────────────────────────────────────────────────────────────────
  const onPdfFile = useCallback(async (file: File) => {
    setPdfStatus({msg:`Reading ${file.name}…`,type:'info'})
    setTotalChunks(0)
    setRawContext('')
    setColContexts(['','',''])
    setColAnswers(['','',''])
    try {
      const buf = await file.arrayBuffer()
      const { chunks, numPages, totalChars } = await parsePdf(buf)
      if (!chunks.length) {
        setPdfStatus({msg:`No text found in "${file.name}" — may be a scanned PDF.`,type:'err'})
        return
      }
      chunkStore.reset()
      chunkStore.insert(chunks.map((c, i) => ({
        chunkId:    `p${c.pageNumber}_c${i}`,
        pageNumber: c.pageNumber,
        chunkIndex: i,
        content:    c.content,
        tokenCount: countTokens(c.content),
      })))
      setTotalChunks(chunkStore.count())
      setPdfStatus({msg:`✓ "${file.name}" — ${chunkStore.count()} chunks · ${numPages} pages${totalChars < 200 ? ' (sparse)' : ''}`,type:'ok'})
    } catch (err: any) {
      setPdfStatus({msg:`Error: ${err.message}`,type:'err'})
    }
  }, [])

  // ── Model ────────────────────────────────────────────────────────────────
  const loadModel = useCallback(async () => {
    if (!(navigator as any).gpu) { setModelStatus('no-webgpu'); return }

    // Dispose previous model so the GPU worker starts clean
    llmBridge.dispose()
    setModelStatus('loading')
    setModelProgress('')

    try {
      await llmBridge.loadModel(selectedModel, (evt: ProgressEvent) => {
        switch (evt.type) {
          case 'device':
            setModelProgress('WebGPU adapter detected…')
            break
          case 'phase':
            setModelProgress(evt.note ?? (evt.phase === 'compile' ? 'Compiling shaders…' : 'Downloading…'))
            break
          case 'downloading':
            setModelProgress(`${evt.progress}% — ${evt.file}`)
            break
          case 'ready':
            setModelProgress('')
            break
          case 'error':
            setModelProgress(
              evt.deviceLost
                ? '⚠ GPU out of memory — try a smaller model.'
                : `Failed: ${evt.error}`
            )
            break
        }
      })
      setModelStatus('ready')
      setModelProgress('')
    } catch (err: any) {
      const msg: string = err?.message ?? String(err)
      const isDeviceLost = /disposed|device.?lost|device.?hung|DEVICE_HUNG|0x887A/i.test(msg)
      setModelStatus('idle')
      if (!modelProgress.startsWith('⚠')) {
        setModelProgress(isDeviceLost
          ? '⚠ GPU out of memory — try a smaller model.'
          : `Failed: ${msg}`)
      }
    }
  }, [selectedModel, modelProgress])

  // ── Build contexts for all 3 columns ─────────────────────────────────────
  const buildContexts = useCallback((raw: string, q: string, methods: typeof colMethods) => {
    return methods.map(method => {
      const cfg = {
        compressionRatioTarget: method === 'headroom-aggressive' ? 0.15 : 0.45,
        useEntropyPreservation: true,
        tokenBudget: 4000,
      }
      return compressContent(raw, cfg, q, method).compressed
    }) as [string,string,string]
  }, [])

  // ── Search RAG ────────────────────────────────────────────────────────────
  const searchRag = useCallback(async () => {
    if (!question.trim() || totalChunks === 0) return
    setSearching(true)
    setColAnswers(['','',''])
    setRawContext('')
    try {
      const results = chunkStore.search(question, 5)
      if (!results.length) return
      const raw = results.map(r => `[Page ${r.pageNumber}]\n${r.content}`).join('\n\n')
      setRawContext(raw)
      setColContexts(buildContexts(raw, question, colMethods))
    } finally {
      setSearching(false)
    }
  }, [question, totalChunks, colMethods, buildContexts])

  // Rebuild when column method changes
  useEffect(() => {
    if (rawContext) setColContexts(buildContexts(rawContext, question, colMethods))
  }, [colMethods, rawContext, question, buildContexts])

  // ── Ask LLM for one column ────────────────────────────────────────────────
  const askLlm = useCallback(async (col: 0|1|2) => {
    if (llmBridge.getStatus() !== 'ready' || !colContexts[col] || !question.trim()) return
    setColGenerating(g => { const n = [...g] as typeof g; n[col] = true; return n })
    setColAnswers(a => { const n = [...a] as typeof a; n[col] = ''; return n })
    try {
      const msgs = [
        { role: 'system', content: 'Answer based only on the provided context. Be concise.' },
        { role: 'user',   content: `Context:\n${colContexts[col]}\n\nQuestion: ${question}` },
      ]
      await llmBridge.generate(msgs, (_delta, full) => {
        setColAnswers(a => { const n = [...a] as typeof a; n[col] = full; return n })
      })
    } catch (err: any) {
      const msg: string = (err as Error).message ?? String(err)
      const isDeviceLost = /disposed|device.?lost|device.?hung|DEVICE_HUNG|0x887A/i.test(msg)
      if (isDeviceLost) {
        llmBridge.dispose()
        setModelStatus('idle')
        setColAnswers(['','',''])
        setModelProgress('⚠ GPU out of memory — reload a smaller model.')
      } else {
        setColAnswers(a => { const n = [...a] as typeof a; n[col] = `Error: ${msg}`; return n })
      }
    } finally {
      setColGenerating(g => { const n = [...g] as typeof g; n[col] = false; return n })
    }
  }, [colContexts, question])

  const rawTokens = countTokens(rawContext)

  return (
    <div className="h-screen bg-gray-950 text-gray-100 font-mono flex flex-col overflow-hidden">

      {/* Header */}
      <header className="px-4 py-2 border-b border-gray-800 bg-gray-900 flex items-center gap-3 shrink-0">
        <span className="text-cyan-400 font-black">◈ RAG Compression Demo</span>
        <span className="text-[10px] px-2 py-0.5 rounded border text-green-400 border-green-800">
          In-Memory ✓
        </span>
        <span className={`text-[10px] px-2 py-0.5 rounded border ${modelStatus==='ready'?'text-green-400 border-green-800':modelStatus==='loading'?'text-yellow-400 border-yellow-800':'text-gray-600 border-gray-700'}`}>
          {modelStatus==='ready'?`LLM ✓ ${MODELS.find(m=>m.id===selectedModel)?.label}`:modelStatus==='loading'?'LLM loading…':'LLM not loaded'}
        </span>
        {totalChunks > 0 && <span className="text-[10px] text-orange-400 border border-orange-800 px-2 py-0.5 rounded">{totalChunks} chunks</span>}
      </header>

      <div className="flex flex-1 overflow-hidden">

        {/* ── Left sidebar ─────────────────────────────────── */}
        <aside className="w-56 shrink-0 flex flex-col gap-3 p-3 border-r border-gray-800 overflow-y-auto bg-gray-900/30">

          {/* Step 1 */}
          <div>
            <SLabel n="1" color="cyan">Upload PDF</SLabel>
            <label className="mt-2 flex flex-col items-center justify-center h-14 border-2 border-dashed border-gray-700 hover:border-cyan-600 rounded cursor-pointer text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
              onDragOver={e => e.preventDefault()}
              onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f?.type === 'application/pdf') onPdfFile(f) }}>
              <span>📄 Drop PDF or <span className="text-cyan-400 underline">browse</span></span>
              <input type="file" accept=".pdf" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) onPdfFile(f); e.target.value = '' }} />
            </label>
            {pdfStatus.msg && (
              <div className={`mt-1 text-[9px] p-1.5 rounded leading-relaxed ${pdfStatus.type==='ok'?'text-green-400 bg-green-950/30 border border-green-800/40':pdfStatus.type==='err'?'text-red-400 bg-red-950/30 border border-red-800/40':'text-gray-400 bg-gray-800/60'}`}>
                {pdfStatus.msg}
              </div>
            )}
          </div>

          {/* Step 2 */}
          <div>
            <SLabel n="2" color="purple">Load LLM</SLabel>
            <select value={selectedModel} onChange={async e => {
              setSelectedModel(e.target.value)
              setModelStatus('idle')
              setModelProgress('')
              setColAnswers(['','',''])
              llmBridge.dispose()
            }}
              disabled={modelStatus === 'loading'}
              className="w-full mt-1.5 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-[10px] text-gray-200 focus:outline-none focus:border-purple-500 disabled:opacity-50">
              {MODELS.map(m => <option key={m.id} value={m.id}>{m.label} ({m.size})</option>)}
            </select>
            {!MODELS.find(m => m.id === selectedModel)?.safe && (
              <div className="mt-1 text-[9px] text-amber-400 bg-amber-950/30 border border-amber-800/40 rounded p-1.5">
                ⚠ {MODELS.find(m => m.id === selectedModel)?.size} — needs dedicated GPU with enough VRAM. If it crashes, switch to Qwen2 0.5B (~400 MB).
              </div>
            )}
            {modelStatus === 'no-webgpu' && <div className="text-[9px] text-amber-400 mt-1">WebGPU unavailable — Chrome 113+</div>}
            {modelStatus !== 'ready'
              ? <button onClick={loadModel} disabled={modelStatus === 'loading'}
                  className="mt-1.5 w-full py-1.5 bg-purple-800 hover:bg-purple-700 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded text-[10px] font-bold transition-colors">
                  {modelStatus === 'loading' ? 'Loading…' : 'Load Model'}
                </button>
              : <div className="mt-1.5 text-[9px] text-green-400 bg-green-950/30 border border-green-800/40 rounded p-1.5">✓ {MODELS.find(m => m.id === selectedModel)?.label} ready</div>
            }
            {modelProgress && modelStatus === 'loading' && <div className="mt-1 text-[9px] text-gray-500 break-words">{modelProgress}</div>}
            {modelProgress && modelStatus === 'idle' && modelProgress.startsWith('⚠') && (
              <div className="mt-1 text-[9px] text-amber-400 break-words">{modelProgress}</div>
            )}
          </div>

          {/* Legend */}
          <div className="border-t border-gray-800 pt-2">
            <div className="text-[9px] text-gray-500 uppercase font-bold mb-1.5">Techniques</div>
            {(['baseline','smart','classic','advanced'] as const).map(cat => (
              <div key={cat} className="flex items-center gap-1.5 mb-1">
                <span className={`text-[9px] font-bold ${CATEGORY_COLORS[cat]} w-16`}>{cat}</span>
                <span className="text-[9px] text-gray-600">
                  {cat==='baseline'?'None / Truncation':cat==='smart'?'Keyword + Kneedle K':cat==='classic'?'TF-IDF / TextRank':'Stopwords / SimHash'}
                </span>
              </div>
            ))}
          </div>
        </aside>

        {/* ── Main ─────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col overflow-hidden">

          {/* Step 3 */}
          <div className="px-4 py-2 border-b border-gray-800 bg-gray-900/40 shrink-0">
            <SLabel n="3" color="blue">Ask a question — BM25 searches PDF chunks</SLabel>
            <div className="flex gap-2 mt-1.5">
              <input value={question} onChange={e => setQuestion(e.target.value)} onKeyDown={e => e.key === 'Enter' && searchRag()}
                placeholder={totalChunks > 0 ? 'e.g. What are the main findings?' : 'Upload a PDF first…'}
                disabled={totalChunks === 0}
                className="flex-1 bg-gray-800 border border-gray-600 rounded px-3 py-1.5 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500 disabled:opacity-40" />
              <button onClick={searchRag} disabled={searching || !question.trim() || totalChunks === 0}
                className="px-4 py-1.5 bg-blue-700 hover:bg-blue-600 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded text-xs font-bold transition-colors">
                {searching ? 'Searching…' : '🔍 Search'}
              </button>
            </div>
          </div>

          {/* Token summary bar */}
          {rawContext && (
            <div className="px-4 py-1.5 border-b border-gray-800 flex items-center gap-4 text-[10px] bg-gray-900/20 shrink-0 flex-wrap">
              <span className="text-gray-500">Raw: <span className="text-red-400 font-bold">{rawTokens.toLocaleString()} tok</span></span>
              {colMethods.map((m, i) => {
                const tok = countTokens(colContexts[i] || '')
                const info = METHODS.find(x => x.key === m)!
                const pct = rawTokens > 0 ? Math.round((1 - tok / rawTokens) * 100) : 0
                return (
                  <span key={i} className="text-gray-500">
                    Col {i+1} ({info.label}): <span className={`font-bold ${CATEGORY_COLORS[info.category]}`}>{tok.toLocaleString()} tok</span>
                    {pct > 0 && <span className="text-green-500 ml-1">-{pct}%</span>}
                  </span>
                )
              })}
            </div>
          )}

          {/* 3 columns */}
          <div className="flex-1 flex overflow-hidden">
            {([0,1,2] as const).map(col => {
              const method = colMethods[col]
              const info = METHODS.find(x => x.key === method)!
              const tok = countTokens(colContexts[col] || '')
              const pct = rawTokens > 0 ? Math.round((1 - tok / rawTokens) * 100) : 0
              const canAsk = modelStatus === 'ready' && !!colContexts[col] && !!question.trim()

              return (
                <div key={col} className={`flex-1 flex flex-col overflow-hidden ${col < 2 ? 'border-r border-gray-800' : ''}`}>

                  {/* Column header — method selector */}
                  <div className="px-2 py-1.5 border-b border-gray-800 bg-gray-900/40 shrink-0">
                    <select value={method}
                      onChange={e => setColMethods(prev => { const n = [...prev] as typeof prev; n[col] = e.target.value as CompressionMethod; return n })}
                      className="w-full bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-[10px] text-gray-200 focus:outline-none focus:border-cyan-600">
                      {(['baseline','smart','classic','advanced'] as const).map(cat => (
                        <optgroup key={cat} label={`── ${cat==='smart'?'SMART COMPRESS':cat.toUpperCase()} ──`}>
                          {METHODS.filter(m => m.category === cat).map(m => (
                            <option key={m.key} value={m.key}>{m.label}</option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    <div className="flex items-center justify-between mt-1">
                      <span className={`text-[9px] ${CATEGORY_COLORS[info.category]}`}>{info.desc}</span>
                      {tok > 0 && (
                        <span className="text-[9px] font-bold text-gray-300">
                          {tok.toLocaleString()} tok {pct > 0 && <span className="text-green-400">-{pct}%</span>}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Context preview */}
                  <div className="flex-1 overflow-y-auto p-2 border-b border-gray-800" style={{maxHeight:'40%'}}>
                    {colContexts[col] ? (
                      <pre className="text-[10px] text-gray-400 leading-relaxed whitespace-pre-wrap">{colContexts[col]}</pre>
                    ) : (
                      <div className="text-gray-600 text-[10px] text-center mt-4">
                        {totalChunks > 0 ? 'Search to see context' : 'Upload PDF first'}
                      </div>
                    )}
                  </div>

                  {/* Ask button + answer */}
                  <div className="flex flex-col flex-1 overflow-hidden">
                    <div className="px-2 py-1.5 border-b border-gray-800 shrink-0">
                      <button onClick={() => askLlm(col)} disabled={!canAsk || colGenerating[col]}
                        className="w-full py-1 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-600 text-white rounded text-[10px] font-bold transition-colors">
                        {colGenerating[col] ? 'Generating…' : canAsk ? `Ask (${tok.toLocaleString()} tok)` : modelStatus !== 'ready' ? 'Load model first' : 'Search first'}
                      </button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-2">
                      {colAnswers[col]
                        ? <p className="text-[11px] text-gray-200 leading-relaxed whitespace-pre-wrap">{colAnswers[col]}</p>
                        : <p className="text-gray-600 text-[9px] text-center mt-4">{modelStatus === 'ready' ? 'Click Ask' : 'Load model first'}</p>
                      }
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

function SLabel({n,color,children}:{n:string;color:string;children:ReactNode}) {
  const bg: Record<string,string> = {
    cyan:   'bg-cyan-900/60 border-cyan-800 text-cyan-400',
    purple: 'bg-purple-900/60 border-purple-800 text-purple-400',
    blue:   'bg-blue-900/60 border-blue-800 text-blue-400',
  }
  return (
    <div className="flex items-center gap-2">
      <span className={`text-[9px] font-black px-1.5 py-0.5 rounded border ${bg[color]}`}>STEP {n}</span>
      <span className="text-[10px] font-bold text-gray-300">{children}</span>
    </div>
  )
}
