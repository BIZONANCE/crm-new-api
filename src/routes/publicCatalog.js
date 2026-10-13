const express = require("express");
const db = require("../db");

const router = express.Router();

// Everything here is intentionally public — no requireAuth. A share link
// only ever exposes ACTIVE categories/items, never draft/inactive ones,
// and never anything beyond what the token/slug itself points at.

// Whole catalog: GET /public/catalog/:token
// Unchanged — the whole catalog has no name to slugify, so it keeps a
// random token rather than a readable slug.
router.get("/catalog/:token", async (req, res) => {
  const share = await db.catalogShare.findUnique({ where: { token: req.params.token } });
  if (!share) return res.status(404).json({ success: false, message: "This link is no longer valid" });

  const categories = await db.catalogCategory.findMany({
    where: { status: "ACTIVE" },
    orderBy: { sortOrder: "asc" },
    include: {
      items: {
        where: { status: "ACTIVE" },
        orderBy: { sortOrder: "asc" },
      },
    },
  });

  res.json({ success: true, categories });
});

// One collection: GET /public/collection/:slug
// Param renamed from :token to :slug for clarity — the lookup itself is
// unchanged, since the shareToken column now holds a human-readable slug
// for anything shared after the slug rollout (e.g. "festive-picks"), or a
// legacy random hex value for anything shared before it. Either way it's
// still just a value in the same unique column, so this keeps working for
// links generated under the old scheme too.
router.get("/collection/:slug", async (req, res) => {
  const category = await db.catalogCategory.findUnique({ where: { shareToken: req.params.slug } });
  if (!category || category.status !== "ACTIVE") {
    return res.status(404).json({ success: false, message: "This link is no longer valid" });
  }

  const items = await db.catalogItem.findMany({
    where: { categoryId: category.id, status: "ACTIVE" },
    orderBy: { sortOrder: "asc" },
  });

  res.json({ success: true, category, items });
});

// One item: GET /public/item/:slug
// Same rename/compatibility note as the collection route above.
router.get("/item/:slug", async (req, res) => {
  const item = await db.catalogItem.findUnique({
    where: { shareToken: req.params.slug },
    include: { category: { select: { id: true, name: true } } },
  });
  if (!item || item.status !== "ACTIVE") {
    return res.status(404).json({ success: false, message: "This link is no longer valid" });
  }

  res.json({ success: true, item });
});

module.exports = router;
