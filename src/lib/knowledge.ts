import { db, J } from "./db";

// Workspace-scoped knowledge store. Portable keyword retrieval (no vector DB required);
// a pgvector column can be added to knowledge_chunks later without changing this API.
// Retrieval NEVER crosses workspace boundaries.

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
  for (const p of parts) {
    await db.knowledgeChunk.create({
      data: {
        documentId: doc.id, version: doc.currentVersion, heading: p.heading,
        content: p.content, tokens: Math.ceil(p.content.length / 4),
        keywords: tokenize(p.content).slice(0, 60),
      },
    });
  }
  return { documentId: doc.id, version: doc.currentVersion, chunks: parts.length };
}

export interface RetrievedChunk {
  chunkId: string; documentTitle: string; source: string;
  heading: string | null; content: string; score: number;
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
      scored.push({
        chunkId: c.id, documentTitle: c.document.title, source: c.document.source.name,
        heading: c.heading, content: c.content, score: Math.round(finalScore * 100) / 100,
      });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

export function buildAuthorizedContext(chunks: RetrievedChunk[]): string {
  if (!chunks.length) return "";
  return chunks.map((c, i) => `[${i + 1}] (${c.source}/${c.documentTitle}${c.heading ? ` — ${c.heading}` : ""}) ${c.content}`).join("\n");
}
