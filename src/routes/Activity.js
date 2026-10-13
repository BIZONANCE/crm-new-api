const express = require("express");
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");
const requireActiveUser = require("../middleware/requireActiveUser");

const router = express.Router();
router.use(requireAuth);
router.use(requireActiveUser);

router.get("/", async (req, res) => {
  const { leadId, action, from, to, actorId } = req.query;

  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

  const role = req.userRecord.role;

  // Activity feed is open to every active user — no permission gate.
  // Visibility is scoped below by role: Member sees only their own
  // activity, Account Admin sees their team's, Super Admin sees all.

  const isAdmin =
    role === "SUPER_ADMIN" || role === "ACCOUNT_ADMIN";

  const teamIds =
    role === "ACCOUNT_ADMIN"
      ? [
          req.userRecord.id,
          ...(req.userRecord.teamMembers || []).map((u) => u.id),
        ]
      : null;

  // ============================================
  // LEAD-SPECIFIC ACTIVITY ACCESS
  // ============================================
  if (leadId) {
    const lead = await db.lead.findFirst({
      where: { id: leadId },
    });

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    const owns =
      role === "SUPER_ADMIN" ||
      (role === "ACCOUNT_ADMIN" &&
        teamIds.includes(lead.assignedToId)) ||
      lead.assignedToId === req.userRecord.id;

    if (!owns) {
      return res.status(403).json({
        success: false,
        message: "You don't have access to this lead's history",
      });
    }
  }

  const where = {};

  if (leadId) where.leadId = leadId;
  if (actorId) where.actorId = actorId;
  if (action) where.action = action.toUpperCase();

  if (from || to) {
    where.createdAt = {};

    if (from) {
      where.createdAt.gte = new Date(from);
    }

    if (to) {
      where.createdAt.lte = new Date(to);
    }
  }

  // ============================================
  // ACTIVITY VISIBILITY
  // ============================================
  if (!leadId) {
    if (role === "ACCOUNT_ADMIN") {
      if (actorId) {
        // Account Admin can only filter to themselves
        // or someone in their team.
        if (!teamIds.includes(actorId)) {
          where.actorId = "__none__";
        }
      } else {
        where.actorId = {
          in: teamIds,
        };
      }
    } else if (role !== "SUPER_ADMIN") {
      // Member can only see their own activity.
      if (actorId && actorId !== req.userRecord.id) {
        where.actorId = "__none__";
      } else {
        where.actorId = req.userRecord.id;
      }
    }
  }

  const [entries, total] = await Promise.all([
    db.salesHistory.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        actor: {
          select: {
            id: true,
            name: true,
            email: true,
            status: true,
          },
        },
      },
    }),

    db.salesHistory.count({
      where,
    }),
  ]);

  res.json({
    success: true,
    entries,
    total,
    page,
    limit,
  });
});

// GET /activity/catalog — catalogue activity (items, collections, reorders,
// moves, shares). Same visibility rules as the lead feed above: Member sees
// their own, Account Admin sees their team's, Super Admin sees everything.
router.get("/catalog", async (req, res) => {
  const { action, entityType, from, to, actorId } = req.query;

  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

  const role = req.userRecord.role;

  const where = {};
  if (action) where.action = action.toUpperCase();
  if (entityType) where.entityType = entityType.toUpperCase();

  if (from || to) {
    where.createdAt = {};
    if (from) where.createdAt.gte = new Date(from);
    if (to) where.createdAt.lte = new Date(to);
  }

  if (role === "ACCOUNT_ADMIN") {
    const teamIds = [req.userRecord.id, ...(req.userRecord.teamMembers || []).map((u) => u.id)];
    if (actorId) {
      where.actorId = teamIds.includes(actorId) ? actorId : "__none__";
    } else {
      where.actorId = { in: teamIds };
    }
  } else if (role !== "SUPER_ADMIN") {
    where.actorId = !actorId || actorId === req.userRecord.id ? req.userRecord.id : "__none__";
  } else if (actorId) {
    where.actorId = actorId;
  }

  const [entries, total] = await Promise.all([
    db.catalogActivity.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        actor: { select: { id: true, name: true, email: true, status: true } },
      },
    }),
    db.catalogActivity.count({ where }),
  ]);

  res.json({ success: true, entries, total, page, limit });
});

module.exports = router;
