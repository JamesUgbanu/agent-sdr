-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "source" TEXT;

-- CreateIndex
CREATE INDEX "Lead_campaignId_source_idx" ON "Lead"("campaignId", "source");
