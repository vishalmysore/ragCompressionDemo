export type DatasetKey = 'json' | 'code' | 'logs' | 'pdf_chunks'

export const DATASETS: Record<DatasetKey, { label: string; content: string }> = {
  json: {
    label: 'Nested JSON API Response (1k items)',
    content: generateJsonDataset(),
  },
  code: {
    label: 'Python Script (500 lines)',
    content: generateCodeDataset(),
  },
  logs: {
    label: 'Dense System Logs (errors + verbose)',
    content: generateLogDataset(),
  },
  pdf_chunks: {
    label: 'PDF Chunks (upload a PDF)',
    content: '',
  },
}

function generateJsonDataset(): string {
  const users = Array.from({ length: 80 }, (_, i) => ({
    id: `usr_${crypto.randomUUID()}`,
    session_token: `tok_${Math.random().toString(36).slice(2, 34)}`,
    username: `user_${i + 1}`,
    email: `user${i + 1}@example.com`,
    created_at: new Date(Date.now() - Math.random() * 1e10).toISOString(),
    last_login: new Date(Date.now() - Math.random() * 1e8).toISOString(),
    profile: {
      full_name: `Test User ${i + 1}`,
      bio: `This is the biography for user ${i + 1}. They joined our platform and have been an active contributor since day one. Their interests include software engineering, open source development, and machine learning applications.`,
      location: ['New York', 'San Francisco', 'London', 'Berlin', 'Tokyo'][i % 5],
      avatar_url: `https://avatars.example.com/${crypto.randomUUID()}.png`,
    },
    preferences: {
      theme: ['dark', 'light', 'system'][i % 3],
      notifications_enabled: i % 2 === 0,
      language: 'en-US',
      timezone: 'America/New_York',
    },
    subscription: {
      plan: ['free', 'pro', 'enterprise'][i % 3],
      status: 'active',
      expires_at: new Date(Date.now() + 864e8).toISOString(),
      invoice_id: `inv_${crypto.randomUUID()}`,
    },
    metadata: {
      request_id: crypto.randomUUID(),
      trace_id: crypto.randomUUID(),
      version: '2.4.1',
      build: `build_${Math.floor(Math.random() * 9999)}`,
    },
  }))
  return JSON.stringify({ data: users, total: users.length, page: 1, per_page: 80 }, null, 2)
}

function generateCodeDataset(): string {
  return `#!/usr/bin/env python3
"""
Data processing pipeline for ML feature extraction.
Handles ingestion, transformation, and storage of raw event streams.
"""

import os
import sys
import json
import logging
import hashlib
import datetime
from typing import Optional, List, Dict, Any, Tuple
from dataclasses import dataclass, field
from pathlib import Path
from collections import defaultdict

logger = logging.getLogger(__name__)

@dataclass
class EventRecord:
    """Represents a single ingested event from the data stream."""
    event_id: str
    timestamp: datetime.datetime
    source: str
    event_type: str
    payload: Dict[str, Any]
    tags: List[str] = field(default_factory=list)
    processed: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "event_id": self.event_id,
            "timestamp": self.timestamp.isoformat(),
            "source": self.source,
            "event_type": self.event_type,
            "payload": self.payload,
            "tags": self.tags,
            "processed": self.processed,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "EventRecord":
        return cls(
            event_id=data["event_id"],
            timestamp=datetime.datetime.fromisoformat(data["timestamp"]),
            source=data["source"],
            event_type=data["event_type"],
            payload=data.get("payload", {}),
            tags=data.get("tags", []),
            processed=data.get("processed", False),
        )


class FeatureExtractor:
    """Extracts ML features from raw event records using configurable pipelines."""

    DEFAULT_WINDOW_SIZE = 3600  # 1 hour in seconds
    MAX_FEATURE_DIMS = 512

    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.window_size = config.get("window_size", self.DEFAULT_WINDOW_SIZE)
        self.feature_dims = config.get("feature_dims", self.MAX_FEATURE_DIMS)
        self._cache: Dict[str, Any] = {}
        self._stats = defaultdict(int)
        logger.info("FeatureExtractor initialized with window=%d dims=%d", self.window_size, self.feature_dims)

    def extract(self, records: List[EventRecord]) -> List[Dict[str, float]]:
        """Extract feature vectors from a batch of event records."""
        results = []
        for rec in records:
            try:
                feats = self._extract_single(rec)
                results.append(feats)
                self._stats["processed"] += 1
            except Exception as e:
                logger.warning("Failed to extract features for %s: %s", rec.event_id, e)
                self._stats["errors"] += 1
        return results

    def _extract_single(self, rec: EventRecord) -> Dict[str, float]:
        cache_key = hashlib.md5(json.dumps(rec.to_dict(), sort_keys=True).encode()).hexdigest()
        if cache_key in self._cache:
            self._stats["cache_hits"] += 1
            return self._cache[cache_key]

        features: Dict[str, float] = {}
        features["payload_size"] = float(len(json.dumps(rec.payload)))
        features["tag_count"] = float(len(rec.tags))
        features["hour_of_day"] = float(rec.timestamp.hour)
        features["day_of_week"] = float(rec.timestamp.weekday())
        features["is_error"] = 1.0 if "error" in rec.event_type.lower() else 0.0
        features["source_hash"] = float(int(hashlib.md5(rec.source.encode()).hexdigest()[:8], 16) % 1000)

        for k, v in rec.payload.items():
            if isinstance(v, (int, float)):
                features[f"payload_{k}"] = float(v)

        if len(features) > self.feature_dims:
            keys = sorted(features.keys())[:self.feature_dims]
            features = {k: features[k] for k in keys}

        self._cache[cache_key] = features
        return features

    def get_stats(self) -> Dict[str, int]:
        return dict(self._stats)

    def clear_cache(self) -> None:
        self._cache.clear()
        logger.debug("Feature cache cleared")


class DataPipeline:
    """Orchestrates the full ingestion → extraction → storage pipeline."""

    def __init__(self, extractor: FeatureExtractor, output_dir: Optional[Path] = None):
        self.extractor = extractor
        self.output_dir = output_dir or Path("./output")
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self._batch_size = 256

    def run(self, input_path: Path) -> Tuple[int, int]:
        """Process all records from input_path. Returns (processed, failed)."""
        processed = 0
        failed = 0
        batch: List[EventRecord] = []

        with open(input_path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                    record = EventRecord.from_dict(data)
                    batch.append(record)
                    if len(batch) >= self._batch_size:
                        p, e = self._flush_batch(batch)
                        processed += p
                        failed += e
                        batch = []
                except (json.JSONDecodeError, KeyError) as ex:
                    logger.error("Parse error: %s", ex)
                    failed += 1

        if batch:
            p, e = self._flush_batch(batch)
            processed += p
            failed += e

        logger.info("Pipeline complete: %d processed, %d failed", processed, failed)
        return processed, failed

    def _flush_batch(self, batch: List[EventRecord]) -> Tuple[int, int]:
        features = self.extractor.extract(batch)
        out_file = self.output_dir / f"features_{datetime.datetime.utcnow().strftime('%Y%m%d_%H%M%S_%f')}.jsonl"
        with open(out_file, "w") as f:
            for feat in features:
                f.write(json.dumps(feat) + "\\n")
        return len(features), len(batch) - len(features)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    config = {
        "window_size": 7200,
        "feature_dims": 256,
    }
    extractor = FeatureExtractor(config)
    pipeline = DataPipeline(extractor)
    input_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("events.jsonl")
    if not input_path.exists():
        logger.error("Input file not found: %s", input_path)
        sys.exit(1)
    processed, failed = pipeline.run(input_path)
    print(f"Done: {processed} processed, {failed} failed")
    print("Stats:", extractor.get_stats())


if __name__ == "__main__":
    main()
`
}

