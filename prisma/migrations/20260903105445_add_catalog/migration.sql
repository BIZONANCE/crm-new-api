CREATE TYPE "CatalogStatus" AS ENUM ('ACTIVE', 'INACTIVE');

CREATE TABLE "CatalogCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" "CatalogStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogCategory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CatalogItem" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "price" INTEGER NOT NULL,
    "imageUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" "CatalogStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CatalogCategory_name_key" ON "CatalogCategory"("name");

CREATE INDEX "CatalogItem_categoryId_idx" ON "CatalogItem"("categoryId");

ALTER TABLE "CatalogItem"
ADD CONSTRAINT "CatalogItem_categoryId_fkey"
FOREIGN KEY ("categoryId") REFERENCES "CatalogCategory"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
