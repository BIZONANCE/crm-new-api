const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");
const requireActiveUser = require("../middleware/requireActiveUser");
const requireSuperAdmin = require("../middleware/requireSuperAdmin");
const requirePermission = require("../middleware/requirePermission");
const { uploadImage } = require("../utils/mediaServer");
const { logCatalog, logShare, diffFields } = require("../lib/catalogAudit");

const router = express.Router();
router.use(requireAuth);
router.use(requireActiveUser);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) return cb(new Error("Only image files are allowed"));
    cb(null, true);
  },
});

// Short URL-safe token for share links. Reused once generated (see the
// share routes below) so a link never changes under the person who shared it.
function generateShareToken() {
  return crypto.randomBytes(12).toString("hex");
}

// crypto.randomBytes(12).toString("hex") — the old scheme — always produces
// exactly 24 lowercase hex characters with no hyphens. A real slug from
// slugify() below will effectively never match that shape (it needs a
// hyphen or a non-hex letter almost immediately for any real product
// name), so this safely tells apart "never shared" / "has a slug already"
// from "shared before the slug rollout, still holding the old random
// token." Used by the share routes to auto-upgrade legacy links instead of
// leaving them stuck on a random string forever.
const LEGACY_HEX_TOKEN_RE = /^[0-9a-f]{24}$/i;
function isLegacyHexToken(value) {
  return typeof value === "string" && LEGACY_HEX_TOKEN_RE.test(value);
}

// Strict integer parse for money fields. Unlike parseInt(), this rejects
// decimals, trailing junk ("199abc"), and empty strings instead of silently
// truncating/coercing them — price/discountedPrice are Int columns, so a
// value like "199.99" should be a validation error, not a silent floor().
function parseWholeNumber(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : NaN;
  }
  const str = String(value).trim();
  if (!/^\d+$/.test(str)) return NaN;
  return parseInt(str, 10);
}

// Turns a name into a URL-safe slug: lowercase, strip accents, collapse
// anything that isn't a-z0-9 into single hyphens, trim leading/trailing
// hyphens. Capped at 60 chars so a long product name doesn't produce an
// unwieldy URL.
function slugify(value) {
  return String(value)
    .toLowerCase()
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// Items live at "/Product/<slug>" and collections at "/Collection/<slug>"
// — separate prefixes, so a category and an item are free to share a name
// (e.g. a "Necklaces" collection and a "Necklace" item) without any real
// URL collision. This set just blocks a name from normalizing to one of
// the literal path segments themselves, so a slug never reads as
// confusingly self-referential (e.g. "/Product/product/BIPL-0002").
const RESERVED_SLUGS = new Set(["product", "collection", "catalog", "share", ""]);

function isReservedSlugName(name) {
  return RESERVED_SLUGS.has(slugify(name));
}

// Item titles are enforced globally unique (case-insensitive) so that
// "/Product/<slug>" always resolves to exactly one item — scoped to items
// only, not categories, since the two now live in separate URL prefixes.
// Category names already get the equivalent guarantee for free from their
// existing DB-level @unique constraint (see the P2002 handling below).
async function isItemTitleTaken(title, excludeItemId) {
  const hit = await db.catalogItem.findFirst({
    where: {
      title: { equals: title.trim(), mode: "insensitive" },
      ...(excludeItemId ? { id: { not: excludeItemId } } : {}),
    },
    select: { id: true },
  });
  return Boolean(hit);
}

// Freezes a name into its permanent public slug, called exactly once — the
// first time something is shared (see the share routes below, which only
// call this when shareToken is still empty). The slug is stored directly
// in the existing shareToken column, so no schema migration was needed:
// that column already carries a per-table unique index from the old
// random-hex-token scheme, which is exactly the guarantee a slug needs
// too. `model` is db.catalogCategory or db.catalogItem — whichever table
// this slug belongs to; collections and items each get their own
// independent slug namespace. Because names are already enforced unique
// before this ever runs, a collision here should be essentially
// impossible; the retry loop is a last-resort safety net against
// normalization edge cases (two differently-punctuated names that happen
// to normalize to the same slug), not the primary uniqueness guarantee.
async function reserveSlug(model, rawName) {
  const base = slugify(rawName) || "item";
  let candidate = base;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const taken = RESERVED_SLUGS.has(candidate) || (await model.findUnique({
      where: { shareToken: candidate },
      select: { id: true },
    }));
    if (!taken) return candidate;
    candidate = `${base}-${crypto.randomBytes(2).toString("hex")}`;
  }
  // Extremely unlikely fallback if the loop above never lands a free slug.
  return crypto.randomBytes(6).toString("hex");
}

