const cron = require("node-cron");
const db = require("../db");

const RETENTION_DAYS = 20; // days a soft-deleted lead stays restorable before permanent purge

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

// Hard-deletes leads whose soft-delete grace period has expired. This cascades
// to their Activity, LeadTransfer, and LeadServiceSelection rows.
async function purgeOldDeletedLeads() {
  const cutoff = daysAgo(RETENTION_DAYS);
  const result = await db.lead.deleteMany({
    where: { deletedAt: { lt: cutoff } },
  });
  if (result.count > 0) {
    console.log(`[lead-purge] permanently deleted ${result.count} lead${result.count === 1 ? "" : "s"}`);
  }
}

function scheduleLeadPurgeJob() {
  cron.schedule("30 2 * * *", async () => {
    try {
      await purgeOldDeletedLeads();
    } catch (err) {
      console.error("[lead-purge] job failed", err);
    }
  });
  console.log("[lead-purge] scheduled daily at 02:30");
}

module.exports = { scheduleLeadPurgeJob, purgeOldDeletedLeads };
