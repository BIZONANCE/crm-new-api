-- Replace the old Service relation with CatalogItem

ALTER TABLE "LeadServiceSelection"
ADD COLUMN "catalogItemId" TEXT;

ALTER TABLE "LeadServiceSelection"
DROP CONSTRAINT "LeadServiceSelection_serviceId_fkey";

DROP INDEX IF EXISTS "LeadServiceSelection_serviceId_idx";

ALTER TABLE "LeadServiceSelection"
DROP COLUMN "serviceId";

CREATE INDEX "LeadServiceSelection_catalogItemId_idx"
ON "LeadServiceSelection"("catalogItemId");

ALTER TABLE "LeadServiceSelection"
ADD CONSTRAINT "LeadServiceSelection_catalogItemId_fkey"
FOREIGN KEY ("catalogItemId")
REFERENCES "CatalogItem"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;

ALTER TABLE "LeadServiceSelection"
DROP CONSTRAINT IF EXISTS "LeadServiceSelection_serviceId_fkey";

DROP TABLE "Service";