// requireAuth only attaches the raw JWT payload to req.user — { id, email }
// — not the full DB row, so memberId has to be looked up separately here.
// Every share response below uses this to tell the frontend WHO generated
// the link, so the public URL can carry the sharer's memberId the same way
// "/submit-lead/:memberId" already does for leads. Returns null (never
// throws) if the lookup fails or the account has no memberId set, so a
// missing memberId degrades to a plain share link instead of a 500.
async function sharerMemberId(req) {
  if (!req.user?.id) return null;
  try {
    const user = await db.user.findUnique({
      where: { id: req.user.id },
      select: { memberId: true },
    });
    return user?.memberId || null;
  } catch {
    return null;
  }
}

// Plain-language snapshot of an item for the activity feed.
function itemSnapshot(item) {
  return {
    title: item.title,
    description: item.description || null,
    price: item.price,
    discountedPrice: item.discountedPrice ?? null,
    category: item.category?.name || null,
    image: item.imageUrl ? "Uploaded" : "None",
  };
}

// ---------- Categories ----------
// Browsing (GET) is open to any active user; mutating routes require the
// canManageCatalog permission (Super Admin always has it — see
// hasPermission — everyone else needs it via their assigned Position),
// applied per-route below rather than router-wide so the GETs stay
// available to regular members.

router.get("/categories", async (req, res) => {
  const categories = await db.catalogCategory.findMany({
    orderBy: { sortOrder: "asc" },
    include: { _count: { select: { items: true } } },
  });
  res.json({ success: true, categories });
});

router.post("/categories", requirePermission("canManageCatalog"), async (req, res) => {
  const { name } = req.body;
  const trimmedName = name ? String(name).trim() : "";
  if (!trimmedName) {
    return res.status(400).json({ success: false, message: "Category name is required" });
  }
  if (isReservedSlugName(trimmedName)) {
    return res.status(400).json({ success: false, message: "That name is reserved — please choose another" });
  }
  try {
    const count = await db.catalogCategory.count();
    const category = await db.catalogCategory.create({
      data: { name: trimmedName, sortOrder: count },
    });

    await logCatalog({
      entityType: "CATEGORY",
      entityId: category.id,
      entityName: category.name,
      action: "CREATE",
      changes: { snapshot: { name: category.name } },
      actorId: req.user.id,
    });

    res.status(201).json({ success: true, category: { ...category, _count: { items: 0 } } });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ success: false, message: "A category with this name already exists" });
    }
    console.error("create category error:", err);
    res.status(400).json({ success: false, message: "Could not create category" });
  }
});

// NOTE: must stay registered ABOVE "/categories/:id" — same routing-order
// reason as "/items/reorder" below: Express matches by registration order,
// so a PATCH to "/categories/reorder" would otherwise hit "/categories/:id"
// with id === "reorder" and 404.
//
// Persists a drag-reordered collection list. sortOrder is set to each
// category's index in the array, so [c, a, b] -> a:0, b:1, c:2, all in one
// transaction.
router.patch("/categories/reorder", requirePermission("canManageCatalog"), async (req, res) => {
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    return res.status(400).json({ success: false, message: "orderedIds is required" });
  }

  const categories = await db.catalogCategory.findMany({ where: { id: { in: orderedIds } } });
  if (categories.length !== orderedIds.length) {
    return res.status(400).json({ success: false, message: "One or more collections were not found" });
  }

  const nameById = Object.fromEntries(categories.map((c) => [c.id, c.name]));
  const fromOrder = [...categories].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).map((c) => c.name).join(", ");
  const toOrder = orderedIds.map((id) => nameById[id]).join(", ");

  await db.$transaction(
    orderedIds.map((id, index) =>
      db.catalogCategory.update({ where: { id }, data: { sortOrder: index } })
    )
  );

  if (fromOrder !== toOrder) {
    await logCatalog({
      entityType: "CATEGORY",
      entityName: "Collections order",
      action: "REORDER",
      changes: { order: { from: fromOrder, to: toOrder } },
      actorId: req.user.id,
    });
  }

  res.json({ success: true });
});

