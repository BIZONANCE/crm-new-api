const cron = require("node-cron");
const db = require("../db");
const { notify } = require("../lib/notify");

function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// "Today's Follow-up" reminder — one notification per DCR lead whose
// followup date is today, sent to whoever it's assigned to. Mirrors the
// isToday() check already used on the frontend's DCR tab.
async function sendFollowupReminders() {
  const leads = await db.lead.findMany({
    where: { section: "DCR", status: "ACTIVE", followup: { not: null }, assignedToId: { not: null } },
    select: { id: true, bizName: true, followup: true, assignedToId: true },
  });

  const today = new Date();
  const dueToday = leads.filter((l) => isSameDay(new Date(l.followup), today));

  for (const l of dueToday) {
    await notify(l.assignedToId, {
      type: "FOLLOWUP_DUE",
      title: "Follow-up due today",
      message: `${l.bizName} has a follow-up scheduled for today`,
      link: "/leads/dcr?tab=today-followup",
    });
  }

  if (dueToday.length > 0) {
    console.log(`[notification-reminders] sent ${dueToday.length} follow-up reminder(s)`);
  }
}

// "Renewal due within 7 days" — DSR leads with a renewalDate 0-7 days out.
// Mirrors statusFor()'s "amber" bucket on the frontend Renewals view.
async function sendRenewalReminders() {
  const now = new Date();
  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const leads = await db.lead.findMany({
    where: {
      section: "DSR",
      renewalDate: { gte: now, lte: in7Days },
      assignedToId: { not: null },
    },
    select: { id: true, bizName: true, renewalDate: true, assignedToId: true },
  });

  for (const l of leads) {
    const daysLeft = Math.ceil((new Date(l.renewalDate) - now) / (1000 * 60 * 60 * 24));
    await notify(l.assignedToId, {
      type: "RENEWAL_DUE",
      title: "Renewal due soon",
      message: `${l.bizName}'s renewal is due in ${daysLeft} day${daysLeft !== 1 ? "s" : ""}`,
      link: "/leads/dsr?tab=renewals",
    });
  }

  if (leads.length > 0) {
    console.log(`[notification-reminders] sent ${leads.length} renewal reminder(s)`);
  }
}

// Runs once a day at 7:00 AM server time — early enough that reminders are
// waiting before the team's day starts, offset from the 2:15 AM recycle job.
function scheduleReminderJobs() {
  cron.schedule("0 7 * * *", async () => {
    try {
      await sendFollowupReminders();
      await sendRenewalReminders();
    } catch (err) {
      console.error("[notification-reminders] job failed", err);
    }
  });
  console.log("[notification-reminders] scheduled daily at 07:00");
}

module.exports = { scheduleReminderJobs, sendFollowupReminders, sendRenewalReminders };
