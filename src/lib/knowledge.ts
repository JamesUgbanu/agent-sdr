import { db, J } from "./db";

// Workspace-scoped knowledge store with hybrid retrieval:
// keyword (portable, always available) + pgvector cosine (when embeddings exist).
// Retrieval NEVER crosses workspace boundaries. API unchanged from the
// keyword-only era: callers get ranked chunks with evidence references.

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMS = 1536;
const EMBED_WEIGHT = 1.0; // semantic contribution added to keyword score

type EmbedFn = (texts: string[]) => Promise<number[][] | null>;
let embedOverride: EmbedFn | null = null;
// Test hook only: deterministic vectors without API keys.
export function __setEmbedOverride(fn: EmbedFn | null) {
  embedOverride = fn;
}

async function embedTexts(texts: string[]): Promise<number[][] | null> {
  if (embedOverride) return embedOverride(texts);
  const key = process.env.OPENAI_API_KEY;
  if (!key || texts.length === 0) return null;
  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: key });
    const r = await client.embeddings.create({ model: EMBEDDING_MODEL, input: texts });
    const vecs = r.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    if (vecs.some((v) => v.length !== EMBEDDING_DIMS)) return null;
    return vecs;
  } catch {
    return null; // embeddings unavailable → keyword-only retrieval
  }
}

function toVectorLiteral(vec: number[]): string | null {
  if (vec.length !== EMBEDDING_DIMS || vec.some((n) => !Number.isFinite(n))) return null;
  return `[${vec.join(",")}]`;
}

async function storeChunkEmbeddings(chunkIds: string[], vectors: number[][]): Promise<void> {
  for (let i = 0; i < chunkIds.length; i++) {
    const lit = toVectorLiteral(vectors[i]!);
    if (!lit) continue;
    try {
      await db.$executeRaw`UPDATE "KnowledgeChunk" SET embedding = ${lit}::vector, "embeddingModel" = ${EMBEDDING_MODEL}, "embeddedAt" = NOW() WHERE id = ${chunkIds[i]}`;
    } catch { /* a single failed row must not break ingestion */ }
  }
}

// Backfill embeddings for chunks created before embeddings were enabled (or
// when the embedding model changes). Idempotent: only touches NULL rows.
export async function backfillKnowledgeEmbeddings(workspaceId?: string, batchSize = 50): Promise<{ embedded: number; skipped: boolean }> {
  const rows = await db.knowledgeChunk.findMany({
    where: {
      embeddingModel: null,
      document: workspaceId ? { source: { workspaceId } } : undefined,
    },
    select: { id: true, content: true },
    take: batchSize,
  }).catch(() => []);
  if (!rows.length) return { embedded: 0, skipped: false };
  const vecs = await embedTexts(rows.map((r) => r.content));
  if (!vecs) return { embedded: 0, skipped: true };
  await storeChunkEmbeddings(rows.map((r) => r.id), vecs);
  return { embedded: rows.length, skipped: false };
}

const STOP = new Set(
  "the,a,an,and,or,to,of,in,on,for,with,is,are,was,were,it,its,this,that,these,those,you,your,we,our,they,their,he,she,at,by,from,as,be,have,has,do,does,did,what,how,much,does,can,i,me,my".split(","),
);

export function tokenize(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s$%.-]/g, " ").split(/\s+/)
    .map((t) => t.trim()).filter((t) => t.length > 2 && !STOP.has(t));
}

