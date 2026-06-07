import * as duckdb from '@duckdb/duckdb-wasm'

let db: duckdb.AsyncDuckDB | null = null
let conn: duckdb.AsyncDuckDBConnection | null = null

async function init() {
  const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles()
  const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES)
  const worker_url = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker!}");`], { type: 'text/javascript' })
  )
  const worker = new Worker(worker_url)
  const logger = new duckdb.VoidLogger()
  db = new duckdb.AsyncDuckDB(logger, worker)
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
  conn = await db.connect()

  await conn.query(`
    CREATE TABLE IF NOT EXISTS payloads (
      id VARCHAR PRIMARY KEY,
      label VARCHAR,
      content TEXT,
      content_type VARCHAR,
      token_count INTEGER,
      inserted_at TIMESTAMP DEFAULT NOW()
    )
  `)

  await conn.query(`
    CREATE TABLE IF NOT EXISTS pdf_context (
      chunk_id VARCHAR PRIMARY KEY,
      page_number INTEGER,
      chunk_index INTEGER,
      content TEXT,
      token_count INTEGER
    )
  `)

  return 'ready'
}

async function query(sql: string): Promise<any[]> {
  if (!conn) throw new Error('DuckDB not initialised')
  const result = await conn.query(sql)
  return result.toArray().map(r => r.toJSON())
}

async function insertPayload(id: string, label: string, content: string, contentType: string, tokenCount: number) {
  if (!conn) throw new Error('DuckDB not initialised')
  await conn.query(`
    INSERT OR REPLACE INTO payloads VALUES (
      '${id.replace(/'/g, "''")}',
      '${label.replace(/'/g, "''")}',
      '${content.replace(/'/g, "''")}',
      '${contentType}',
      ${tokenCount},
      NOW()
    )
  `)
}

async function insertPdfChunks(chunks: { chunkId: string; pageNumber: number; chunkIndex: number; content: string; tokenCount: number }[]) {
  if (!conn) throw new Error('DuckDB not initialised')
  for (const c of chunks) {
    await conn.query(`
      INSERT OR REPLACE INTO pdf_context VALUES (
        '${c.chunkId.replace(/'/g, "''")}',
        ${c.pageNumber},
        ${c.chunkIndex},
        '${c.content.replace(/'/g, "''")}',
        ${c.tokenCount}
      )
    `)
  }
}

async function searchPdfChunks(query: string, topK = 3): Promise<any[]> {
  if (!conn) throw new Error('DuckDB not initialised')
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []

  const conditions = terms.map(t => `LOWER(content) LIKE '%${t.replace(/'/g, "''")}%'`).join(' OR ')
  const result = await conn.query(`
    SELECT chunk_id, page_number, chunk_index, content, token_count,
      (${terms.map(t => `CASE WHEN LOWER(content) LIKE '%${t.replace(/'/g, "''")}%' THEN 1 ELSE 0 END`).join(' + ')}) AS score
    FROM pdf_context
    WHERE ${conditions}
    ORDER BY score DESC
    LIMIT ${topK}
  `)
  return result.toArray().map(r => r.toJSON())
}

self.onmessage = async (e) => {
  const { id, type, payload } = e.data
  try {
    let result
    switch (type) {
      case 'init': result = await init(); break
      case 'query': result = await query(payload.sql); break
      case 'insertPayload': result = await insertPayload(payload.id, payload.label, payload.content, payload.contentType, payload.tokenCount); break
      case 'insertPdfChunks': result = await insertPdfChunks(payload.chunks); break
      case 'searchPdf': result = await searchPdfChunks(payload.query, payload.topK); break
      default: throw new Error(`Unknown message type: ${type}`)
    }
    self.postMessage({ id, ok: true, result })
  } catch (err: any) {
    self.postMessage({ id, ok: false, error: err.message })
  }
}
