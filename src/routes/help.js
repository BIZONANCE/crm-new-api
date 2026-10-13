const express = require("express");
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");
const requireActiveUser = require("../middleware/requireActiveUser");
const requireSuperAdmin = require("../middleware/requireSuperAdmin");
const { notify, notifyAllSuperAdmins } = require("../lib/notify");

const router = express.Router();
router.use(requireAuth);
router.use(requireActiveUser);

const STATUS_VALUES = ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"];
const PRIORITY_VALUES = ["LOW", "MEDIUM", "HIGH"];

const TICKET_INCLUDE = {
  createdBy: { select: { id: true, name: true, email: true, memberId: true, photoUrl: true } },
  assignedTo: { select: { id: true, name: true, email: true, memberId: true } },
};

const TICKET_INCLUDE_WITH_MESSAGES = {
  ...TICKET_INCLUDE,
  messages: {
    orderBy: { createdAt: "asc" },
    include: {
      sender: { select: { id: true, name: true, email: true, role: true, photoUrl: true } },
    },
  },
};

function isSuperAdmin(req) {
  return req.userRecord.role === "SUPER_ADMIN";
}

function assertAccess(req, ticket) {
  return isSuperAdmin(req) || ticket.createdById === req.userRecord.id;
}

// List tickets — Super Admin sees every ticket, members see only their own.
router.get("/tickets", async (req, res) => {
  const { status } = req.query;
  const where = {};
  if (status) {
    if (!STATUS_VALUES.includes(status.toUpperCase())) {
      return res.status(400).json({ success: false, message: "Invalid status filter" });
    }
    where.status = status.toUpperCase();
  }
  if (!isSuperAdmin(req)) where.createdById = req.userRecord.id;

  const tickets = await db.helpTicket.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    include: {
      ...TICKET_INCLUDE,
      messages: {
        orderBy: { createdAt: "desc" },
        take: 1,
        include: { sender: { select: { id: true, name: true, role: true } } },
      },
      _count: { select: { messages: true } },
    },
  });

  const withUnread = await Promise.all(
    tickets.map(async (t) => {
      const unread = await db.helpTicketMessage.count({
        where: { ticketId: t.id, read: false, senderId: { not: req.userRecord.id } },
      });
      return { ...t, unreadCount: unread };
    })
  );

  res.json({ success: true, tickets: withUnread });
});

// Total unread reply count across this user's visible tickets — powers the
// Sidebar badge the same way /mail/unread-count does for Mail.
router.get("/tickets/unread-count", async (req, res) => {
  const where = { read: false, senderId: { not: req.userRecord.id } };
  if (isSuperAdmin(req)) {
    // Super Admin's badge covers replies on any ticket.
  } else {
    where.ticket = { createdById: req.userRecord.id };
  }
  const count = await db.helpTicketMessage.count({ where });
  res.json({ success: true, count });
});

// Create a ticket — the first message body is required.
router.post("/tickets", async (req, res) => {
  const { subject, message, category, priority } = req.body;
  if (!subject || !String(subject).trim()) {
    return res.status(400).json({ success: false, message: "Subject is required" });
  }
  if (!message || !String(message).trim()) {
    return res.status(400).json({ success: false, message: "Please describe what you need help with" });
  }
  const cleanPriority =
    priority && PRIORITY_VALUES.includes(String(priority).toUpperCase())
      ? String(priority).toUpperCase()
      : "MEDIUM";

  const ticket = await db.helpTicket.create({
    data: {
      subject: subject.trim(),
      category: category ? String(category).trim() : null,
      priority: cleanPriority,
      createdById: req.userRecord.id,
      messages: {
        create: { senderId: req.userRecord.id, body: message.trim() },
      },
    },
    include: TICKET_INCLUDE_WITH_MESSAGES,
  });

  await notifyAllSuperAdmins({
    type: "HELP_TICKET_CREATED",
    title: "New help request",
    message: `${req.userRecord.name || req.userRecord.email} raised: ${ticket.subject}`,
    link: `/help/tickets/${ticket.id}`,
  });

  res.status(201).json({ success: true, ticket });
});

// Get one ticket with its full message thread. Marks the other party's
// messages as read.
router.get("/tickets/:id", async (req, res) => {
  const ticket = await db.helpTicket.findUnique({
    where: { id: req.params.id },
    include: TICKET_INCLUDE_WITH_MESSAGES,
  });
  if (!ticket) return res.status(404).json({ success: false, message: "Ticket not found" });
  if (!assertAccess(req, ticket)) {
    return res.status(403).json({ success: false, message: "You don't have access to this ticket" });
  }

  await db.helpTicketMessage.updateMany({
    where: { ticketId: ticket.id, senderId: { not: req.userRecord.id }, read: false },
    data: { read: true },
  });

  res.json({ success: true, ticket });
});

