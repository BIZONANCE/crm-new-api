-- Add ACCOUNT_ADMIN role
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'ACCOUNT_ADMIN';

-- Add manager relationship to User
ALTER TABLE "User"
ADD COLUMN "managerId" TEXT;

-- Index for managerId
CREATE INDEX "User_managerId_idx" ON "User"("managerId");

-- Self-referencing foreign key
ALTER TABLE "User"
ADD CONSTRAINT "User_managerId_fkey"
FOREIGN KEY ("managerId")
REFERENCES "User"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;
