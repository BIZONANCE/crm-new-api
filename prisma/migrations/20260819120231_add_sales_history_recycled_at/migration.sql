-- AlterTable
ALTER TABLE "SalesHistory" ADD COLUMN     "recycledAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "SalesHistory_recycledAt_idx" ON "SalesHistory"("recycledAt");
