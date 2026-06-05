import { useMemo } from 'react'
import type { DiffChunk } from '../lib/compression-sim.ts'

interface Props {
  compressed: string
  diffs: DiffChunk[]
}

export function DiffViewer({ compressed, diffs }: Props) {
  // Build a simple visual: show compressed text with removed sections highlighted
  const removedSnippets = useMemo(() =>
    diffs.filter(d => d.type === 'remove').map(d => d.original.slice(0, 40)),
    [diffs]
  )

  return (
    <div className="relative">
      <pre className="text-[11px] leading-relaxed text-gray-300 whitespace-pre-wrap break-words">
        {compressed}
      </pre>
      {removedSnippets.length > 0 && (
        <div className="mt-2 pt-2 border-t border-gray-700">
          <div className="text-[9px] text-gray-500 uppercase tracking-widest mb-1">
            {diffs.filter(d => d.type === 'remove').length} sections removed · {diffs.filter(d => d.type === 'replace').length} replaced
          </div>
          <div className="flex flex-wrap gap-1">
            {removedSnippets.slice(0, 8).map((s, i) => (
              <span key={i} className="px-1.5 py-0.5 bg-red-950/50 border border-red-800/40 text-red-400 text-[9px] rounded line-through opacity-70">
                {s}…
              </span>
            ))}
            {removedSnippets.length > 8 && (
              <span className="text-gray-500 text-[9px]">+{removedSnippets.length - 8} more</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
