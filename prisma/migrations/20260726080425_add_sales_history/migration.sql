-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE');

-- CreateTable
CREATE TABLE "SalesHistory" (
    "id" TEXT NOT NULL,
    "leadId" TEXT,
    "bizName" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "changes" JSONB,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SalesHistory_leadId_idx" ON "SalesHistory"("leadId");

-- CreateIndex
CREATE INDEX "SalesHistory_actorId_idx" ON "SalesHistory"("actorId");

-- CreateIndex
CREATE INDEX "SalesHistory_createdAt_idx" ON "SalesHistory"("createdAt");

-- AddForeignKey
ALTER TABLE "SalesHistory" ADD CONSTRAINT "SalesHistory_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
