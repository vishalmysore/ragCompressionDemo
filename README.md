# RAG Compression Demo

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

### Faithfully ported from [headroom](https://github.com/chopratejas/headroom) (Apache-2.0)

The following algorithms are direct TypeScript ports of Rust source code in
`crates/headroom-core/`. The original license and attribution headers are
preserved in each file as required by Apache 2.0.

| File | Ported from | What it does |
|---|---|---|
| `src/lib/headroom-engine/adaptive-sizer.ts` | `transforms/adaptive_sizer.rs` | SimHash (4-gram MD5 bit-voting), Kneedle knee-detection, zlib-ratio validation, `compute_optimal_k` |
| `src/lib/headroom-engine/smart-crusher.ts` | `transforms/smart_crusher/` | JSON array type classification, k-split (first/last/importance), dict/string/number array crushers |
| `src/lib/headroom-engine/log-compressor.ts` | `transforms/log_compressor.rs` | Log format detection (pytest/npm/cargo/jest/make), level scoring (ERROR=1.0 → DEBUG=0.0), stack-trace state machine |
| `src/lib/headroom-engine/text-compressor.ts` | `signals/keyword_detector.rs` | Keyword priority tiers (error=0.95, security=0.85, warning=0.75, importance=0.60, markdown=0.45) and the `token` exclusion bug fix |

These files include their original Apache 2.0 attribution headers. Per
Apache 2.0 §4(a)/(b), the headers and this notice must be retained in any
distribution.

### Written independently (inspired by headroom's design)

| File | What it does |
|---|---|
| `src/lib/headroom-engine/text-compressor.ts` | Sentence-level PDF prose compression using headroom's keyword signals + Kneedle K, with an additional query-relevance layer specific to RAG |
| `src/lib/headroom-engine/code-compressor.ts` | Signature/import preservation and function-body stubbing via regex (headroom uses a full AST parser; this is an approximation) |

The sentence-splitting, query-relevance scoring, and `[Page N]` boundary
preservation in `text-compressor.ts` are original work. The keyword priority
values and `compute_optimal_k` call are from headroom.

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
cd headroom-demo
npm install
npm run dev
```

Requires Chrome 113+ or Edge 113+ for WebGPU support.

---

## License

This project is licensed under the **Apache License, Version 2.0**.
See [LICENSE](./LICENSE) and [NOTICE](./NOTICE) for full details.

This project includes algorithms ported from
[chopratejas/headroom](https://github.com/chopratejas/headroom) (Apache-2.0).
Attribution is preserved in the relevant source file headers and in NOTICE
as required by Apache 2.0 §4(c) and §4(d).
