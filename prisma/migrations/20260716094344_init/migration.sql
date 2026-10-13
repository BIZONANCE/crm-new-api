-- CreateEnum
CREATE TYPE "Section" AS ENUM ('FRESH', 'DCR', 'DSR');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Otp" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Otp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "bizName" TEXT NOT NULL,
    "ownerName" TEXT NOT NULL,
    "contact" TEXT NOT NULL,
    "altContact" TEXT,
    "city" TEXT NOT NULL,
    "pin" TEXT NOT NULL,
    "address" TEXT,
    "category" TEXT NOT NULL,
    "website" TEXT,
    "google" TEXT,
    "fb" TEXT,
    "insta" TEXT,
    "youtube" TEXT,
    "linkedin" TEXT,
    "product" TEXT,
    "amount" INTEGER,
    "response" TEXT,
    "lastCall" TIMESTAMP(3),
    "followup" TIMESTAMP(3),
    "takenCall" INTEGER,
    "meetingStatus" TEXT,
    "dealDuration" TEXT,
    "renewalDate" TIMESTAMP(3),
    "closedDate" TIMESTAMP(3),
    "remark" TEXT,
    "section" "Section" NOT NULL DEFAULT 'FRESH',
    "entryDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedDate" TIMESTAMP(3) NOT NULL,
    "ownerId" TEXT NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Otp_email_idx" ON "Otp"("email");

-- CreateIndex
CREATE INDEX "Lead_ownerId_idx" ON "Lead"("ownerId");

-- CreateIndex
CREATE INDEX "Lead_section_idx" ON "Lead"("section");

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