router.patch("/categories/:id", requirePermission("canManageCatalog"), async (req, res) => {
  const { name, status } = req.body;
  const data = {};
  if (name !== undefined) {
    const trimmedName = String(name).trim();
    if (!trimmedName) {
      return res.status(400).json({ success: false, message: "Category name is required" });
    }
    if (isReservedSlugName(trimmedName)) {
      return res.status(400).json({ success: false, message: "That name is reserved — please choose another" });
    }
    data.name = trimmedName;
  }
  if (status !== undefined) data.status = status;

  try {
    const existing = await db.catalogCategory.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ success: false, message: "Category not found" });

    const category = await db.catalogCategory.update({
      where: { id: req.params.id },
      data,
      include: { _count: { select: { items: true } } },
    });

    const changes = diffFields(existing, category, ["name", "status"]);
    if (Object.keys(changes).length > 0) {
      await logCatalog({
        entityType: "CATEGORY",
        entityId: category.id,
        entityName: category.name,
        action: "UPDATE",
        changes,
        actorId: req.user.id,
      });
    }

    res.json({ success: true, category });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ success: false, message: "A category with this name already exists" });
    }
    console.error("update category error:", err);
    res.status(400).json({ success: false, message: "Could not update category" });
  }
});

// Refuses to delete a category that still has items — the Super Admin has
// to move or delete those items first, same "clear it out before removal"
// pattern used for users still holding assigned leads.
router.delete("/categories/:id", requirePermission("canManageCatalog"), async (req, res) => {
  const itemCount = await db.catalogItem.count({ where: { categoryId: req.params.id } });
  if (itemCount > 0) {
    return res.status(400).json({
      success: false,
      message: "Move or delete this category's items before removing it",
    });
  }

  try {
    const existing = await db.catalogCategory.findUnique({ where: { id: req.params.id } });
    await db.catalogCategory.delete({ where: { id: req.params.id } });

    if (existing) {
      await logCatalog({
        entityType: "CATEGORY",
        entityId: existing.id,
        entityName: existing.name,
        action: "DELETE",
        changes: { snapshot: { name: existing.name } },
        actorId: req.user.id,
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("delete category error:", err);
    res.status(400).json({ success: false, message: "Could not delete category" });
  }
});

// Returns the collection's public slug (e.g. "festive-picks"), freezing
// one from the current name the first time this is called. Idempotent —
// calling this again just returns the same slug, so a link already shared
// never breaks even if the collection is renamed afterward. Also returns
// the CURRENT caller's memberId as `sharedBy` so the frontend can stamp
// the public URL ("/Collection/<slug>/<memberId>") with whoever generated
// this particular link click — the slug itself stays the same regardless
// of who asks for it. NOTE: sharing a collection link stays Super-Admin-
// only (requireSuperAdmin) — unlike sharing a single item below, which is
// open to any active user. That asymmetry existed before this permissions
// pass and is left unchanged.
router.post("/categories/:id/share", requireSuperAdmin, async (req, res) => {
  const category = await db.catalogCategory.findUnique({ where: { id: req.params.id } });
  if (!category) return res.status(404).json({ success: false, message: "Category not found" });

  let { shareToken: slug } = category;
  if (!slug || isLegacyHexToken(slug)) {
    slug = await reserveSlug(db.catalogCategory, category.name);
    await db.catalogCategory.update({ where: { id: category.id }, data: { shareToken: slug } });
  }

  await logShare({
    entityType: "CATEGORY",
    entityId: category.id,
    entityName: category.name,
    actorId: req.user.id,
  });

  res.json({ success: true, slug, sharedBy: await sharerMemberId(req) });
});

// ---------- Items ----------

router.get("/items", async (req, res) => {
  const { categoryId } = req.query;
  const where = categoryId ? { categoryId } : {};
  const items = await db.catalogItem.findMany({
    where,
    orderBy: { sortOrder: "asc" },
    include: { category: { select: { id: true, name: true } } },
  });
  res.json({ success: true, items });
});

// NOTE: this must stay registered ABOVE "/items/:id" and "/items/:id/share".
// Express matches routes in registration order, not by specificity, so if
// "/items/:id" comes first, a PATCH to "/items/reorder" matches it with
// id === "reorder" and 404s instead of ever reaching this handler.
//
// Persists a drag-reordered item list within one collection. Every id must
// already belong to categoryId — guards against a stale/tampered payload
// silently reordering the wrong collection. sortOrder is set to each item's
// index in the array, so [c, a, b] -> a:0, b:1, c:2... in one transaction.
router.patch("/items/reorder", requirePermission("canManageCatalog"), async (req, res) => {
  const { categoryId, orderedIds } = req.body;
  if (!categoryId || !Array.isArray(orderedIds) || orderedIds.length === 0) {
    return res.status(400).json({ success: false, message: "categoryId and orderedIds are required" });
  }

  const items = await db.catalogItem.findMany({ where: { id: { in: orderedIds } } });
  const allBelong =
    items.length === orderedIds.length && items.every((i) => i.categoryId === categoryId);
  if (!allBelong) {
    return res.status(400).json({ success: false, message: "Items don't match the given category" });
  }

  const titleById = Object.fromEntries(items.map((i) => [i.id, i.title]));
  const fromOrder = [...items].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).map((i) => i.title).join(", ");
  const toOrder = orderedIds.map((id) => titleById[id]).join(", ");

  await db.$transaction(
    orderedIds.map((id, index) =>
      db.catalogItem.update({ where: { id }, data: { sortOrder: index } })
    )
  );

  if (fromOrder !== toOrder) {
    const category = await db.catalogCategory.findUnique({ where: { id: categoryId }, select: { name: true } });
    await logCatalog({
      entityType: "ITEM",
      entityName: `Items in "${category?.name || "collection"}"`,
      action: "REORDER",
      changes: { order: { from: fromOrder, to: toOrder } },
      actorId: req.user.id,
    });
  }

  res.json({ success: true });
});

router.post("/items/bulk-delete", requirePermission("canManageCatalog"), async (req, res) => {
  const { itemIds } = req.body;
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    return res.status(400).json({ success: false, message: "No items selected" });
  }

  const targets = await db.catalogItem.findMany({
    where: { id: { in: itemIds } },
    select: { id: true, title: true },
  });

  const result = await db.catalogItem.deleteMany({ where: { id: { in: itemIds } } });

  if (result.count > 0) {
    await logCatalog({
      entityType: "ITEM",
      entityName: `${result.count} item${result.count !== 1 ? "s" : ""}`,
      action: "DELETE",
      changes: { snapshot: { count: result.count, items: targets.map((t) => t.title).join(", ") } },
      actorId: req.user.id,
    });
  }

  res.json({ success: true, deleted: result.count });
});

// Moves the selected items into categoryId, appending them to the END of
// that collection's existing order instead of leaving their old sortOrder
// values in place (which could collide with items already sitting there).
router.post("/items/bulk-move", requirePermission("canManageCatalog"), async (req, res) => {
  const { itemIds, categoryId } = req.body;
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    return res.status(400).json({ success: false, message: "No items selected" });
  }
  if (!categoryId) {
    return res.status(400).json({ success: false, message: "Select a category to move to" });
  }

  const category = await db.catalogCategory.findUnique({ where: { id: categoryId } });
  if (!category) return res.status(400).json({ success: false, message: "Invalid category" });

  const targets = await db.catalogItem.findMany({
    where: { id: { in: itemIds } },
    select: { id: true, title: true, category: { select: { name: true } } },
  });

  const existingCount = await db.catalogItem.count({ where: { categoryId } });

  const result = await db.$transaction(
    itemIds.map((id, index) =>
      db.catalogItem.update({
        where: { id },
        data: { categoryId, sortOrder: existingCount + index },
      })
    )
  );

  const sourceNames = [...new Set(targets.map((t) => t.category?.name).filter(Boolean))].join(", ");
  await logCatalog({
    entityType: "ITEM",
    entityName: `${result.length} item${result.length !== 1 ? "s" : ""}`,
    action: "MOVE",
    changes: {
      collection: { from: sourceNames || null, to: category.name },
      items: { from: null, to: targets.map((t) => t.title).join(", ") },
    },
    actorId: req.user.id,
  });

  res.json({ success: true, moved: result.length });
});

