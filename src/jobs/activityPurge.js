const cron = require("node-cron");
const db = require("../db");

const ACTIVITY_RETENTION_DAYS = 15; // how long a sales-history activity log entry stays before it's gone for good
const LEAD_RETENTION_DAYS = 15;     // how long a soft-deleted lead stays recoverable before it's gone for good

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

async function purgeOldActivity() {
  const cutoff = daysAgo(ACTIVITY_RETENTION_DAYS);
  const result = await db.salesHistory.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  if (result.count > 0) {
    console.log(`[activity-purge] permanently deleted ${result.count} entr${result.count === 1 ? "y" : "ies"}`);
  }
}

// Permanently removes leads that have been sitting in the "deleted" state
// (deletedAt set, via DELETE /leads/:id or /leads/bulk-delete) for longer
// than LEAD_RETENTION_DAYS. Until this runs, a deleted lead is only
// soft-deleted and stays restorable via POST /leads/:id/restore — this is
// what actually enforces the "restore within N days" window the frontend
// promises on the delete-confirmation modal.
//
// db.lead.delete() cascades to that lead's Activity, LeadTransfer, and
// LeadServiceSelection rows (all onDelete: Cascade in the schema), so no
// extra cleanup queries are needed here. SalesHistory rows referencing this
// lead are untouched — leadId there is a plain field with no FK, by design,
// since Sales History needs to outlive the lead it was recorded against.
async function purgeDeletedLeads() {
  const cutoff = daysAgo(LEAD_RETENTION_DAYS);
  const stale = await db.lead.findMany({
    where: { deletedAt: { lt: cutoff } },
    select: { id: true },
  });
  if (stale.length === 0) return;

  const result = await db.lead.deleteMany({
    where: { id: { in: stale.map((l) => l.id) } },
  });
  if (result.count > 0) {
    console.log(`[lead-purge] permanently deleted ${result.count} lead${result.count === 1 ? "" : "s"}`);
  }
}

function scheduleActivityPurgeJob() {
  cron.schedule("15 2 * * *", async () => {
    try {
      await purgeOldActivity();
    } catch (err) {
      console.error("[activity-purge] job failed", err);
    }
  });
  console.log("[activity-purge] scheduled daily at 02:15");

  cron.schedule("20 2 * * *", async () => {
    try {
      await purgeDeletedLeads();
    } catch (err) {
      console.error("[lead-purge] job failed", err);
    }
  });
  console.log("[lead-purge] scheduled daily at 02:20");
}

module.exports = { scheduleActivityPurgeJob, purgeOldActivity, purgeDeletedLeads };
