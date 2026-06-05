
import type { CompressOutput } from '../lib/headroom.ts'
import { estimateCost } from '../lib/tokenizer.ts'

interface Props {
  result: CompressOutput | null
  ttft?: number
}

const PRICE_PER_MILLION = 3.0 // $ gpt-4o input tier approx

export function TelemetryDock({ result, ttft }: Props) {
  if (!result) {
    return (
      <div className="flex flex-col gap-2 p-3 bg-gray-900 rounded-lg border border-gray-700 text-xs text-gray-500">
        <div className="text-gray-400 font-semibold uppercase tracking-widest text-[10px]">Live Telemetry</div>
        <div className="text-center py-4 text-gray-600">Run compression to see metrics</div>
      </div>
    )
  }

  const savePct = ((1 - result.compressionRatio) * 100).toFixed(1)
  const costBefore = estimateCost(result.tokensBefore, PRICE_PER_MILLION)
  const costAfter = estimateCost(result.tokensAfter, PRICE_PER_MILLION)
  const savedPerCall = costBefore - costAfter
  const projectedSavings1M = savedPerCall * 1_000_000

  return (
    <div className="flex flex-col gap-3 p-3 bg-gray-900 rounded-lg border border-gray-700 text-xs">
      <div className="text-gray-400 font-semibold uppercase tracking-widest text-[10px]">Live Telemetry</div>

      {/* Big badge */}
      <div className="flex items-center justify-center">
        <div className={`text-4xl font-black ${+savePct > 50 ? 'text-green-400' : +savePct > 20 ? 'text-yellow-400' : 'text-gray-400'}`}>
          -{savePct}%
        </div>
      </div>

      {/* Token row */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <Metric label="Tokens Before" value={result.tokensBefore.toLocaleString()} color="text-red-400" />
        <Metric label="Tokens After" value={result.tokensAfter.toLocaleString()} color="text-green-400" />
        <Metric label="Saved" value={result.tokensSaved.toLocaleString()} color="text-cyan-400" />
      </div>

      {/* Pipeline tag */}
      <div className="flex items-center gap-2">
        <span className="text-gray-500">Pipeline:</span>
        <span className="px-2 py-0.5 bg-indigo-900/60 border border-indigo-700 text-indigo-300 rounded text-[10px] font-bold">
          {result.pipeline}
        </span>
        <span className="ml-auto px-1.5 py-0.5 rounded text-[10px] bg-blue-900/50 text-blue-300 border border-blue-700">
          LOCAL
        </span>
      </div>

      {/* Performance */}
      <div className="grid grid-cols-2 gap-2">
        <Metric label="Compress Time" value={`${result.ttfMs.toFixed(0)}ms`} color="text-purple-400" />
        {ttft != null && <Metric label="TTFT (WebLLM)" value={`${ttft.toFixed(0)}ms`} color="text-blue-400" />}
      </div>

      {/* Cost */}
      <div className="border-t border-gray-700 pt-2 space-y-1">
        <div className="text-gray-500 uppercase tracking-widest text-[10px]">Cost @ $3/M tokens (gpt-4o)</div>
        <div className="flex justify-between">
          <span className="text-gray-400">Per call saved:</span>
          <span className="text-green-400 font-bold">${savedPerCall.toFixed(6)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-400">1M calls/day projected:</span>
          <span className="text-green-300 font-black">${projectedSavings1M.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
        </div>
      </div>
    </div>
  )
}

function Metric({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-gray-800 rounded p-2">
      <div className="text-gray-500 text-[9px] uppercase">{label}</div>
      <div className={`font-bold ${color} text-sm`}>{value}</div>
    </div>
  )
}
