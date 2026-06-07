// llm-bridge.ts — communicates with llm.worker.ts.
// Mirrors the pattern from advancedRag/src/utils/llm.js.

import LLMWorker from '../workers/llm.worker.ts?worker'

export type ModelStatus = 'idle' | 'loading' | 'ready' | 'no-webgpu' | 'error'

let _worker: Worker | null = null
let _status: ModelStatus = 'idle'
let _modelId: string | null = null
let _genCounter = 0

let _loadResolve: ((id: string) => void) | null = null
let _loadReject:  ((e: Error)   => void) | null = null
let _genResolve:  ((text: string) => void) | null = null
let _genReject:   ((e: Error)    => void) | null = null
let _onProgress:  ((e: ProgressEvent) => void) | null = null
let _onToken:     ((delta: string, full: string) => void) | null = null

export type ProgressEvent =
  | { type: 'device'; device: string }
  | { type: 'phase';  phase: string; note?: string }
  | { type: 'downloading'; file: string; progress: number }
  | { type: 'ready';  modelId: string }
  | { type: 'error';  error: string; deviceLost?: boolean }

function ensureWorker() {
  if (_worker) return
  _worker = new LLMWorker()
  _worker.onmessage = handleMessage
  _worker.onerror   = (e) => {
    _status = 'error'
    const err = new Error(e.message ?? 'LLM Worker crashed')
    _onProgress?.({ type: 'error', error: err.message })
    _loadReject?.(err);  _loadResolve = _loadReject = null
    _genReject?.(err);   _genResolve  = _genReject  = null
  }
}

function handleMessage(e: MessageEvent) {
  const msg = e.data
  switch (msg.status) {
    case 'device_detected':
      _onProgress?.({ type: 'device', device: msg.device })
      break
    case 'phase':
      _onProgress?.({ type: 'phase', phase: msg.phase, note: msg.note })
      break
    case 'downloading':
      _onProgress?.({ type: 'downloading', file: msg.file, progress: msg.progress })
      break
    case 'ready':
      _status  = 'ready'
      _modelId = msg.modelId
      _onProgress?.({ type: 'ready', modelId: msg.modelId })
      _loadResolve?.(msg.modelId); _loadResolve = _loadReject = null
      break
    case 'token':
      _onToken?.(msg.delta, msg.full)
      break
    case 'success':
      _genResolve?.(msg.full); _genResolve = _genReject = null
      break
    case 'error': {
      const err = new Error(msg.error)
      _onProgress?.({ type: 'error', error: msg.error, deviceLost: msg.deviceLost })
      if (_loadReject) { _status = 'error'; _loadReject(err); _loadResolve = _loadReject = null }
      if (_genReject)  { _genReject(err);   _genResolve  = _genReject  = null }
      if (msg.deviceLost) { _status = 'idle'; _modelId = null }
      break
    }
    case 'cancelled':
    case 'disposed':
      _status  = 'idle'
      _modelId = null
      break
  }
}

export const llmBridge = {
  getStatus(): ModelStatus { return _status },
  getModelId(): string | null { return _modelId },

  loadModel(modelId: string, onProgress?: (e: ProgressEvent) => void): Promise<string> {
    ensureWorker()
    _status     = 'loading'
    _onProgress = onProgress ?? null
    _genCounter++
    return new Promise((resolve, reject) => {
      _loadResolve = resolve
      _loadReject  = reject
      _worker!.postMessage({ action: 'load', modelId, gen: _genCounter })
    })
  },

  generate(
    messages: { role: string; content: string }[],
    onToken?: (delta: string, full: string) => void,
  ): Promise<string> {
    if (_status !== 'ready' || !_worker) {
      return Promise.reject(new Error('No model loaded.'))
    }
    _genCounter++
    _onToken = onToken ?? null
    return new Promise((resolve, reject) => {
      _genResolve = resolve
      _genReject  = reject
      _worker!.postMessage({ action: 'generate', messages, gen: _genCounter })
    })
  },

  cancel() {
    _worker?.postMessage({ action: 'cancel' })
  },

  /** Call when switching models — properly unloads GPU resources first */
  dispose() {
    _worker?.postMessage({ action: 'dispose' })
    _status  = 'idle'
    _modelId = null
  },
}