router.post("/items", requirePermission("canManageCatalog"), upload.single("image"), async (req, res) => {
  const { title, description, price, discountedPrice, categoryId } = req.body;
  if (!title || !String(title).trim()) {
    return res.status(400).json({ success: false, message: "Title is required" });
  }
  const trimmedTitle = String(title).trim();
  if (isReservedSlugName(trimmedTitle)) {
    return res.status(400).json({ success: false, message: "That name is reserved — please choose another" });
  }
  if (await isItemTitleTaken(trimmedTitle)) {
    return res.status(409).json({ success: false, message: "An item with this name already exists" });
  }
  if (!categoryId) {
    return res.status(400).json({ success: false, message: "A category is required" });
  }
  const parsedPrice = parseWholeNumber(price);
  if (Number.isNaN(parsedPrice) || parsedPrice < 0) {
    return res.status(400).json({ success: false, message: "A valid whole-number price is required" });
  }

  let parsedDiscounted = null;
  if (discountedPrice !== undefined && discountedPrice !== "" && discountedPrice !== null) {
    parsedDiscounted = parseWholeNumber(discountedPrice);
    if (Number.isNaN(parsedDiscounted) || parsedDiscounted < 0) {
      return res.status(400).json({ success: false, message: "A valid whole-number discounted price is required" });
    }
    if (parsedDiscounted > parsedPrice) {
      return res.status(400).json({ success: false, message: "Discounted price can't be higher than price" });
    }
  }

  const category = await db.catalogCategory.findUnique({ where: { id: categoryId } });
  if (!category) return res.status(400).json({ success: false, message: "Invalid category" });

  let imageUrl = null;
  if (req.file) {
    try {
      imageUrl = await uploadImage(req.file.buffer, req.file.originalname, req.file.mimetype);
    } catch (err) {
      console.error("catalog item image upload failed:", err);
      return res.status(502).json({ success: false, message: "Could not upload image" });
    }
  }

  const count = await db.catalogItem.count({ where: { categoryId } });
  const item = await db.catalogItem.create({
    data: {
      title: trimmedTitle,
      description: description ? String(description).trim() : null,
      price: parsedPrice,
      discountedPrice: parsedDiscounted,
      imageUrl,
      categoryId,
      sortOrder: count,
    },
    include: { category: { select: { id: true, name: true } } },
  });

  await logCatalog({
    entityType: "ITEM",
    entityId: item.id,
    entityName: item.title,
    action: "CREATE",
    changes: { snapshot: itemSnapshot(item) },
    actorId: req.user.id,
  });

  res.status(201).json({ success: true, item });
});

