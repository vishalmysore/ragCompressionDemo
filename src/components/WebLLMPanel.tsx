import React, { useState, useCallback, useRef } from 'react'
import { ccrKeys, ccrRetrieve } from '../lib/headroom.ts'

interface Props {
  compressedContent: string | null
  onTtft: (ms: number) => void
}

type LLMStatus = 'idle' | 'loading-model' | 'generating' | 'done' | 'error' | 'no-webgpu'

const CCR_TOOL_RE = /ccr_retrieve\(["']([a-f0-9]+)["']\)/i

export function WebLLMPanel({ compressedContent, onTtft }: Props) {
  const [status, setStatus] = useState<LLMStatus>('idle')
  const [output, setOutput] = useState('')
  const [ccrEvent, setCcrEvent] = useState<{ hash: string; retrieved: string } | null>(null)
  const [prompt, setPrompt] = useState('Summarise the key findings and flag any errors in this data.')
  const engineRef = useRef<any>(null)
  const t0Ref = useRef<number>(0)

  const checkWebGPU = async () => {
    const nav = navigator as any
    if (!nav.gpu) {
      setStatus('no-webgpu')
      return false
    }
    return true
  }

  const run = useCallback(async () => {
    if (!compressedContent) return
    if (!(await checkWebGPU())) return

    setStatus('loading-model')
    setOutput('')
    setCcrEvent(null)
    t0Ref.current = performance.now()

    try {
      // Dynamic import to avoid bundling WebLLM eagerly
      const { CreateMLCEngine } = await import('@mlc-ai/web-llm')

      if (!engineRef.current) {
        engineRef.current = await CreateMLCEngine('Qwen2-0.5B-Instruct-q4f16_1-MLC', {
          initProgressCallback: (p: any) => {
            setOutput(`Loading model… ${(p.progress * 100).toFixed(0)}%`)
          },
        })
      }

      setStatus('generating')
      const ttft = performance.now() - t0Ref.current
      onTtft(ttft)

      const messages = [
        {
          role: 'system',
          content: `You are a helpful assistant. You have access to the tool ccr_retrieve(hash) to look up additional context if needed. Available CCR hashes: ${ccrKeys().join(', ') || 'none'}.`,
        },
        { role: 'user', content: `${prompt}\n\n---CONTEXT---\n${compressedContent}` },
      ]

      const stream = await engineRef.current.chat.completions.create({
        messages,
        stream: true,
        max_tokens: 512,
      })

      let full = ''
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? ''
        full += delta
        setOutput(full)

        // CCR tool interception
        const match = CCR_TOOL_RE.exec(full)
        if (match && !ccrEvent) {
          const hash = match[1]
          const retrieved = ccrRetrieve(hash)
          if (retrieved) {
            setCcrEvent({ hash, retrieved: retrieved.slice(0, 300) + '…' })
          }
        }
      }

      setStatus('done')
    } catch (err: any) {
      setOutput(`Error: ${err.message}`)
      setStatus('error')
    }
  }, [compressedContent, prompt, onTtft, ccrEvent])

  return (
    <div className="flex flex-col gap-3 p-3 bg-gray-900 rounded-lg border border-gray-700 text-xs">
      <div className="flex items-center gap-2">
        <div className="text-gray-400 font-semibold uppercase tracking-widest text-[10px]">LLM Agent (WebGPU)</div>
        <span className="text-[9px] px-1.5 py-0.5 bg-blue-900/50 border border-blue-700 text-blue-300 rounded">Qwen2-0.5B</span>
        <span className="text-[9px] px-1.5 py-0.5 bg-purple-900/50 border border-purple-700 text-purple-300 rounded">WebGPU</span>
      </div>

      <textarea
        value={prompt}
        onChange={e => setPrompt(e.target.value)}
        rows={2}
        placeholder="Enter prompt for the LLM…"
        className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-gray-100 placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-none text-xs"
      />

      <button
        onClick={run}
        disabled={!compressedContent || status === 'loading-model' || status === 'generating'}
        className="px-3 py-1.5 bg-blue-700 hover:bg-blue-600 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded font-bold transition-colors"
      >
        {status === 'loading-model' ? 'Loading model…' : status === 'generating' ? 'Generating…' : 'Run WebLLM'}
      </button>

      {status === 'no-webgpu' && (
        <div className="text-amber-400 bg-amber-950/30 border border-amber-700/40 rounded p-2">
          WebGPU not available in this browser. Try Chrome 113+ or Edge 113+.
        </div>
      )}

      {ccrEvent && (
        <div className="bg-indigo-950/40 border border-indigo-700 rounded p-2 space-y-1">
          <div className="text-indigo-300 font-bold text-[10px] uppercase tracking-widest">
            ⚡ CCR Tool Intercepted
          </div>
          <div className="text-indigo-400 text-[10px]">ccr_retrieve("{ccrEvent.hash}")</div>
          <div className="text-gray-300 text-[10px] leading-relaxed border-t border-indigo-800/40 pt-1">
            {ccrEvent.retrieved}
          </div>
        </div>
      )}

      {output && (
        <div className="bg-gray-800 rounded p-2 max-h-48 overflow-y-auto">
          <pre className="text-gray-200 text-[11px] whitespace-pre-wrap leading-relaxed">{output}</pre>
        </div>
      )}
    </div>
  )
}
