const express = require("express");
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");
const requireActiveUser = require("../middleware/requireActiveUser");

const router = express.Router();
router.use(requireAuth);
router.use(requireActiveUser);

// Stopgap: hide "New login detected" notifications (existing rows included).
// Applied to BOTH the list and the unread count so the badge stays accurate.
// Once the code that creates these notifications is removed and old rows are
// cleaned up, delete this filter.
// Change "new login" to match your exact title text.
const HIDE_LOGIN_ALERTS = {
  NOT: { title: { contains: "new login", mode: "insensitive" } },
};

router.get("/", async (req, res) => {
  const notifications = await db.notification.findMany({
    where: { userId: req.userRecord.id, ...HIDE_LOGIN_ALERTS },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const unreadCount = await db.notification.count({
    where: { userId: req.userRecord.id, read: false, ...HIDE_LOGIN_ALERTS },
  });
  res.json({ success: true, notifications, unreadCount });
});

router.patch("/:id/read", async (req, res) => {
  const existing = await db.notification.findFirst({ where: { id: req.params.id } });
  if (!existing || existing.userId !== req.userRecord.id) {
    return res.status(404).json({ success: false, message: "Notification not found" });
  }
  const notification = await db.notification.update({
    where: { id: req.params.id },
    data: { read: true },
  });
  res.json({ success: true, notification });
});

router.post("/mark-all-read", async (req, res) => {
  await db.notification.updateMany({
    where: { userId: req.userRecord.id, read: false },
    data: { read: true },
  });
  res.json({ success: true });
});

// Deletes a single notification. Used when the user clicks a notification
// in the dropdown — the frontend removes it from view and calls this so it
// doesn't reappear on the next poll.
router.delete("/:id", async (req, res) => {
  const existing = await db.notification.findFirst({ where: { id: req.params.id } });
  if (!existing || existing.userId !== req.userRecord.id) {
    return res.status(404).json({ success: false, message: "Notification not found" });
  }
  await db.notification.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});

module.exports = router;
