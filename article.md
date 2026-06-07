# Context Is the New RAM: How Headroom Compresses Your Way to Better RAG

Every call to an LLM has a token budget. Blow it, and you get truncated context, degraded answers, or outright errors. Stay well under it, and you're leaving quality on the table. The sweet spot is fitting the *most informative* content into the available window — and that is exactly the problem context compression solves.

This article walks through the algorithms behind **Headroom**, an open-source context compression library originally written in Rust, and how its core ideas have been ported to TypeScript to run entirely in the browser — no proxy, no server round-trips, no external SDK.

---

## The Core Idea: Information Saturation

The central insight behind Headroom is that a large document has a *knee* — a point beyond which adding more content stops adding new information. The job of a compressor is to find that knee and cut everything past it.

Headroom uses the **Kneedle algorithm** to locate this inflection point. The implementation builds a cumulative bigram coverage curve: as you consume sentences (or JSON records) one by one, you track how many unique word-bigrams you've seen. At first, each new item adds many novel bigrams. Eventually, items start repeating familiar vocabulary and the curve flattens. Kneedle finds the point of maximum vertical distance from the diagonal — the "elbow" — and that becomes the budget `k`.

```ts
// adaptive-sizer.ts
export function findKnee(curve: number[]): number | null {
  const n = curve.length
  let maxDiff = -1
  let kneeIdx: number | null = null
  for (let i = 0; i < n; i++) {
    const xNorm = i / (n - 1)
    const yNorm = (curve[i] - curve[0]) / (curve[n-1] - curve[0])
    const diff = yNorm - xNorm
    if (diff > maxDiff) { maxDiff = diff; kneeIdx = i }
  }
  if (maxDiff < 0.05) return null  // curve is too flat to have a meaningful knee
  return kneeIdx! + 1
}
```

A zlib validation pass follows: if the selected subset compresses significantly better than the full corpus, the subset is likely missing representative content, so `k` is bumped up by 20%. This guards against the pathological case where the knee lands too early on a highly redundant dataset.

---

## Content-Type Routing

Not all context is the same. A wall of log output calls for different treatment than a PDF page or a Python module. Headroom auto-detects content type and routes to a specialized compressor:

```ts
function detectContentType(content: string): 'json' | 'code' | 'logs' | 'text' {
  const t = content.trimStart()
  if (t.startsWith('{') || (t.startsWith('[') && !t.startsWith('[Page'))) return 'json'
  if (/^(import |from |def |async def |class |function |const |let |#!\/)/m.test(content)) return 'code'
  if (/\[(INFO|DEBUG|WARN|ERROR|FATAL)\]/i.test(content)) return 'logs'
  return 'text'
}
```

The `[Page N]` check is a small but meaningful detail — PDF text often gets prefixed with page markers like `[Page 3]`, which would otherwise look like a JSON array opening bracket.

---

## SmartCrusher: Intelligent JSON Compression

JSON API responses are the most common type of large context in agentic systems. A list of 500 Jira tickets, a DynamoDB scan result, a GitHub search response — these all share the same structure: a large array of similar objects.

SmartCrusher's strategy is to keep a representative sample rather than a truncated prefix. For each array it:

1. Always keeps items containing **error keywords** — `error`, `exception`, `fatal`, `timeout`, and similar signals that suggest something went wrong.
2. Always keeps the **first `kFirst`** and **last `kLast`** items, preserving recency and temporal context.
3. Fills the remaining budget using a **stride walk** through the middle, ensuring uniform coverage.
4. For dict arrays, caps overly large objects by scoring keys (error-adjacent keys score highest).

The split between first, last, and importance-sampled items is itself computed by the Kneedle sizer, so the fractions adapt to the array's actual diversity rather than using a fixed 30/30/40 split.

When items are dropped, a `_headroom` metadata key is injected so the LLM knows the response was compressed:

```json
{
  "data": [...],
  "_headroom": "342 items offloaded <<ccr:a3f8c901b2d4>>"
}
```

The CCR (Compressed Context Reference) hash is a lightweight fingerprint of the dropped content — a future retrieval layer could use it to restore dropped items on demand.

---

## LogCompressor: Signal-Aware Log Triage

Build logs and test output are dense and highly redundant. A 10,000-line pytest run might contain 9,800 lines of `PASSED [100%]` and 200 lines that actually matter.

The LogCompressor follows a priority stack:

1. **Format detection** — recognise pytest, npm, cargo, jest, make, or generic output and adjust scoring accordingly.
2. **Error + context windows** — every ERROR or FAIL line is kept, along with the three lines before and after it (the context window catches the root cause that typically precedes the error).
3. **Stack traces** — up to three stack traces are kept, each capped at 20 lines to prevent a single massive traceback from consuming the budget.
4. **Deduplicated warnings** — repeated warnings (e.g. the same deprecation firing hundreds of times) are normalised by replacing digits with `N` before deduplication, so `line 42` and `line 43` hash to the same key.
5. **Summary lines** — test suite totals (`=== 3 failed, 197 passed ===`) are always kept.
6. **Budget fill** — remaining capacity is filled with the highest-scoring lines by level (ERROR=1.0, WARN=0.5, INFO=0.1, DEBUG=0.0).

Between kept blocks, omission markers are inserted:

```
[2026-01-15 09:14:22] ERROR: Database connection refused
... [847 lines omitted]
=== 1 failed, 199 passed in 34.2s ===
```

---

