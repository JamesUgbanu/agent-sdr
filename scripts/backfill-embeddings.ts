// Backfill chunk embeddings for documents ingested before embeddings existed.
// Usage: npx tsx scripts/backfill-embeddings.ts [workspaceId]
// Idempotent: only touches chunks with no embedding yet.
import { backfillKnowledgeEmbeddings } from "../src/lib/knowledge";

async function main() {
  const workspaceId = process.argv[2];
  let total = 0;
  for (let round = 0; round < 100; round++) {
    const r = await backfillKnowledgeEmbeddings(workspaceId, 50);
    total += r.embedded;
    console.log(`round ${round}: embedded=${r.embedded} skipped=${r.skipped}`);
    if (r.embedded === 0) break;
  }
  console.log(`done. total embedded: ${total}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