function chunkText(content: string, maxLen = 600): Array<{ heading?: string; content: string }> {
  const chunks: Array<{ heading?: string; content: string }> = [];
  const sections = content.split(/\n\s*\n/);
  let current = "", heading: string | undefined;
  for (const s of sections) {
    const line = s.trim();
    if (!line) continue;
    if (/^#{1,3}\s/.test(line) && current) {
      chunks.push({ heading, content: current.trim() });
      current = ""; heading = line.replace(/^#{1,3}\s/, "").slice(0, 120);
      continue;
    }
    if ((current + "\n" + line).length > maxLen && current) {
      chunks.push({ heading, content: current.trim() });
      current = line;
    } else {
      current += (current ? "\n" : "") + line;
    }
  }
  if (current.trim()) chunks.push({ heading, content: current.trim() });
  return chunks.length ? chunks : [{ content: content.slice(0, maxLen) }];
}

export async function upsertKnowledgeDocument(opts: {
  workspaceId: string; source: string; sourceKind?: string;
  title: string; content: string; createdBy?: string;
}): Promise<{ documentId: string; version: number; chunks: number }> {
  const source = await db.knowledgeSource.upsert({
    where: { workspaceId_name: { workspaceId: opts.workspaceId, name: opts.source } },
    update: {},
    create: { workspaceId: opts.workspaceId, name: opts.source, kind: opts.sourceKind ?? "other" },
  });
  let doc = await db.knowledgeDocument.findFirst({
    where: { sourceId: source.id, title: opts.title },
  });
  if (!doc) {
    doc = await db.knowledgeDocument.create({
      data: { sourceId: source.id, title: opts.title, currentVersion: 1 },
    });
  } else {
    await db.knowledgeDocument.update({ where: { id: doc.id }, data: { currentVersion: { increment: 1 } } });
    doc = (await db.knowledgeDocument.findUnique({ where: { id: doc.id } }))!;
  }
  await db.knowledgeVersion.create({
    data: { documentId: doc.id, version: doc.currentVersion, content: opts.content, createdBy: opts.createdBy },
  });
  // New version supersedes old chunks (old version retained in knowledge_versions for rollback).
  await db.knowledgeChunk.deleteMany({ where: { documentId: doc.id } });
  const parts = chunkText(opts.content);
  const createdIds: string[] = [];
  for (const p of parts) {
    const row = await db.knowledgeChunk.create({
      data: {
        documentId: doc.id, version: doc.currentVersion, heading: p.heading,
        content: p.content, tokens: Math.ceil(p.content.length / 4),
        keywords: tokenize(p.content).slice(0, 60),
      },
    });
    createdIds.push(row.id);
  }
  // Best-effort semantic index (awaited so callers see a consistent index;
  // failures leave keyword-only chunks behind — never fail ingestion).
  try {
    const vecs = await embedTexts(parts.map((p) => `${p.heading ?? ""}\n${p.content}`.slice(0, 8000)));
    if (vecs) await storeChunkEmbeddings(createdIds, vecs);
  } catch { /* keyword retrieval remains fully functional */ }
  return { documentId: doc.id, version: doc.currentVersion, chunks: parts.length };
}

export interface RetrievedChunk {
  chunkId: string; documentTitle: string; source: string;
  heading: string | null; content: string; score: number;
  retrieval?: "keyword" | "vector" | "hybrid";
  vectorSim?: number;
}

export async function retrieveKnowledge(
  workspaceId: string,
  query: string,
  opts?: { topK?: number; minScore?: number; kinds?: string[] },
): Promise<RetrievedChunk[]> {
  const topK = opts?.topK ?? 3;
  const minScore = opts?.minScore ?? 0.12;
  const queryTokens = new Set(tokenize(query));
  if (!queryTokens.size) return [];
  const chunks = await db.knowledgeChunk.findMany({
    where: {
      document: {
        source: {
          workspaceId, // workspace isolation enforced at the query level
          ...(opts?.kinds?.length ? { kind: { in: opts.kinds } } : {}),
        },
      },
    },
    include: { document: { include: { source: true } } },
    take: 500,
  });
  const scored: RetrievedChunk[] = [];
  const byId = new Map<string, RetrievedChunk & { kw: number }>();
  for (const c of chunks) {
    const kw = new Set(c.keywords);
    let hit = 0;
    for (const t of queryTokens) if (kw.has(t)) hit++;
    const score = hit / Math.sqrt(queryTokens.size * Math.max(1, kw.size)) * 4;
    // price-intent boost: pricing questions must surface pricing sources
    const priceQ = /pric|cost|quote|plan|tier|fee|charge/.test(query.toLowerCase());
    const priceDoc = c.document.source.kind === "pricing" || c.document.source.name === "pricing";
    const finalScore = score + (priceQ && priceDoc ? 0.15 : 0);
    if (finalScore >= minScore) {
      const row: RetrievedChunk & { kw: number } = {
        chunkId: c.id, documentTitle: c.document.title, source: c.document.source.name,
        heading: c.heading, content: c.content, score: Math.round(finalScore * 100) / 100,
        retrieval: "keyword", kw: finalScore,
      };
      scored.push(row);
      byId.set(c.id, row);
    }
  }

  // Vector leg: cosine similarity over pgvector, merged additively. Any
  // failure (no key, no extension, no vectors) degrades to keyword-only.
  try {
    const qvecs = await embedTexts([query]);
    const qlit = qvecs?.[0] ? toVectorLiteral(qvecs[0]) : null;
    if (qlit) {
      const rows = await db.$queryRaw<Array<{ id: string; sim: number }>>`
        SELECT kc.id, 1 - (kc.embedding <=> ${qlit}::vector) AS sim
        FROM "KnowledgeChunk" kc
        JOIN "KnowledgeDocument" kd ON kd.id = kc."documentId"
        JOIN "KnowledgeSource" ks ON ks.id = kd."sourceId"
        WHERE ks."workspaceId" = ${workspaceId} AND kc.embedding IS NOT NULL
        ORDER BY kc.embedding <=> ${qlit}::vector
        LIMIT ${Math.max(topK * 3, 10)}`;
      const kinds = opts?.kinds?.length ? new Set(opts.kinds) : null;
      const byChunkId = new Map(chunks.map((c) => [c.id, c]));
      for (const r of rows) {
        const c = byChunkId.get(r.id);
        if (!c) continue;
        if (kinds && !kinds.has(c.document.source.kind)) continue;
        const sim = Math.round(r.sim * 100) / 100;
        const existing = byId.get(r.id);
        if (existing) {
          existing.score = Math.round((existing.kw + sim * EMBED_WEIGHT) * 100) / 100;
          existing.retrieval = "hybrid";
          existing.vectorSim = sim;
        } else if (sim * EMBED_WEIGHT >= minScore * 0.5) {
          // Semantic-only hit: no keyword overlap, but clearly relevant.
          // Admitted at half the keyword threshold to preserve recall for
          // paraphrases while keeping the bar above noise.
          const row: RetrievedChunk & { kw: number } = {
            chunkId: c.id, documentTitle: c.document.title, source: c.document.source.name,
            heading: c.heading, content: c.content,
            score: Math.round(sim * EMBED_WEIGHT * 100) / 100,
            retrieval: "vector", vectorSim: sim, kw: 0,
          };
          scored.push(row);
          byId.set(r.id, row);
        }
      }
    }
  } catch { /* vector leg optional — keyword results stand */ }

  for (const s of scored) delete (s as Partial<{ kw: number }>).kw;
  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

export function buildAuthorizedContext(chunks: RetrievedChunk[]): string {
  if (!chunks.length) return "";
  return chunks.map((c, i) => `[${i + 1}] (${c.source}/${c.documentTitle}${c.heading ? ` — ${c.heading}` : ""}) ${c.content}`).join("\n");
}
