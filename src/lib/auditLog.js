const db = require("../db");

const IGNORED_FIELDS = new Set(["editedDate", "entryDate", "id", "ownerId"]);

function diffLead(before, after) {
  const changes = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (IGNORED_FIELDS.has(key)) continue;
    const beforeVal = before[key] ?? null;
    const afterVal = after[key] ?? null;
    const beforeCmp = beforeVal instanceof Date ? beforeVal.toISOString() : beforeVal;
    const afterCmp = afterVal instanceof Date ? afterVal.toISOString() : afterVal;
    if (beforeCmp !== afterCmp) {
      changes[key] = { from: beforeCmp, to: afterCmp };
    }
  }
  return changes;
}

function snapshotLead(lead) {
  const { id, ownerId, entryDate, editedDate, ...rest } = lead;
  return rest;
}

async function logCreate(lead, actorId) {
  await db.salesHistory.create({
    data: { leadId: lead.id, bizName: lead.bizName, action: "CREATE", changes: { snapshot: snapshotLead(lead) }, actorId },
  });
}

async function logUpdate(before, after, actorId) {
  const changes = diffLead(before, after);
  if (Object.keys(changes).length === 0) return;
  await db.salesHistory.create({
    data: { leadId: after.id, bizName: after.bizName, action: "UPDATE", changes, actorId },
  });
}

async function logDelete(lead, actorId) {
  await db.salesHistory.create({
    data: { leadId: lead.id, bizName: lead.bizName, action: "DELETE", changes: { snapshot: snapshotLead(lead) }, actorId },
  });
}

async function logRestore(lead, actorId) {
  await db.salesHistory.create({
    data: { leadId: lead.id, bizName: lead.bizName, action: "RESTORE", changes: null, actorId },
  });
}

module.exports = { logCreate, logUpdate, logDelete, logRestore, diffLead };
