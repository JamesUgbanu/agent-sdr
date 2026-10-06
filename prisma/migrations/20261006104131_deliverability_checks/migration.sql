-- CreateTable
CREATE TABLE "DeliverabilityCheck" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "checks" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliverabilityCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliverabilityCheck_workspaceId_createdAt_idx" ON "DeliverabilityCheck"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "DeliverabilityCheck" ADD CONSTRAINT "DeliverabilityCheck_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
