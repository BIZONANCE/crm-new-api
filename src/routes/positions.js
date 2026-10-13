const express = require("express");
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");
const requireActiveUser = require("../middleware/requireActiveUser");
const requireSuperAdmin = require("../middleware/requireSuperAdmin");
const { PERMISSION_DEFS, PERMISSION_KEYS } = require("../lib/permissions");

const router = express.Router();
router.use(requireAuth);
router.use(requireActiveUser);

// Positions are shared, account-wide templates — only a Super Admin may
// create, rename, or delete them (requireSuperAdmin is applied per-route
// below for those). But an Account Admin needs to read the list in order
// to assign a position to their own team members, so GET is open to both
// admin roles rather than gated behind requireSuperAdmin like the rest of
// this router.
function requireAnyAdmin(req, res, next) {
  const role = req.userRecord.role;
  if (role !== "SUPER_ADMIN" && role !== "ACCOUNT_ADMIN") {
    return res.status(403).json({ success: false, message: "Admin access required" });
  }
  next();
}

function sanitizePermissions(input = {}) {
  const clean = {};
  for (const key of PERMISSION_KEYS) {
    clean[key] = !!input[key];
  }
  return clean;
}

// GET /positions — every custom position, plus the list of permission keys
// the frontend can render checkboxes for. Readable by Super Admin and
// Account Admin alike.
router.get("/", requireAnyAdmin, async (req, res) => {
  const positions = await db.position.findMany({ orderBy: { createdAt: "desc" } });
  res.json({ success: true, positions, availablePermissions: PERMISSION_DEFS });
});

// POST /positions — create a new position
router.post("/", requireSuperAdmin, async (req, res) => {
  const { name, permissions } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, message: "Name is required" });
  }

  const existing = await db.position.findUnique({ where: { name: name.trim() } });
  if (existing) {
    return res.status(409).json({ success: false, message: "A position with this name already exists" });
  }

  const position = await db.position.create({
    data: { name: name.trim(), permissions: sanitizePermissions(permissions) },
  });
  res.status(201).json({ success: true, position });
});

// PATCH /positions/:id — rename and/or change permission flags
router.patch("/:id", requireSuperAdmin, async (req, res) => {
  const { name, permissions } = req.body;
  const data = {};
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ success: false, message: "Name cannot be empty" });
    data.name = name.trim();
  }
  if (permissions !== undefined) {
    data.permissions = sanitizePermissions(permissions);
  }

  try {
    const position = await db.position.update({ where: { id: req.params.id }, data });
    res.json({ success: true, position });
  } catch (err) {
    res.status(404).json({ success: false, message: "Position not found" });
  }
});

// DELETE /positions/:id — refused if any user currently holds this position,
// so you can't silently strip someone's permissions by deleting it out from
// under them.
router.delete("/:id", requireSuperAdmin, async (req, res) => {
  const inUse = await db.user.count({ where: { positionId: req.params.id } });
  if (inUse > 0) {
    return res.status(400).json({ success: false, message: `Cannot delete — ${inUse} user(s) still hold this position` });
  }

  try {
    await db.position.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    res.status(404).json({ success: false, message: "Position not found" });
  }
});

module.exports = router;
