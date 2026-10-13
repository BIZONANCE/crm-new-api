const express = require("express");
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");
const requireActiveUser = require("../middleware/requireActiveUser");
const { hasPermission } = require("../lib/permissions");

const router = express.Router();
router.use(requireAuth);
router.use(requireActiveUser);

const CHANNELS = [
  { key: "google", label: "Google Business Profile" },
  { key: "website", label: "Website" },
  { key: "fb", label: "Facebook Page" },
  { key: "insta", label: "Instagram Page" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "youtube", label: "YouTube Channel" },
];

function hasValue(v) {
  return !!(v && String(v).trim());
}
function completeness(lead) {
  return CHANNELS.reduce((n, c) => n + (hasValue(lead[c.key]) ? 1 : 0), 0);
}
function missingChannels(lead) {
  return CHANNELS.filter((c) => !hasValue(lead[c.key])).map((c) => c.label);
}

function teamIdsFor(userRecord) {
  return [userRecord.id, ...(userRecord.teamMembers || []).map((u) => u.id)];
}

// GET /analytics/digital-presence — Super Admin always; anyone else
// (Account Admin included) needs canViewAnalytics on their assigned
// Position. Scope of the returned leads:
// - Super Admin: every lead in the company
// - Account Admin: leads assigned to themselves or their team
// - Member (permission-holder): their own leads only
// All aggregation — company-wide or scoped to one selected user — happens
// client-side from whichever of these lists comes back.
router.get("/digital-presence", async (req, res) => {
  const userRecord = req.userRecord;
  const isSuperAdmin = userRecord.role === "SUPER_ADMIN";
  if (!isSuperAdmin && !hasPermission(userRecord, "canViewAnalytics")) {
    return res.status(403).json({ success: false, message: "You don't have permission to view Analytics." });
  }

  let where = {};
  if (userRecord.role === "ACCOUNT_ADMIN") {
    where = { assignedToId: { in: teamIdsFor(userRecord) } };
  } else if (userRecord.role === "MEMBER") {
    where = { assignedToId: userRecord.id };
  }
  // Super Admin: no filter — where stays {}.

  const leads = await db.lead.findMany({
    where,
    select: {
      id: true, bizName: true, ownerName: true, city: true, category: true,
      section: true, response: true, amount: true, entryDate: true,
      status: true, followup: true, meetingStatus: true, source: true,
      renewalDate: true,
      website: true, google: true, fb: true, insta: true, youtube: true, linkedin: true,
      assignedTo: { select: { id: true, name: true, email: true, memberId: true, role: true } },
    },
    orderBy: { entryDate: "desc" },
  });

  const gapList = leads.map((l) => ({
    id: l.id, bizName: l.bizName, ownerName: l.ownerName, city: l.city,
    category: l.category, section: l.section, response: l.response,
    amount: l.amount, entryDate: l.entryDate, status: l.status, followup: l.followup,
    meetingStatus: l.meetingStatus, source: l.source,
    renewalDate: l.renewalDate,
    assignedTo: l.assignedTo,
    presence: {
      website: l.website || "", google: l.google || "", fb: l.fb || "",
      insta: l.insta || "", youtube: l.youtube || "", linkedin: l.linkedin || "",
    },
    channels: Object.fromEntries(CHANNELS.map((c) => [c.key, hasValue(l[c.key])])),
    completenessScore: completeness(l),
    missingChannels: missingChannels(l),
  }));

  res.json({ success: true, channels: CHANNELS, leads: gapList });
});

module.exports = router;