## CodeCompressor: Structure-Preserving Code Summarisation

For code files, the goal is to keep the *signature* (the contract) while collapsing the *body* (the implementation). An LLM reasoning about a codebase needs to know that `authenticate(user, token)` exists and what it returns — it usually does not need to see every line of the token validation logic.

The compressor identifies function and method definitions via a regex approximation of an AST, then stubs their bodies:

```ts
// From code-compressor.ts
if (DEF_RE.test(line)) {
  output.push(line.replace(COMMENT_RE, ''))  // keep the signature
  inBody = true
  bodyIndent = indent
}
// ... inside body:
if (bodyLineCount === 0) {
  output.push(`${bodyIndent}    ... # [body omitted — ${N} lines]`)
}
```

What is always preserved:
- `import` / `from` / `require` statements
- Class, function, and type definitions
- Decorators (`@dataclass`, `@property`, etc.)
- Module-level constants (`SCREAMING_CASE = ...`)
- The first line of docstrings

The result is a skeleton that conveys the module's API surface without the implementation noise.

---

## Text and PDF Compression: Keyword Signals

For unstructured text — documentation, PDF extracts, meeting transcripts — the compressor scores each sentence using a tiered keyword registry ported from Headroom's `keyword_detector.rs`:

| Priority | Keywords |
|----------|----------|
| 0.95 — Error | `error`, `exception`, `failed`, `fatal`, `crash`, `timeout` |
| 0.85 — Security | `password`, `secret`, `credential`, `auth`, `api_key` |
| 0.75 — Warning | `warn`, `warning` |
| 0.60 — Importance | `important`, `conclusion`, `summary`, `result`, `recommend` |
| 0.45 — Markdown | Lines starting with `#`, `##`, `>`, `**` |
| 0.00 — Default | No keyword match |

Sentences scoring above the knee threshold are kept; the rest are dropped. One addition beyond Headroom's original design: **query relevance boosting**. At RAG time, you know the user's question. Sentences that overlap with query terms get a score boost proportional to term coverage, so the compressor can prioritise content that is directly relevant to the retrieval context.

---

## Alternative Methods: Classical NLP Baselines

The demo provides four additional methods for comparison, all running client-side:

**TF-IDF** scores each sentence by the sum of (term frequency × inverse document frequency) for query terms. It requires a query to work; without one it falls back to no-op. Classic and surprisingly effective for focused retrieval questions.

**TextRank** builds a sentence similarity graph (word-overlap normalised by log lengths) and runs PageRank-style iteration for 10 steps with damping factor 0.85. It produces query-independent extractive summaries — useful when you want the document's own central themes, not answers to a specific question.

**Stopword Removal** strips function words (`the`, `a`, `is`, `of`, ...) using a regex. Lossless of meaning, delivers 10–20% token reduction with zero risk of dropping important content. Good as a pre-pass before other methods.

**SimHash Dedup** removes near-duplicate sentences by computing 64-bit SimHash fingerprints and dropping any sentence within Hamming distance ≤ 8 of an already-seen sentence. Effective for documents with repetitive boilerplate (legal clauses, form templates, repeated disclaimers).

---

## Compression Ratios in Practice

| Method | Content Type | Typical Reduction |
|---|---|---|
| SmartCrusher | JSON arrays | 60–85% |
| LogCompressor | Build/test logs | 70–90% |
| CodeCompressor | Source code | 40–60% |
| Headroom Smart | Text / PDF | 40–60% |
| Headroom Aggressive | Text / PDF | 70–85% |
| TF-IDF | Text (with query) | configurable |
| TextRank | Text | configurable |
| Stopwords | Any | 10–20% |
| SimHash Dedup | Repetitive text | 15–50% |

---

## Running Entirely in the Browser

The entire engine is TypeScript, compiled to WebAssembly-compatible code and loaded via a Web Worker for DuckDB integration. There is no backend proxy, no Anthropic SDK call at compression time — the compression happens client-side before the context is sent to the LLM.

This has a practical implication: the token count estimates use the `ceil(length / 4)` heuristic rather than a tokenizer, which is accurate to within ~10% for typical English prose and good enough for sizing decisions. For production use with tiktoken or the Anthropic tokenizer, the `rough()` function would be the only thing to swap out.

---

## Key Takeaways

1. **Information saturation, not token budgets, should drive compression.** The Kneedle algorithm finds the natural knee in the information curve; forcing a fixed ratio often either over-compresses (losing signal) or under-compresses (wasting budget).

2. **Content type matters more than compression ratio.** A good log compressor and a good text compressor have almost nothing in common. Routing to a purpose-built algorithm beats a one-size-fits-all approach.

3. **Error signals are universally high-priority.** Across JSON, logs, code, and text, the pattern holds: lines containing error-adjacent vocabulary carry disproportionate signal density and should almost never be dropped.

4. **Query-awareness is a first-class concern for RAG.** General summarisation (TextRank, TF-IDF without a query) misses the point in a retrieval context. The compressor knows why you fetched the document — use that.

5. **Client-side compression is viable.** The entire Headroom engine — Kneedle, SimHash, bigram curves, zlib validation — runs in ~50ms for typical documents on modern hardware, well within the latency budget of a streaming LLM response.

---

The code for this demo is available in the `headroom-demo` directory. The core algorithms live in `src/lib/headroom-engine/` and are intentionally self-contained — no framework dependencies, no runtime SDK, ready to drop into any TypeScript project.
