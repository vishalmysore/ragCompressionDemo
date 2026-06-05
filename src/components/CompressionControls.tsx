
import type { HeadroomConfig } from '../lib/headroom.ts'

interface Props {
  config: HeadroomConfig
  onChange: (c: HeadroomConfig) => void
}

export function CompressionControls({ config, onChange }: Props) {
  function set(partial: Partial<HeadroomConfig>) {
    onChange({ ...config, ...partial })
  }

  return (
    <div className="flex flex-col gap-3 p-3 bg-gray-900 rounded-lg border border-gray-700 text-xs">
      <div className="text-gray-400 font-semibold uppercase tracking-widest text-[10px]">
        Compression Config
      </div>

      {/* compression_ratio_target */}
      <label className="flex flex-col gap-1">
        <div className="flex justify-between text-gray-300">
          <span>compression_ratio_target</span>
          <span className="text-cyan-400 font-bold">{config.compressionRatioTarget.toFixed(2)}</span>
        </div>
        <input
          type="range" min={0.1} max={0.9} step={0.05}
          value={config.compressionRatioTarget}
          onChange={e => set({ compressionRatioTarget: +e.target.value })}
          className="accent-cyan-500 w-full"
        />
        <div className="flex justify-between text-gray-600 text-[10px]">
          <span>0.1 (aggressive)</span><span>0.9 (gentle)</span>
        </div>
      </label>

      {/* tokenBudget */}
      <label className="flex flex-col gap-1">
        <div className="flex justify-between text-gray-300">
          <span>tokenBudget</span>
          <span className="text-cyan-400 font-bold">{config.tokenBudget.toLocaleString()}</span>
        </div>
        <input
          type="range" min={500} max={32000} step={500}
          value={config.tokenBudget}
          onChange={e => set({ tokenBudget: +e.target.value })}
          className="accent-cyan-500 w-full"
        />
        <div className="flex justify-between text-gray-600 text-[10px]">
          <span>500</span><span>32,000</span>
        </div>
      </label>

      {/* entropy preservation */}
      <label className="flex items-center justify-between gap-2 cursor-pointer select-none">
        <span className="text-gray-300">entropy_preservation</span>
        <button
          role="switch"
          aria-checked={config.useEntropyPreservation}
          onClick={() => set({ useEntropyPreservation: !config.useEntropyPreservation })}
          className={`relative w-10 h-5 rounded-full transition-colors ${config.useEntropyPreservation ? 'bg-cyan-600' : 'bg-gray-600'}`}
        >
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${config.useEntropyPreservation ? 'translate-x-5' : 'translate-x-0.5'}`} />
        </button>
      </label>
      {config.useEntropyPreservation && (
        <div className="text-[10px] text-gray-500 bg-gray-800 rounded p-1.5">
          UUIDs, hashes &amp; API tokens preserved during compression
        </div>
      )}

      {/* Proxy URL */}
      <label className="flex flex-col gap-1">
        <span className="text-gray-300">Proxy URL <span className="text-gray-500">(optional — for live backend)</span></span>
        <input
          type="text"
          placeholder="http://localhost:8787"
          value={config.proxyUrl ?? ''}
          onChange={e => set({ proxyUrl: e.target.value || undefined })}
          className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-gray-100 placeholder-gray-600 focus:outline-none focus:border-cyan-500 w-full"
        />
      </label>

      {!config.proxyUrl && (
        <div className="text-[10px] text-blue-400 bg-blue-950/40 border border-blue-800/40 rounded p-1.5">
          Running JS-ported algorithms client-side (SmartCrusher · LogCompressor · CodeAwareCompressor)
        </div>
      )}
    </div>
  )
}
