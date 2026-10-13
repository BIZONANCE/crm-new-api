CREATE TABLE "CatalogActivity" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "entityName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "changes" JSONB,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogActivity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CatalogActivity_actorId_idx"
ON "CatalogActivity"("actorId");

CREATE INDEX "CatalogActivity_createdAt_idx"
ON "CatalogActivity"("createdAt");

ALTER TABLE "CatalogActivity"
ADD CONSTRAINT "CatalogActivity_actorId_fkey"
FOREIGN KEY ("actorId") REFERENCES "User"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;
