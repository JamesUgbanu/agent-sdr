CREATE EXTENSION IF NOT EXISTS vector;

-- AlterTable
ALTER TABLE "KnowledgeChunk" ADD COLUMN     "embeddedAt" TIMESTAMP(3),
ADD COLUMN     "embedding" vector(1536),
ADD COLUMN     "embeddingModel" TEXT;