router.patch("/items/:id", requirePermission("canManageCatalog"), upload.single("image"), async (req, res) => {
  const existing = await db.catalogItem.findUnique({
    where: { id: req.params.id },
    include: { category: { select: { id: true, name: true } } },
  });
  if (!existing) return res.status(404).json({ success: false, message: "Item not found" });

  const { title, description, price, discountedPrice, categoryId, status } = req.body;
  const data = {};

  if (title !== undefined) {
    const trimmedTitle = String(title).trim();
    if (!trimmedTitle) {
      return res.status(400).json({ success: false, message: "Title is required" });
    }
    if (trimmedTitle.toLowerCase() !== existing.title.toLowerCase()) {
      if (isReservedSlugName(trimmedTitle)) {
        return res.status(400).json({ success: false, message: "That name is reserved — please choose another" });
      }
      if (await isItemTitleTaken(trimmedTitle, existing.id)) {
        return res.status(409).json({ success: false, message: "An item with this name already exists" });
      }
    }
    data.title = trimmedTitle;
  }
  if (description !== undefined) data.description = description ? String(description).trim() : null;
  if (status !== undefined) data.status = status;

  if (price !== undefined) {
    const parsedPrice = parseWholeNumber(price);
    if (Number.isNaN(parsedPrice) || parsedPrice < 0) {
      return res.status(400).json({ success: false, message: "A valid whole-number price is required" });
    }
    data.price = parsedPrice;
  }

  if (discountedPrice !== undefined) {
    if (discountedPrice === "" || discountedPrice === null) {
      data.discountedPrice = null;
    } else {
      const parsedDiscounted = parseWholeNumber(discountedPrice);
      const comparePrice = data.price !== undefined ? data.price : existing.price;
      if (Number.isNaN(parsedDiscounted) || parsedDiscounted < 0) {
        return res.status(400).json({ success: false, message: "A valid whole-number discounted price is required" });
      }
      if (parsedDiscounted > comparePrice) {
        return res.status(400).json({ success: false, message: "Discounted price can't be higher than price" });
      }
      data.discountedPrice = parsedDiscounted;
    }
  }

  if (categoryId !== undefined) {
    const category = await db.catalogCategory.findUnique({ where: { id: categoryId } });
    if (!category) return res.status(400).json({ success: false, message: "Invalid category" });
    data.categoryId = categoryId;
  }

  if (req.file) {
    try {
      data.imageUrl = await uploadImage(req.file.buffer, req.file.originalname, req.file.mimetype);
    } catch (err) {
      console.error("catalog item image upload failed:", err);
      return res.status(502).json({ success: false, message: "Could not upload image" });
    }
  }

  const item = await db.catalogItem.update({
    where: { id: req.params.id },
    data,
    include: { category: { select: { id: true, name: true } } },
  });

  const changes = diffFields(existing, item, ["title", "description", "price", "discountedPrice", "status"]);
  if (existing.categoryId !== item.categoryId) {
    changes.category = { from: existing.category?.name || null, to: item.category?.name || null };
  }
  if (req.file) {
    changes.image = {
      from: existing.imageUrl ? "Previous image" : "No image",
      to: "New image uploaded",
    };
  }
  if (Object.keys(changes).length > 0) {
    await logCatalog({
      entityType: "ITEM",
      entityId: item.id,
      entityName: item.title,
      action: "UPDATE",
      changes,
      actorId: req.user.id,
    });
  }

  res.json({ success: true, item });
});

