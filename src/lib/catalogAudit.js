const db = require("../db");

// Don't log the same person sharing the same thing again within this window
// (share buttons get clicked repeatedly, which would otherwise flood the feed).
const SHARE_DEDUPE_MS = 10 * 60 * 1000;

function clean(value) {
  if (value instanceof Date) return value.toISOString();
  return value ?? null;
}

// Returns { field: { from, to } } for every listed field whose value changed.
function diffFields(before, after, fields) {
  const changes = {};
  for (const f of fields) {
    const b = clean(before[f]);
    const a = clean(after[f]);
    if (b !== a) changes[f] = { from: b, to: a };
  }
  return changes;
}

// Never throws — a failed audit write must not break the catalog operation
// that triggered it.
async function logCatalog({ entityType, entityId = null, entityName, action, changes = null, actorId }) {
  try {
    await db.catalogActivity.create({
      data: {
        entityType,
        entityId,
        entityName,
        action,
        ...(changes ? { changes } : {}),
        actorId,
      },
    });
  } catch (err) {
    console.error("catalog audit log failed:", err);
  }
}

async function logShare({ entityType, entityId = null, entityName, actorId }) {
  try {
    const recent = await db.catalogActivity.findFirst({
      where: {
        action: "SHARE",
        entityType,
        entityId,
        actorId,
        createdAt: { gte: new Date(Date.now() - SHARE_DEDUPE_MS) },
      },
      select: { id: true },
    });
    if (recent) return;
    await db.catalogActivity.create({
      data: { entityType, entityId, entityName, action: "SHARE", actorId },
    });
  } catch (err) {
    console.error("catalog share audit log failed:", err);
  }
}

module.exports = { logCatalog, logShare, diffFields };
