/*
  Warnings:

  - A unique constraint covering the columns `[seq]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "seq" SERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "User_seq_key" ON "User"("seq");