function generateLogDataset(): string {
  const lines: string[] = []
  const services = ['api-gateway', 'auth-service', 'db-proxy', 'cache-layer', 'worker-pool']
  const levels = ['INFO', 'DEBUG', 'DEBUG', 'DEBUG', 'WARN', 'ERROR']
  const now = Date.now()

  for (let i = 0; i < 200; i++) {
    const ts = new Date(now - (200 - i) * 1500).toISOString()
    const svc = services[i % services.length]
    const lvl = i % 7 === 0 ? 'ERROR' : i % 5 === 0 ? 'WARN' : i % 3 === 0 ? 'DEBUG' : 'INFO'

    if (lvl === 'ERROR') {
      lines.push(`${ts} [${lvl}] [${svc}] Request processing failed after 3 retries`)
      lines.push(`${ts} [${lvl}] [${svc}]   at processRequest (server.js:142:18)`)
      lines.push(`${ts} [${lvl}] [${svc}]   at async RequestHandler.handle (handler.js:87:5)`)
      lines.push(`${ts} [${lvl}] [${svc}]   at async Server.dispatch (server.js:63:12)`)
      lines.push(`${ts} [${lvl}] [${svc}] Error: ECONNREFUSED 127.0.0.1:5432 (postgres)`)
      lines.push(`${ts} [${lvl}] [${svc}] trace_id=${crypto.randomUUID()} span_id=${crypto.randomUUID().slice(0, 8)}`)
    } else if (lvl === 'WARN') {
      lines.push(`${ts} [${lvl}] [${svc}] Response time exceeded threshold: 2847ms > 2000ms`)
      lines.push(`${ts} [${lvl}] [${svc}] Cache miss rate: 73% (threshold: 50%)`)
    } else if (lvl === 'DEBUG') {
      lines.push(`${ts} [${lvl}] [${svc}] Handling incoming request method=GET path=/api/v2/users`)
      lines.push(`${ts} [${lvl}] [${svc}] Database query executed rows_returned=128 duration=14ms`)
      lines.push(`${ts} [${lvl}] [${svc}] Cache lookup key=usr:${crypto.randomUUID()} hit=false`)
    } else {
      lines.push(`${ts} [${lvl}] [${svc}] Request completed status=200 duration=87ms`)
      lines.push(`${ts} [${lvl}] [${svc}] Health check passed uptime=99.94% requests_total=${100000 + i * 47}`)
    }
  }

  return lines.join('\n')
}
