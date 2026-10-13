const express = require("express");
const db = require("../db");

const router = express.Router();

// GET /public/services — read-only, no auth. Powers the "Product Interested
// In" suggestions on the public lead form. Reads from the Product Catalogue
// (same source as the authenticated /catalog/items route) rather than the
// old, now-unused Service table. Deliberately omits price fields so
// pricing isn't exposed to anyone holding the link — `name` here is the
// catalog item's `title`, kept as `name` so the public form doesn't need
// any changes.
router.get("/", async (req, res) => {
  const items = await db.catalogItem.findMany({
    orderBy: { title: "asc" },
    select: { id: true, title: true },
  });
  const services = items.map((i) => ({ id: i.id, name: i.title }));
  res.json({ success: true, services });
});

module.exports = router;
