const express = require("express");
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");
const requireActiveUser = require("../middleware/requireActiveUser");
const requireSuperAdmin = require("../middleware/requireSuperAdmin");

const router = express.Router();
router.use(requireAuth);
router.use(requireActiveUser);

// GET /services — every active user can read the catalog (needed for the
// Services multi-select on the lead form). Only Super Admin can write to it.
router.get("/", async (req, res) => {
  const services = await db.service.findMany({ orderBy: { name: "asc" } });
  res.json({ success: true, services });
});

// POST /services — Super Admin only
router.post("/", requireSuperAdmin, async (req, res) => {
  const { name, amount } = req.body;
  const trimmedName = String(name || "").trim();
  const parsedAmount = parseInt(amount, 10);

  if (!trimmedName) return res.status(400).json({ success: false, message: "Service name is required" });
  if (!Number.isFinite(parsedAmount) || parsedAmount < 0) {
    return res.status(400).json({ success: false, message: "A valid amount is required" });
  }

  const existing = await db.service.findUnique({ where: { name: trimmedName } });
  if (existing) return res.status(409).json({ success: false, message: "A service with this name already exists" });

  const service = await db.service.create({ data: { name: trimmedName, amount: parsedAmount } });
  res.status(201).json({ success: true, service });
});

// PUT /services/:id — Super Admin only. Price changes take effect immediately
// for anyone selecting this service going forward (the "live" pricing model);
// leads that already picked it keep whatever amount they already saved.
router.put("/:id", requireSuperAdmin, async (req, res) => {
  const { name, amount } = req.body;
  const existing = await db.service.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ success: false, message: "Service not found" });

  const data = {};
  if (name !== undefined) {
    const trimmedName = String(name).trim();
    if (!trimmedName) return res.status(400).json({ success: false, message: "Service name can't be empty" });
    const clash = await db.service.findFirst({ where: { name: trimmedName, NOT: { id: req.params.id } } });
    if (clash) return res.status(409).json({ success: false, message: "A service with this name already exists" });
    data.name = trimmedName;
  }
  if (amount !== undefined) {
    const parsedAmount = parseInt(amount, 10);
    if (!Number.isFinite(parsedAmount) || parsedAmount < 0) {
      return res.status(400).json({ success: false, message: "A valid amount is required" });
    }
    data.amount = parsedAmount;
  }

  const service = await db.service.update({ where: { id: req.params.id }, data });
  res.json({ success: true, service });
});

// DELETE /services/:id — Super Admin only. Allowed even if this service is
// currently used on leads — their LeadServiceSelection rows just lose the
// serviceId link (set null by the schema's onDelete: SetNull) and keep
// showing the snapshot name they already had.
router.delete("/:id", requireSuperAdmin, async (req, res) => {
  const existing = await db.service.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ success: false, message: "Service not found" });

  await db.service.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});

module.exports = router;