const express = require("express");
const fs = require("fs");
const path = require("path");
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");
const requireActiveUser = require("../middleware/requireActiveUser");
const { notify } = require("../lib/notify");
const { uploadMailAttachments, MAIL_UPLOAD_DIR } = require("../lib/mailStorage");

const router = express.Router();
router.use(requireAuth);
router.use(requireActiveUser);

const SENDER_INCLUDE = { select: { id: true, name: true, email: true, memberId: true } };

const MESSAGE_INCLUDE = {
  fromUser: SENDER_INCLUDE,
  attachments: true,
  recipients: { include: { toUser: SENDER_INCLUDE } },
};

async function assertThreadAccess(rootId, userId) {
  const messages = await db.message.findMany({
    where: { OR: [{ id: rootId }, { threadId: rootId }] },
    include: MESSAGE_INCLUDE,
    orderBy: { createdAt: "asc" },
  });
  if (messages.length === 0) return null;

  const isParticipant = messages.some(
    (m) => m.fromUserId === userId || m.recipients.some((r) => r.toUserId === userId)
  );
  if (!isParticipant) return null;

  return messages;
}

// Lightweight count for the sidebar badge — avoids the sidebar pulling
// full thread payloads (recipients, attachments, bodies) every poll.
router.get("/unread-count", async (req, res) => {
  const count = await db.messageRecipient.count({
    where: { toUserId: req.user.id, read: false, deletedByRecipient: false },
  });
  res.json({ success: true, count });
});

// Recipient picker for Compose — deliberately separate from GET /users
// (which only returns MEMBER-role users for the Manage Users page). Mail
// needs every active user regardless of role, so a member can message the
// Super Admin and vice versa.
router.get("/contacts", async (req, res) => {
  const users = await db.user.findMany({
    where: { status: "ACTIVE", id: { not: req.user.id } },
    select: { id: true, name: true, email: true, memberId: true, role: true },
    orderBy: { name: "asc" },
  });
  res.json({ success: true, users });
});

// ── Inbox: one row per thread I'm a participant in, newest activity first ──
router.get("/inbox", async (req, res) => {
  const myRows = await db.messageRecipient.findMany({
    where: { toUserId: req.user.id, deletedByRecipient: false },
    include: { message: { include: MESSAGE_INCLUDE } },
    orderBy: { message: { createdAt: "desc" } },
  });

  const threads = new Map();
  for (const row of myRows) {
    const rootId = row.message.threadId || row.message.id;
    if (!threads.has(rootId)) {
      threads.set(rootId, {
        rootId,
        subject: row.message.threadId ? null : row.message.subject, // filled in below if root not in myRows
        lastMessage: row.message,
        unreadCount: 0,
        starred: false,
        attachmentCount: 0,
      });
    }
    const t = threads.get(rootId);
    if (row.message.createdAt > t.lastMessage.createdAt) t.lastMessage = row.message;
    if (!row.read) t.unreadCount++;
    t.attachmentCount += row.message.attachments.length;
    if (rootId === row.message.id) {
      t.subject = row.message.subject;
      t.starred = row.starred;
    }
  }

  // Root subject/star might not be in myRows (I only received a reply, not
  // the original) — backfill those from the root message directly.
  const missingSubjects = [...threads.values()].filter((t) => t.subject === null);
  if (missingSubjects.length) {
    const roots = await db.message.findMany({
      where: { id: { in: missingSubjects.map((t) => t.rootId) } },
      select: { id: true, subject: true },
    });
    const subjectById = new Map(roots.map((r) => [r.id, r.subject]));
    missingSubjects.forEach((t) => (t.subject = subjectById.get(t.rootId) || "(no subject)"));
  }

  const list = [...threads.values()].sort(
    (a, b) => new Date(b.lastMessage.createdAt) - new Date(a.lastMessage.createdAt)
  );
  res.json({ success: true, threads: list });
});

// ── Sent: root messages I authored ──
router.get("/sent", async (req, res) => {
  const messages = await db.message.findMany({
    where: { fromUserId: req.user.id, threadId: null, deletedBySender: false },
    include: MESSAGE_INCLUDE,
    orderBy: { createdAt: "desc" },
  });
  res.json({ success: true, messages });
});