router.delete("/items/:id", requirePermission("canManageCatalog"), async (req, res) => {
  const existing = await db.catalogItem.findUnique({
    where: { id: req.params.id },
    include: { category: { select: { id: true, name: true } } },
  });
  if (!existing) return res.status(404).json({ success: false, message: "Item not found" });

  await db.catalogItem.delete({ where: { id: req.params.id } });

  await logCatalog({
    entityType: "ITEM",
    entityId: existing.id,
    entityName: existing.title,
    action: "DELETE",
    changes: { snapshot: itemSnapshot(existing) },
    actorId: req.user.id,
  });

  res.json({ success: true });
});

// Returns the item's public slug (e.g. "wireless-earbuds"), freezing one
// from the current title the first time this is called — same idempotent,
// rename-safe pattern as the category share route above. Open to any
// active user (no permission gate) — sharing a single item's link has
// always been open, unlike sharing a whole collection above.
router.post("/items/:id/share", async (req, res) => {
  const item = await db.catalogItem.findUnique({ where: { id: req.params.id } });
  if (!item) return res.status(404).json({ success: false, message: "Item not found" });

  let { shareToken: slug } = item;
  if (!slug || isLegacyHexToken(slug)) {
    slug = await reserveSlug(db.catalogItem, item.title);
    await db.catalogItem.update({ where: { id: item.id }, data: { shareToken: slug } });
  }

  await logShare({
    entityType: "ITEM",
    entityId: item.id,
    entityName: item.title,
    actorId: req.user.id,
  });

  res.json({ success: true, slug, sharedBy: await sharerMemberId(req) });
});

// Whole-catalog share. There's no per-business/tenant model in this app, so
// this is a single reused row — the first call creates it, every call after
// just returns the same token. Open to any active user, same as item share.
router.post("/share", async (req, res) => {
  let share = await db.catalogShare.findFirst();
  if (!share) {
    share = await db.catalogShare.create({ data: { token: generateShareToken() } });
  }

  await logShare({
    entityType: "CATALOG",
    entityName: "Entire catalogue",
    actorId: req.user.id,
  });

  res.json({ success: true, token: share.token, sharedBy: await sharerMemberId(req) });
});

// Multer errors (bad mimetype from fileFilter, file too large, etc.) throw
// before reaching the route handlers above and would otherwise fall through
// to Express's default HTML error page. Catch them here and reply with the
// same { success, message } shape the frontend already expects everywhere
// else, so err.response?.data?.message actually resolves to something.
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ success: false, message: "Image must be 5MB or smaller" });
    }
    return res.status(400).json({ success: false, message: err.message });
  }
  if (err) {
    return res.status(400).json({ success: false, message: err.message || "Request failed" });
  }
  next();
});

module.exports = router;
