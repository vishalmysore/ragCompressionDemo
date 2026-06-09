# RAG Compression: The Missing Layer in Your AI Pipeline

RAG compression — also called Context Compression — is an optimization technique that sits between the retrieval step and the generation step in an AI pipeline. Its job is to dramatically reduce the amount of text fed into a Large Language Model without losing the signal that actually answers the user's question.

To understand why it matters, you first need to understand what standard RAG does wrong.

[**→ Try the live demo**](https://vishalmysore.github.io/ragCompressionDemo/)

---

## The Problem with Naive RAG

A standard Retrieval-Augmented Generation system works like this:

1. The user asks a question.
2. A retriever searches a vector database and pulls back the top-K most semantically similar chunks — typically 5 to 20 document fragments, each a few hundred tokens long.
3. All of those chunks are concatenated into a prompt and handed to the LLM.
4. The LLM reads the whole thing and generates an answer.

Step 3 is where things fall apart at scale. Three problems compound each other:

**The "Lost in the Middle" problem.** LLMs have a known attention bias: they reliably process content at the very beginning and very end of a long prompt, but they frequently miss — or heavily discount — information buried in the middle. A 2023 Stanford study found that model accuracy on multi-document QA tasks dropped by up to 20% when the relevant passage was positioned in the middle of a long context window rather than at the edges. Stuffing 8,000 raw tokens into a prompt doesn't help if the critical sentence is token number 4,000.

**Token cost and latency.** Every token sent to a hosted LLM costs money and adds inference latency. If 10 retrieved chunks average 800 tokens each, you're sending 8,000 tokens per query — regardless of whether 80% of that content is boilerplate, headers, or sentences completely unrelated to what was asked. At scale, this waste compounds fast.

**Noise injection.** Retrieved documents are ranked by semantic similarity, not by information density relative to the specific question. A "highly relevant" document might be 95% background context and 5% the actual answer. Feeding that whole document into the LLM dilutes the signal-to-noise ratio and increases the chance of hallucination or incoherent answers.

RAG compression addresses all three by acting as an intelligent filter between retrieval and generation.

---

## How It Works: Two Families of Compression

Compression techniques fall into two broad families based on what they output.

### 1. Hard (Lexical) Compression — Text → Shorter Text

This family physically removes tokens from the retrieved text before it reaches the LLM. The output is still human-readable text — just shorter and more focused.

**Query-aware sentence pruning** is the most common approach. Each sentence in the retrieved chunks is scored for relevance to the specific query, and low-scoring sentences are dropped. The scoring can be as simple as TF-IDF overlap or as sophisticated as a cross-encoder model (like PROVENCE or LLMLingua) that uses a small, fast language model to estimate the conditional probability of each token being useful for answering the query. LLMLingua, for example, can achieve 2x–10x compression with less than 5% degradation in downstream task accuracy.

> **LLM Required** ❌ (basic) / ✅ (advanced) &nbsp;|&nbsp; **Libraries** ✅ — basic: `scikit-learn`, `nltk`, `rank_bm25` · advanced: `llmlingua`, `transformers` (Microsoft/PROVENCE cross-encoder)

> **Simple example.** You ask: *"What are the side effects of ibuprofen?"* The retrieved document is a 4-page drug leaflet. Query-aware pruning reads every sentence and asks "does this help answer the side-effects question?" Sentences like *"Store below 25°C in a dry place"* and *"Each tablet contains 400mg of ibuprofen"* score near zero — they share no words with the query and answer nothing. Sentences like *"Common side effects include nausea, stomach pain, and headache"* score high and are kept. The LLM receives only the high-scoring sentences — a paragraph instead of four pages.

**Extractive summarisation** via algorithms like TextRank builds a graph of sentences where edges represent lexical similarity. Running PageRank-style iteration over this graph surfaces the sentences that are most "central" to the document's themes — without needing a generative model to rewrite anything. It's fast, deterministic, and runs entirely in the browser.

> **LLM Required** ❌ &nbsp;|&nbsp; **Libraries** ✅ — `sumy`, `pytextrank`, `networkx` (Python) · or plain JS/TS with no dependencies (as in this demo)

> **Simple example.** Imagine each sentence in a document as a person in a room. Two people are "connected" if they talk about similar things. TextRank asks: who is connected to the most other people? The most socially connected person — the one whose topics come up everywhere — represents the document's core theme. TextRank keeps those "well-connected" sentences and drops the isolated ones that barely relate to anything else in the document. No rewriting, no AI generation — just a popularity contest among sentences.

**Structural compression** routes different content types to specialised algorithms. Log output, JSON API responses, and source code each have very different information distributions. A log compressor should keep ERROR lines and their surrounding context, deduplicate repeated warnings, and summarise passing-test noise. A JSON compressor should keep error-flagged records and take a representative stride-sample of the rest, rather than truncating. A code compressor should keep function signatures and strip bodies. Routing content to the right algorithm beats a one-size-fits-all approach by a significant margin.

> **LLM Required** ❌ &nbsp;|&nbsp; **Libraries** ✅ — `headroom` (Rust) · `loguru`, `json` (Python stdlib) · or plain regex in any language — no external packages required

> **Simple example.** Think of it like sorting your mail. You wouldn't read a 500-page server log the same way you'd read a JSON invoice or a Python file. A log compressor is like a triage nurse: it immediately flags anything with "ERROR" or "FAILED", keeps the three lines before it (which usually explain *why* it failed), and throws away the 9,800 lines of `PASSED [100%]`. A code compressor is like reading only the chapter titles and section headings of a textbook — you keep `def authenticate(user, token) -> bool` so the LLM knows the function exists and what it returns, but you strip the 40 lines of implementation detail inside it. Sending a log through a code compressor (or vice versa) would produce garbage; routing matters.

**SimHash deduplication** removes near-duplicate sentences using a 64-bit locality-sensitive hash. Sentences within a small Hamming distance (≤ 8 bits) are treated as duplicates and the redundant copy is dropped. This is particularly effective on legal documents, form templates, and any corpus with repetitive boilerplate.

> **LLM Required** ❌ &nbsp;|&nbsp; **Libraries** ✅ — `datasketch`, `simhash` (Python) · `spark-md5` (JS, as used in this demo) · or a 20-line custom implementation in any language

> **Simple example.** A 50-page rental contract might contain the phrase *"The tenant shall not sublet the premises without prior written consent of the landlord"* in section 4, section 11, and the appendix — worded almost identically each time. SimHash converts each sentence into a short numeric fingerprint (like a fingerprint for text). Two sentences with very similar fingerprints are almost certainly saying the same thing. The second and third copies get dropped. The LLM sees the clause once — which is all it needs — instead of three times eating up token budget.

### 2. Soft (Embedding) Compression — Text → Vectors

This family bypasses text entirely. Instead of producing a shorter string, it produces a dense numerical representation that is injected directly into the LLM's internal attention layers, bypassing the tokenizer and the text-processing pathway altogether.

**In-Context Autoencoders (ICAE)** train a small encoder model to compress a long document into a fixed number of "memory tokens" — dense vectors that capture the document's meaning in a compact form. The LLM is then fine-tuned to read those memory tokens as if they were part of its context. This can achieve compression ratios of 16x or more, at the cost of requiring a fine-tuned LLM that understands the compressed representation.

> **LLM Required** ✅ &nbsp;|&nbsp; **Libraries** ✅ — `transformers`, `torch`, `peft` (for fine-tuning) · GPU training infrastructure required · research-level complexity

**xRAG and OSCAR** take a similar approach: retrieved documents are compressed to a single embedding vector (or a small cluster of them) and inserted into the LLM prompt at inference time as a virtual token. The LLM sees a prompt that is orders of magnitude shorter than the original retrieved text.

> **LLM Required** ✅ &nbsp;|&nbsp; **Libraries** ✅ — `sentence-transformers`, `transformers`, `faiss-cpu` · embedding model (e.g. `all-MiniLM-L6-v2`) must run at inference time

The tradeoff is fundamental: soft compression can achieve extreme compression ratios, but it is tightly coupled to a specific LLM architecture and requires training infrastructure. Hard compression is model-agnostic, runs without any ML inference, and can be deployed as a pure compute layer in any RAG pipeline.

---

## Quick Reference: GenAI Dependency by Technique

| Technique | LLM Required | Libraries |
|---|---|---|
| TF-IDF sentence scoring | ❌ | ✅ `scikit-learn`, `nltk`, `rank_bm25` |
| TextRank | ❌ | ✅ `sumy`, `pytextrank`, `networkx` |
| Structural compression (logs/JSON/code) | ❌ | ✅ `headroom`, or plain regex — no packages needed |
| SimHash deduplication | ❌ | ✅ `datasketch`, `simhash`, `spark-md5` |
| Stopword removal | ❌ | ✅ `nltk`, `spaCy`, or a plain word-list file |
| Kneedle / adaptive sizing | ❌ | ✅ `kneed` (Python), or ~30 lines of math |
| Query-aware pruning (basic) | ❌ | ✅ `scikit-learn`, `rank_bm25` |
| Query-aware pruning (advanced) | ✅ | ✅ `llmlingua`, `transformers` (PROVENCE cross-encoder) |
| xRAG / OSCAR | ✅ | ✅ `sentence-transformers`, `transformers`, `faiss-cpu` |
| In-Context Autoencoders (ICAE) | ✅ | ✅ `transformers`, `torch`, `peft` + GPU training infra |

The key takeaway: **most compression that matters in a production RAG system needs no LLM at all.** The no-AI techniques cover the vast majority of practical use cases — and since they add zero model inference overhead, they're also the fastest and cheapest to run.

---

## The Information Saturation Principle

Underlying the best hard compression algorithms is a key insight: retrieved documents have a *saturation point* — a threshold beyond which adding more sentences stops adding new information.

This can be measured empirically. Build a cumulative coverage curve: sort sentences by relevance score, then track how many unique word-bigrams you've seen as you include each sentence one by one. Early sentences add many new bigrams. Later sentences mostly repeat vocabulary already seen. The curve bends — it has a **knee**.

The Kneedle algorithm finds this knee mathematically by locating the point of maximum vertical distance from the diagonal of the normalised curve. Everything past the knee is by definition redundant with what came before it, and can be safely dropped.

This principle makes compression adaptive rather than fixed-ratio. A dense, information-rich document gets a higher `k` (more sentences kept). A repetitive, padded document gets a lower `k`. The budget is driven by the document's actual information density, not an arbitrary "keep 40%" rule.

---

## The Pipeline: Before and After

| Step | Standard RAG | RAG with Compression |
|---|---|---|
| Retrieval | Top-10 chunks, ~8,000 tokens | Top-10 chunks, ~8,000 tokens |
| Processing | All 8,000 tokens concatenated | Compressor scores and filters; ~800 high-signal tokens remain |
| Content-type routing | None | Logs → LogCompressor, JSON → SmartCrusher, text → KeywordSignals |
| Query-awareness | None | Sentences overlapping query terms get relevance boost |
| LLM input | 8,000 tokens | ~800 tokens (90% reduction) |
| Latency | Baseline | Faster — fewer tokens to prefill and decode |
| Cost | Baseline | ~10x cheaper at the token level |
| Answer quality | Subject to lost-in-the-middle, noise | Higher signal density, less hallucination risk |

---

## What This Demo Shows

This demo runs the entire pipeline in the browser — no server, no API key — using WebGPU for local LLM inference. You can upload any PDF, ask a question, and watch three columns answer it simultaneously using different compression methods. The token counts and reduction percentages are shown live above each column.

The compression methods available span both families described above:

- **No Compression** — the raw retrieved context, as a baseline
- **Smart Compress** — Kneedle knee-detection + keyword signals (the main algorithm)
- **Aggressive Compress** — same algorithm, lower target ratio
- **TF-IDF** — query-term frequency scoring, sentence-level extraction
- **TextRank** — graph-based extractive summarisation, query-independent
- **Stopword Removal** — lossless lexical stripping, ~10–20% reduction
- **SimHash Dedup** — near-duplicate sentence removal

All algorithms are TypeScript ports of the [headroom](https://github.com/chopratejas/headroom) Rust library (Apache-2.0), adapted to run entirely in the browser without any native dependencies.

---

## When to Use Compression (and When Not To)

Compression is not always the right call. Some guidelines:

**Use it when:**
- Your retrieved chunks are long and only partially relevant to the query
- You are hitting token limits or latency targets
- Your documents have high redundancy (legal text, logs, boilerplate-heavy APIs)
- You want to improve answer grounding by reducing noise before generation

**Be cautious when:**
- The documents are already short and densely relevant (compression may drop signal)
- The query is very broad and you genuinely need the full context
- The downstream task requires verbatim reproduction of text (legal citations, code output)

In most production RAG systems, a lightweight hard compression pass — query-aware sentence pruning, deduplication, and content-type routing — pays for itself immediately in both cost and quality. Soft compression is worth exploring when you are running a fine-tunable open-weights model and need extreme compression ratios.

---

The full source is at [github.com/vishalmysore/ragCompressionDemo](https://github.com/vishalmysore/ragCompressionDemo). The compression engine lives in `src/lib/headroom-engine/` — self-contained TypeScript with no runtime dependencies, ready to drop into any pipeline.