// ── Trash: threads I've soft-deleted, from either side ──
// A thread can land here two ways: I deleted it as a recipient (my
// MessageRecipient rows are flagged deletedByRecipient), or I deleted a
// thread I authored from Sent (the root message is flagged deletedBySender).
// Both are merged into one list, deduped by rootId, since a thread I both
// sent and later deleted from a reply I received should show once.
router.get("/trash", async (req, res) => {
  const userId = req.user.id;

  const recipientRows = await db.messageRecipient.findMany({
    where: { toUserId: userId, deletedByRecipient: true },
    include: { message: { include: MESSAGE_INCLUDE } },
    orderBy: { message: { createdAt: "desc" } },
  });

  const sentRoots = await db.message.findMany({
    where: { fromUserId: userId, threadId: null, deletedBySender: true },
    include: MESSAGE_INCLUDE,
    orderBy: { createdAt: "desc" },
  });

  const threads = new Map();

  for (const row of recipientRows) {
    const rootId = row.message.threadId || row.message.id;
    if (!threads.has(rootId)) {
      threads.set(rootId, {
        rootId,
        subject: null,
        lastMessage: row.message,
        starred: row.starred,
        attachmentCount: 0,
        deletedAsRecipient: true,
        deletedAsSender: false,
      });
    }
    const t = threads.get(rootId);
    if (row.message.createdAt > t.lastMessage.createdAt) t.lastMessage = row.message;
    t.attachmentCount += row.message.attachments.length;
    t.deletedAsRecipient = true;
    if (rootId === row.message.id) {
      t.subject = row.message.subject;
      t.starred = row.starred;
    }
  }

  for (const root of sentRoots) {
    const rootId = root.id;
    if (!threads.has(rootId)) {
      threads.set(rootId, {
        rootId,
        subject: root.subject,
        lastMessage: root,
        starred: false,
        attachmentCount: root.attachments.length,
        deletedAsRecipient: false,
        deletedAsSender: true,
      });
    } else {
      const t = threads.get(rootId);
      t.deletedAsSender = true;
      if (t.subject === null) t.subject = root.subject;
    }
  }

  const missingSubjects = [...threads.values()].filter((t) => t.subject === null);
  if (missingSubjects.length) {
    const roots = await db.message.findMany({
      where: { id: { in: missingSubjects.map((t) => t.rootId) } },
      select: { id: true, subject: true },
    });
    const subjectById = new Map(roots.map((r) => [r.id, r.subject]));
    missingSubjects.forEach((t) => (t.subject = subjectById.get(t.rootId) || "(no subject)"));
  }

  const list = [...threads.values()].sort(
    (a, b) => new Date(b.lastMessage.createdAt) - new Date(a.lastMessage.createdAt)
  );
  res.json({ success: true, threads: list });
});

// ── Full thread ──
router.get("/thread/:rootId", async (req, res) => {
  const messages = await assertThreadAccess(req.params.rootId, req.user.id);
  if (!messages) return res.status(404).json({ success: false, message: "Thread not found" });
  res.json({ success: true, messages });
});

// ── Mark every message in a thread read for me ──
router.patch("/thread/:rootId/read", async (req, res) => {
  const messages = await assertThreadAccess(req.params.rootId, req.user.id);
  if (!messages) return res.status(404).json({ success: false, message: "Thread not found" });

  await db.messageRecipient.updateMany({
    where: { messageId: { in: messages.map((m) => m.id) }, toUserId: req.user.id, read: false },
    data: { read: true, readAt: new Date() },
  });
  res.json({ success: true });
});

// ── Star/unstar a thread (upsert against the root message) ──
router.patch("/thread/:rootId/star", async (req, res) => {
  const messages = await assertThreadAccess(req.params.rootId, req.user.id);
  if (!messages) return res.status(404).json({ success: false, message: "Thread not found" });

  const starred = !!req.body.starred;
  await db.messageRecipient.upsert({
    where: { messageId_toUserId: { messageId: req.params.rootId, toUserId: req.user.id } },
    update: { starred },
    create: { messageId: req.params.rootId, toUserId: req.user.id, starred, read: true },
  });
  res.json({ success: true, starred });
});

