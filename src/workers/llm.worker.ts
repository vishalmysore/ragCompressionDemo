// LLM Web Worker — runs WebLLM inference in an isolated thread.
// Mirrors the approach in advancedRag/src/worker.js.
// The engine lives here, isolated from the main thread, so a GPU crash
// doesn't corrupt main-thread state.

import { CreateMLCEngine } from '@mlc-ai/web-llm'

let engine: any = null
let currentModelId: string | null = null
let loadAborted = false
let currentGen = -1

function post(msg: Record<string, unknown>) {
  self.postMessage({ gen: currentGen, ...msg })
}

async function disposeCurrent() {
  if (engine) {
    try { await engine.unload() } catch (_) {}
    engine = null
    currentModelId = null
  }
}

self.onmessage = async (e: MessageEvent) => {
  const { action, modelId, messages, gen } = e.data

  // ── Load ────────────────────────────────────────────────────────────
  if (action === 'load') {
    loadAborted = false
    currentGen  = gen ?? 0

    await disposeCurrent()

    if (!modelId) {
      post({ status: 'error', error: 'No model ID provided.' })
      return
    }

    try {
      const nav = self.navigator as any
      if (!nav.gpu) {
        post({ status: 'error', error: 'WebGPU not supported. Use Chrome 113+ on a machine with a GPU.' })
        return
      }
      const adapter = await nav.gpu.requestAdapter()
      if (!adapter) {
        post({
          status: 'error',
          error: 'WebGPU adapter lost — Chrome\'s GPU process crashed. Close all Chrome windows and reopen, then try again.',
          deviceLost: true,
        })
        return
      }
      post({ status: 'device_detected', device: 'webgpu' })
    } catch (err: any) {
      post({ status: 'error', error: `WebGPU check failed: ${err?.message ?? err}` })
      return
    }

    post({ status: 'phase', phase: 'download' })

    try {
      engine = await CreateMLCEngine(modelId, {
        initProgressCallback: (progress: any) => {
          if (loadAborted) return
          const text = progress.text ?? ''
          const pct  = Math.round((progress.progress ?? 0) * 100)
          if (text.toLowerCase().includes('fetch') || text.toLowerCase().includes('loading')) {
            post({ status: 'downloading', file: text, progress: pct })
          } else if (text.toLowerCase().includes('compil') || pct > 50) {
            post({ status: 'phase', phase: 'compile',
              note: `${text} — shader compilation (~1–5 min first load, cached after)` })
          }
        },
      })

      if (loadAborted) { await disposeCurrent(); return }

      currentModelId = modelId
      post({ status: 'ready', modelId: currentModelId })

    } catch (err: any) {
      if (loadAborted) return
      await disposeCurrent()
      post({ status: 'error', error: err?.message ?? String(err) })
    }

  // ── Generate ────────────────────────────────────────────────────────
  } else if (action === 'generate') {
    if (!engine) {
      post({ status: 'error', error: 'No model loaded.' })
      return
    }
    try {
      const stream = await engine.chat.completions.create({
        messages,
        stream: true,
        max_tokens: 512,
        temperature: 0.1,
      })
      let full = ''
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? ''
        if (delta) {
          full += delta
          post({ status: 'token', delta, full })
        }
      }
      post({ status: 'success', full })
    } catch (err: any) {
      // On GPU crash, unload so next load starts clean
      const isDeviceLost = /disposed|device.?lost|device.?hung|DEVICE_HUNG|0x887A/i.test(err?.message ?? '')
      if (isDeviceLost) await disposeCurrent()
      post({ status: 'error', error: err?.message ?? String(err), deviceLost: isDeviceLost })
    }

  // ── Cancel / Dispose ────────────────────────────────────────────────
  } else if (action === 'cancel') {
    loadAborted = true
    await disposeCurrent()
    self.postMessage({ status: 'cancelled' })

  } else if (action === 'dispose') {
    loadAborted = true
    await disposeCurrent()
    self.postMessage({ status: 'disposed' })
  }
}
