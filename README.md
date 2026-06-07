# RAG Compression Demo

> **Source:** [github.com/vishalmysore/ragCompressionDemo](https://github.com/vishalmysore/ragCompressionDemo)

A 100% browser-based playground for exploring how context compression affects
RAG (Retrieval-Augmented Generation) quality and token cost.

Upload a PDF, load a local LLM via WebGPU, ask a question, and compare the
LLM's answer when given the full context vs two levels of compression — side
by side, in real time, with no server required.

---

## Features

- **PDF ingestion** — pdf.js extracts text, chunks at 500 chars with 100-char
  overlap, stores in DuckDB WASM
- **BM25 search** — retrieves the top-5 most relevant chunks for your question
- **3 compression modes** — No Compression / Smart / Aggressive
- **3 LLM answer panels** — ask with each compression level simultaneously and
  compare answers and token counts
- **Local LLM** — Qwen2 0.5B, Llama 3.2 1B/3B, Phi-3.5 Mini, Gemma 2 2B via
  WebLLM + WebGPU (runs entirely on your GPU, no API key)

---

## Compression Algorithms

The core compression engine (`src/lib/headroom-engine/`) is a TypeScript port of algorithms
from [headroom](https://github.com/chopratejas/headroom) (Apache-2.0) by Tejas Chopra,
adapted for browser environments (WebGPU, WASM, no server required).

| File | Ported from | What it does |
|---|---|---|
| `adaptive-sizer.ts` | `transforms/adaptive_sizer.rs` | SimHash, Kneedle knee-detection, zlib-ratio validation, adaptive K sizing |
| `smart-crusher.ts` | `transforms/smart_crusher/` | JSON array type classification, k-split (first/last/importance), dict/string/number crushers |
| `log-compressor.ts` | `transforms/log_compressor.rs` | Log format detection (pytest/npm/cargo/jest/make), level scoring (ERROR → DEBUG), stack-trace state machine |
| `text-compressor.ts` | `signals/keyword_detector.rs` | Sentence-level PDF prose compression with keyword signals and a RAG-specific query-relevance layer |
| `code-compressor.ts` | CodeCompressor concept | Signature/import preservation and function-body stubbing (regex-based, no tree-sitter) |

Attribution headers are preserved in each source file as required by Apache 2.0 §4.

---

## Tech Stack

| Layer | Library |
|---|---|
| UI | Vite + React + Tailwind CSS |
| PDF parsing | pdf.js 3.4.120 (CDN) |
| Vector DB | DuckDB WASM (Web Worker) |
| Tokenization | js-tiktoken (`cl100k_base`) |
| Compression math | pako (zlib), spark-md5 (MD5 for SimHash) |
| LLM inference | WebLLM (`@mlc-ai/web-llm`) via WebGPU |

---

## Running locally

```bash
git clone https://github.com/vishalmysore/ragCompressionDemo.git
cd ragCompressionDemo
npm install
npm run dev
```

Requires Chrome 113+ or Edge 113+ for WebGPU support.

---

## License

Copyright 2026 Vishal Mysore (https://github.com/vishalmysore)

Licensed under the **Apache License, Version 2.0**.
See [LICENSE](./LICENSE) and [NOTICE](./NOTICE) for full details.

The compression engine (`src/lib/headroom-engine/`) contains TypeScript ports of
[chopratejas/headroom](https://github.com/chopratejas/headroom) (Apache-2.0, Copyright 2025 Headroom Contributors).
Attribution is preserved in source file headers and in [NOTICE](./NOTICE) as required by Apache 2.0 §4.