// ── Soft-delete a thread from my view only (moves it to Trash) ──
router.delete("/thread/:rootId", async (req, res) => {
  const messages = await assertThreadAccess(req.params.rootId, req.user.id);
  if (!messages) return res.status(404).json({ success: false, message: "Thread not found" });

  await db.messageRecipient.updateMany({
    where: { messageId: { in: messages.map((m) => m.id) }, toUserId: req.user.id },
    data: { deletedByRecipient: true },
  });
  const rootMsg = messages.find((m) => m.id === req.params.rootId);
  if (rootMsg && rootMsg.fromUserId === req.user.id) {
    await db.message.update({ where: { id: rootMsg.id }, data: { deletedBySender: true } });
  }
  res.json({ success: true });
});

// ── Restore a thread out of Trash, for whichever side(s) I'd deleted it ──
router.post("/thread/:rootId/restore", async (req, res) => {
  const rootId = req.params.rootId;
  const userId = req.user.id;

  const messages = await db.message.findMany({
    where: { OR: [{ id: rootId }, { threadId: rootId }] },
  });
  if (messages.length === 0) return res.status(404).json({ success: false, message: "Thread not found" });

  const root = messages.find((m) => m.id === rootId);
  let restored = false;

  if (root && root.fromUserId === userId && root.deletedBySender) {
    await db.message.update({ where: { id: rootId }, data: { deletedBySender: false } });
    restored = true;
  }

  const myDeletedRows = await db.messageRecipient.findMany({
    where: { messageId: { in: messages.map((m) => m.id) }, toUserId: userId, deletedByRecipient: true },
  });
  if (myDeletedRows.length > 0) {
    await db.messageRecipient.updateMany({
      where: { id: { in: myDeletedRows.map((r) => r.id) } },
      data: { deletedByRecipient: false },
    });
    restored = true;
  }

  if (!restored) {
    return res.status(404).json({ success: false, message: "Nothing to restore for this thread" });
  }

  res.json({ success: true });
});

// ── Permanently delete a thread from Trash ──
// If I authored the root, this removes the whole thread — every reply and
// every recipient's copy — since there's no independent per-mailbox storage
// for a thread beyond the message records themselves. If I'm only a
// recipient, this removes just my own association; the thread stays intact
// for the sender and any other recipients.
router.delete("/thread/:rootId/permanent", async (req, res) => {
  const rootId = req.params.rootId;
  const userId = req.user.id;

  const messages = await db.message.findMany({
    where: { OR: [{ id: rootId }, { threadId: rootId }] },
    include: { attachments: true },
  });
  if (messages.length === 0) return res.status(404).json({ success: false, message: "Thread not found" });

  const root = messages.find((m) => m.id === rootId);
  const isRootSender = root && root.fromUserId === userId;

  if (isRootSender) {
    for (const m of messages) {
      for (const att of m.attachments) {
        const fullPath = path.join(MAIL_UPLOAD_DIR, att.filePath);
        if (fs.existsSync(fullPath)) {
          try {
            fs.unlinkSync(fullPath);
          } catch (err) {
            console.error("attachment unlink failed:", err);
          }
        }
      }
    }
    const messageIds = messages.map((m) => m.id);
    await db.messageAttachment.deleteMany({ where: { messageId: { in: messageIds } } });
    await db.messageRecipient.deleteMany({ where: { messageId: { in: messageIds } } });
    await db.message.deleteMany({ where: { id: { in: messageIds } } });
  } else {
    const myRows = await db.messageRecipient.findMany({
      where: { messageId: { in: messages.map((m) => m.id) }, toUserId: userId },
    });
    if (myRows.length === 0) {
      return res.status(403).json({ success: false, message: "You don't have access to this thread" });
    }
    await db.messageRecipient.deleteMany({ where: { id: { in: myRows.map((r) => r.id) } } });
  }

  res.json({ success: true });
});