// Reply on a ticket.
router.post("/tickets/:id/messages", async (req, res) => {
  const { message } = req.body;
  if (!message || !String(message).trim()) {
    return res.status(400).json({ success: false, message: "Message can't be empty" });
  }

  const ticket = await db.helpTicket.findUnique({ where: { id: req.params.id } });
  if (!ticket) return res.status(404).json({ success: false, message: "Ticket not found" });
  if (!assertAccess(req, ticket)) {
    return res.status(403).json({ success: false, message: "You don't have access to this ticket" });
  }
  if (ticket.status === "CLOSED") {
    return res.status(400).json({ success: false, message: "This ticket is closed. Ask a Super Admin to reopen it." });
  }

  const replyingAsAdmin = isSuperAdmin(req);
  const data = {
    status: replyingAsAdmin ? "IN_PROGRESS" : ticket.status === "RESOLVED" ? "IN_PROGRESS" : ticket.status,
  };

  await db.helpTicketMessage.create({
    data: { ticketId: ticket.id, senderId: req.userRecord.id, body: message.trim() },
  });

  const updated = await db.helpTicket.update({
    where: { id: ticket.id },
    data,
    include: TICKET_INCLUDE_WITH_MESSAGES,
  });

  if (replyingAsAdmin) {
    await notify(ticket.createdById, {
      type: "HELP_TICKET_REPLY",
      title: "Reply to your help request",
      message: `${req.userRecord.name || req.userRecord.email} replied to "${ticket.subject}"`,
      link: `/help/tickets/${ticket.id}`,
    });
  } else if (ticket.assignedToId) {
    await notify(ticket.assignedToId, {
      type: "HELP_TICKET_REPLY",
      title: "New reply on a help request",
      message: `${req.userRecord.name || req.userRecord.email} replied to "${ticket.subject}"`,
      link: `/help/tickets/${ticket.id}`,
    });
  } else {
    await notifyAllSuperAdmins({
      type: "HELP_TICKET_REPLY",
      title: "New reply on a help request",
      message: `${req.userRecord.name || req.userRecord.email} replied to "${ticket.subject}"`,
      link: `/help/tickets/${ticket.id}`,
    });
  }

  res.status(201).json({ success: true, ticket: updated });
});

// Super Admin: change status / priority / assignment.
router.patch("/tickets/:id", requireSuperAdmin, async (req, res) => {
  const { status, priority, assignedToId } = req.body;
  const data = {};

  if (status !== undefined) {
    if (!STATUS_VALUES.includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status" });
    }
    data.status = status;
    data.closedAt = status === "CLOSED" ? new Date() : null;
  }
  if (priority !== undefined) {
    if (!PRIORITY_VALUES.includes(priority)) {
      return res.status(400).json({ success: false, message: "Invalid priority" });
    }
    data.priority = priority;
  }
  if (assignedToId !== undefined) {
    if (assignedToId) {
      const admin = await db.user.findUnique({ where: { id: assignedToId } });
      if (!admin || admin.role !== "SUPER_ADMIN") {
        return res.status(400).json({ success: false, message: "Tickets can only be assigned to a Super Admin" });
      }
    }
    data.assignedToId = assignedToId || null;
  }

  const existing = await db.helpTicket.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ success: false, message: "Ticket not found" });

  const ticket = await db.helpTicket.update({
    where: { id: req.params.id },
    data,
    include: TICKET_INCLUDE_WITH_MESSAGES,
  });

  if (status && status !== existing.status) {
    await notify(ticket.createdById, {
      type: "HELP_TICKET_STATUS",
      title: "Your help request was updated",
      message: `"${ticket.subject}" is now ${status.replace("_", " ").toLowerCase()}`,
      link: `/help/tickets/${ticket.id}`,
    });
  }

  res.json({ success: true, ticket });
});

// Super Admin: remove a ticket entirely.
router.delete("/tickets/:id", requireSuperAdmin, async (req, res) => {
  const existing = await db.helpTicket.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ success: false, message: "Ticket not found" });

  await db.helpTicket.delete({ where: { id: req.params.id } });
  res.json({ success: true, message: "Ticket deleted" });
});

module.exports = router;
