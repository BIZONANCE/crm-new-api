-- Restore Service table
CREATE TABLE "Service" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Service_name_key" ON "Service"("name");

-- Help ticket enums
CREATE TYPE "HelpTicketStatus" AS ENUM (
    'OPEN',
    'IN_PROGRESS',
    'RESOLVED',
    'CLOSED'
);

CREATE TYPE "HelpTicketPriority" AS ENUM (
    'LOW',
    'MEDIUM',
    'HIGH'
);

-- HelpTicket table
CREATE TABLE "HelpTicket" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "category" TEXT,
    "priority" "HelpTicketPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "HelpTicketStatus" NOT NULL DEFAULT 'OPEN',
    "createdById" TEXT NOT NULL,
    "assignedToId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "HelpTicket_pkey" PRIMARY KEY ("id")
);

-- HelpTicketMessage table
CREATE TABLE "HelpTicketMessage" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HelpTicketMessage_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "HelpTicket_createdById_idx"
    ON "HelpTicket"("createdById");

CREATE INDEX "HelpTicket_assignedToId_idx"
    ON "HelpTicket"("assignedToId");

CREATE INDEX "HelpTicket_status_idx"
    ON "HelpTicket"("status");

CREATE INDEX "HelpTicketMessage_ticketId_idx"
    ON "HelpTicketMessage"("ticketId");

-- Foreign keys
ALTER TABLE "HelpTicket"
    ADD CONSTRAINT "HelpTicket_createdById_fkey"
    FOREIGN KEY ("createdById")
    REFERENCES "User"("id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE;

ALTER TABLE "HelpTicket"
    ADD CONSTRAINT "HelpTicket_assignedToId_fkey"
    FOREIGN KEY ("assignedToId")
    REFERENCES "User"("id")
    ON DELETE SET NULL
    ON UPDATE CASCADE;

ALTER TABLE "HelpTicketMessage"
    ADD CONSTRAINT "HelpTicketMessage_ticketId_fkey"
    FOREIGN KEY ("ticketId")
    REFERENCES "HelpTicket"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;

ALTER TABLE "HelpTicketMessage"
    ADD CONSTRAINT "HelpTicketMessage_senderId_fkey"
    FOREIGN KEY ("senderId")
    REFERENCES "User"("id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE;