// ── Compose a new thread ──
router.post("/", uploadMailAttachments.array("attachments", 5), async (req, res) => {
  try {
    const { subject, body, broadcast } = req.body;
    let recipientIds = req.body.recipientIds;
    if (typeof recipientIds === "string") recipientIds = JSON.parse(recipientIds || "[]");

    if (!subject?.trim() || !body?.trim()) {
      return res.status(400).json({ success: false, message: "Subject and message body are required" });
    }

    const isBroadcast = broadcast === "true" || broadcast === true;
    if (isBroadcast && req.userRecord.role !== "SUPER_ADMIN") {
      return res.status(403).json({ success: false, message: "Only a Super Admin can message all users" });
    }

    let targets;
    if (isBroadcast) {
      targets = await db.user.findMany({
        where: { status: "ACTIVE", id: { not: req.user.id } },
        select: { id: true },
      });
    } else {
      if (!Array.isArray(recipientIds) || recipientIds.length === 0) {
        return res.status(400).json({ success: false, message: "Select at least one recipient" });
      }
      targets = await db.user.findMany({
        where: { id: { in: recipientIds }, status: "ACTIVE" },
        select: { id: true },
      });
      if (targets.length === 0) {
        return res.status(400).json({ success: false, message: "No valid recipients found" });
      }
    }

    const message = await db.message.create({
      data: {
        subject: subject.trim(),
        body: body.trim(),
        fromUserId: req.user.id,
        isBroadcast,
        recipients: { create: targets.map((u) => ({ toUserId: u.id })) },
        attachments: {
          create: (req.files || []).map((f) => ({
            fileName: f.originalname,
            filePath: f.filename,
            fileSize: f.size,
            mimeType: f.mimetype,
          })),
        },
      },
      include: MESSAGE_INCLUDE,
    });

    for (const u of targets) {
      await notify(u.id, {
        type: "MAIL_RECEIVED",
        title: isBroadcast ? "New announcement" : "New message",
        message: `${req.userRecord.name || req.userRecord.email}: ${subject.trim()}`,
        link: `/mail/thread/${message.id}`,
      });
    }

    res.status(201).json({ success: true, message });
  } catch (err) {
    console.error("compose mail error:", err);
    res.status(400).json({ success: false, message: "Could not send message" });
  }
});

// ── Reply within a thread ──
router.post("/thread/:rootId/reply", uploadMailAttachments.array("attachments", 5), async (req, res) => {
  try {
    const { body } = req.body;
    if (!body?.trim()) {
      return res.status(400).json({ success: false, message: "Message body is required" });
    }

    const existing = await assertThreadAccess(req.params.rootId, req.user.id);
    if (!existing) return res.status(404).json({ success: false, message: "Thread not found" });

    // Default recipients = everyone who's touched this thread, minus me.
    let recipientIds = req.body.recipientIds;
    let targetIds;
    if (recipientIds) {
      targetIds = JSON.parse(recipientIds).filter((id) => id !== req.user.id);
    } else {
      const participantIds = new Set();
      existing.forEach((m) => {
        participantIds.add(m.fromUserId);
        m.recipients.forEach((r) => participantIds.add(r.toUserId));
      });
      participantIds.delete(req.user.id);
      targetIds = [...participantIds];
    }

    const rootSubject = existing.find((m) => m.id === req.params.rootId).subject;

    const reply = await db.message.create({
      data: {
        subject: rootSubject,
        body: body.trim(),
        fromUserId: req.user.id,
        threadId: req.params.rootId,
        recipients: { create: targetIds.map((id) => ({ toUserId: id })) },
        attachments: {
          create: (req.files || []).map((f) => ({
            fileName: f.originalname,
            filePath: f.filename,
            fileSize: f.size,
            mimeType: f.mimetype,
          })),
        },
      },
      include: MESSAGE_INCLUDE,
    });

    for (const id of targetIds) {
      await notify(id, {
        type: "MAIL_RECEIVED",
        title: "New reply",
        message: `${req.userRecord.name || req.userRecord.email} replied: ${rootSubject}`,
        link: `/mail/thread/${req.params.rootId}`,
      });
    }

    res.status(201).json({ success: true, message: reply });
  } catch (err) {
    console.error("reply mail error:", err);
    res.status(400).json({ success: false, message: "Could not send reply" });
  }
});

// ── Download an attachment — auth-checked, not statically served ──
router.get("/attachments/:attachmentId", async (req, res) => {
  const attachment = await db.messageAttachment.findUnique({
    where: { id: req.params.attachmentId },
    include: { message: { include: { recipients: true } } },
  });
  if (!attachment) return res.status(404).json({ success: false, message: "File not found" });

  const isSender = attachment.message.fromUserId === req.user.id;
  const isRecipient = attachment.message.recipients.some((r) => r.toUserId === req.user.id);
  if (!isSender && !isRecipient) {
    return res.status(403).json({ success: false, message: "You don't have access to this file" });
  }

  const fullPath = path.join(MAIL_UPLOAD_DIR, attachment.filePath);
  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ success: false, message: "File no longer exists" });
  }
  res.download(fullPath, attachment.fileName);
});

module.exports = router;
