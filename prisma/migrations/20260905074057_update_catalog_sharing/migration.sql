ALTER TABLE "CatalogCategory"
ADD COLUMN "shareToken" TEXT;

CREATE UNIQUE INDEX "CatalogCategory_shareToken_key"
ON "CatalogCategory"("shareToken");

ALTER TABLE "CatalogItem"
ADD COLUMN "discountedPrice" INTEGER;

ALTER TABLE "CatalogItem"
ADD COLUMN "shareToken" TEXT;

CREATE UNIQUE INDEX "CatalogItem_shareToken_key"
ON "CatalogItem"("shareToken");

CREATE TABLE "CatalogShare" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogShare_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CatalogShare_token_key"
ON "CatalogShare"("token");
