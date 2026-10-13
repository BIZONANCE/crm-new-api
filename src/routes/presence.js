const express = require("express");
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");
const requireActiveUser = require("../middleware/requireActiveUser");

const router = express.Router();
router.use(requireAuth);
router.use(requireActiveUser);

// Shrunk from 2 minutes to 8 seconds so status flips within a few seconds —
// kept slightly above the frontend's 3s heartbeat interval to tolerate a
// missed beat or two without flickering someone offline who's still there.
const LIVE_THRESHOLD_MS = 8 * 1000;

// GET /presence — live users + offline users.
// Super Admin sees every active Member AND every active Account Admin —
// the whole company below themselves. Account Admin sees only their own
// team (Members whose managerId points at them) — never the whole company,
// and never other Account Admins. Excludes the viewer's own role from the
// query in both cases: an admin's own live dot is noise, not useful data.
router.get("/", async (req, res) => {
  const role = req.userRecord.role;
  if (role !== "SUPER_ADMIN" && role !== "ACCOUNT_ADMIN") {
    return res.status(403).json({ success: false, message: "Admin access required" });
  }

  const liveSince = new Date(Date.now() - LIVE_THRESHOLD_MS);

  const where =
    role === "ACCOUNT_ADMIN"
      ? { role: "MEMBER", status: "ACTIVE", managerId: req.userRecord.id }
      : { role: { in: ["MEMBER", "ACCOUNT_ADMIN"] }, status: "ACTIVE" };

  const allUsers = await db.user.findMany({
    where,
    select: { id: true, name: true, email: true, memberId: true, role: true, lastSeenAt: true },
    orderBy: { name: "asc" },
  });

  const liveUsers = allUsers
    .filter((u) => u.lastSeenAt && u.lastSeenAt >= liveSince)
    .sort((a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt));

  const liveIds = new Set(liveUsers.map((u) => u.id));
  const offlineUsers = allUsers.filter((u) => !liveIds.has(u.id));

  res.json({
    success: true,
    liveUsers,
    offlineUsers,
    totalUsers: allUsers.length,
  });
});

// POST /presence/heartbeat — lightweight ping the frontend calls every few
// seconds while the app is open, regardless of whether the user is actually
// clicking anything. requireAuth already bumps lastSeenAt as a fire-and-
// forget side effect on every authenticated request, so this route's body
// does nothing extra — its only job is to give the frontend something cheap
// to hit on an interval.
router.post("/heartbeat", (req, res) => {
  res.json({ success: true });
});

// POST /presence/logout — writes the LOGOUT event AND immediately clears
// lastSeenAt, so the person drops off the "live" list the instant they log
// out instead of lingering until their last heartbeat ages past the
// threshold.
router.post("/logout", async (req, res) => {
  await db.$transaction([
    db.sessionLog.create({ data: { userId: req.userRecord.id, type: "LOGOUT" } }),
    db.user.update({ where: { id: req.userRecord.id }, data: { lastSeenAt: null } }),
  ]);
  res.json({ success: true });
});

module.exports = router;
