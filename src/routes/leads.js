const express = require("express");
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");
const requireActiveUser = require("../middleware/requireActiveUser");
const requirePermission = require("../middleware/requirePermission");
const { hasPermission } = require("../lib/permissions");
const { logCreate, logUpdate, logDelete, logRestore } = require("../lib/auditLog");
const { sectionForNewLead } = require("../lib/leadSection");
const {
  notify,
  notifyAllSuperAdmins,
  notifyRelevantAdmins,
  notifyRelevantAdminsForUsers,
} = require("../lib/notify");

const router = express.Router();
router.use(requireAuth);
router.use(requireActiveUser);

const INACTIVE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
// Same 30-day window as DCR's no-follow-up check. A FRESH lead is
// considered stale — and auto-flipped to INACTIVE — once 30 days have
// passed with no activity: no edits at all since it was entered, or (if it
// HAS been edited) no edits in the last 30 days. We use editedDate as the
// "last touched" timestamp and fall back to entryDate when it's never been
// edited, so genuinely worked leads don't go inactive just because they're
// old.
const FRESH_INACTIVE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

const SECTION_LINKS = { FRESH: "/leads/fresh", DCR: "/leads/dcr", DSR: "/leads/dsr" };

// Lead Source given to every lead created by "Reopen". It is system-managed:
// it can't be typed in, picked from the dropdown, or changed afterwards. The
// lead detail modal uses it to show "Reopened" instead of "Submitted".
const REOPEN_SOURCE = "Reopen";
const isReopenText = (v) => String(v || "").trim().toLowerCase() === REOPEN_SOURCE.toLowerCase();

const LEAD_INCLUDE = {
  assignedTo: { select: { id: true, name: true, email: true, memberId: true, status: true } },
  services: { select: { id: true, catalogItemId: true, name: true } },
};

const DELETED_INCLUDE = {
  ...LEAD_INCLUDE,
  deletedBy: { select: { id: true, name: true, email: true } },
};

// Team ids an Account Admin can act on: themselves plus everyone reporting
// to them. Requires req.userRecord.teamMembers to have been loaded by
// requireActiveUser.js — if this comes back empty for an Account Admin who
// definitely has a team, that middleware's include is the place to check.
function teamIdsFor(userRecord) {
  return [userRecord.id, ...(userRecord.teamMembers || []).map((u) => u.id)];
}

function assertOwnsLead(req, lead) {
  if (req.userRecord.role === "SUPER_ADMIN") return true;
  if (req.userRecord.role === "ACCOUNT_ADMIN") {
    return teamIdsFor(req.userRecord).includes(lead.assignedToId);
  }
  return lead.assignedToId === req.userRecord.id;
}

// Server-side guard for the 10-digit phone rule used by the add/edit forms.
// Returns an error message, or null when the numbers are fine. Contact is
// only checked when it is present in the payload (so partial updates still
// work); the alternate number is optional but must be 10 digits if filled.
function phoneError(data, { requireContact = false } = {}) {
  const hasContact = data.contact !== undefined && data.contact !== null;
  if (requireContact && !hasContact) return "Contact No is required";
  if (hasContact && !/^\d{10}$/.test(String(data.contact))) {
    return "Contact No must be exactly 10 digits";
  }
  if (data.altContact && !/^\d{10}$/.test(String(data.altContact))) {
    return "Alternate No must be exactly 10 digits";
  }
  return null;
}

async function syncLeadServices(leadId, serviceIds) {
  await db.leadServiceSelection.deleteMany({ where: { leadId } });
  if (!Array.isArray(serviceIds) || serviceIds.length === 0) return;
  const items = await db.catalogItem.findMany({ where: { id: { in: serviceIds } } });
  if (items.length === 0) return;
  await db.leadServiceSelection.createMany({
    data: items.map((i) => ({ leadId, catalogItemId: i.id, name: i.title })),
  });
}

// GET /leads — open to every active user. Scoped automatically by role:
// Member sees only their own leads, Account Admin sees their team's, Super
// Admin sees everything. No permission gate needed — this mirrors the same
// visibility model used by Databank and Activity.
router.get("/", async (req, res) => {
  const { section } = req.query;
  const viewingDeleted = req.query.deleted === "true";

  if (viewingDeleted && !hasPermission(req.userRecord, "canDeleteLeads")) {
    return res.status(403).json({ success: false, message: "You don't have permission to view deleted leads." });
  }

  const dcrGoingInactive = await db.lead.findMany({
    where: {
      section: "DCR",
      status: "ACTIVE",
      deletedAt: null,
      followup: { lt: new Date(Date.now() - INACTIVE_AFTER_MS) },
    },
    select: { id: true, bizName: true, assignedToId: true },
  });
  if (dcrGoingInactive.length > 0) {
    await db.lead.updateMany({
      where: { id: { in: dcrGoingInactive.map((l) => l.id) } },
      data: { status: "INACTIVE" },
    });
    for (const l of dcrGoingInactive) {
      await notify(l.assignedToId, {
        type: "LEAD_INACTIVE",
        title: "Lead marked inactive",
        message: `${l.bizName} had no follow-up for 30 days and is now inactive`,
        link: "/leads/dcr",
      });
    }
    await notifyRelevantAdminsForUsers(
      dcrGoingInactive.map((l) => l.assignedToId),
      {
        type: "LEAD_INACTIVE_BATCH",
        title: "Leads auto-marked inactive (DCR)",
        message: `${dcrGoingInactive.length} DCR lead${dcrGoingInactive.length !== 1 ? "s" : ""} went inactive due to no follow-up`,
        link: "/leads/dcr",
      },
      (teamUserIds) => ({
        type: "LEAD_INACTIVE_BATCH",
        title: "Leads auto-marked inactive (DCR)",
        message: `${dcrGoingInactive.filter((l) => teamUserIds.includes(l.assignedToId)).length} of your team's DCR lead(s) went inactive due to no follow-up`,
        link: "/leads/dcr",
      })
    );
  }

  // FRESH leads: inactive once 30 days have passed since the lead was last
  // touched. "Last touched" is editedDate if the lead has ever been edited,
  // otherwise entryDate. Expressed as an OR so we don't have to fetch every
  // FRESH lead into memory just to compute the fallback in JS.
  const freshInactiveCutoff = new Date(Date.now() - FRESH_INACTIVE_AFTER_MS);
  const freshGoingInactive = await db.lead.findMany({
    where: {
      section: "FRESH",
      status: "ACTIVE",
      deletedAt: null,
      OR: [
        {
          wasEdited: false,
          entryDate: { lt: freshInactiveCutoff },
        },
        {
          wasEdited: true,
          editedDate: { lt: freshInactiveCutoff },
        },
      ],
    },
    select: { id: true, bizName: true, assignedToId: true },
  });
  if (freshGoingInactive.length > 0) {
    await db.lead.updateMany({
      where: { id: { in: freshGoingInactive.map((l) => l.id) } },
      data: { status: "INACTIVE" },
    });
    for (const l of freshGoingInactive) {
      await notify(l.assignedToId, {
        type: "LEAD_INACTIVE",
        title: "Lead marked inactive",
        message: `${l.bizName} had no updates for 30 days and is now inactive`,
        link: "/leads/fresh",
      });
    }
    await notifyRelevantAdminsForUsers(
      freshGoingInactive.map((l) => l.assignedToId),
      {
        type: "LEAD_INACTIVE_BATCH",
        title: "Leads auto-marked inactive (FRESH)",
        message: `${freshGoingInactive.length} FRESH lead${freshGoingInactive.length !== 1 ? "s" : ""} went inactive`,
        link: "/leads/fresh",
      },
      (teamUserIds) => ({
        type: "LEAD_INACTIVE_BATCH",
        title: "Leads auto-marked inactive (FRESH)",
        message: `${freshGoingInactive.filter((l) => teamUserIds.includes(l.assignedToId)).length} of your team's FRESH lead(s) went inactive`,
        link: "/leads/fresh",
      })
    );
  }

  const where = {};
  if (section) where.section = section.toUpperCase();
  if (req.userRecord.role === "MEMBER") {
    where.assignedToId = req.userRecord.id;
  } else if (req.userRecord.role === "ACCOUNT_ADMIN") {
    where.assignedToId = { in: teamIdsFor(req.userRecord) };
  }
  // SUPER_ADMIN: no assignedToId filter — sees every lead.
  where.deletedAt = viewingDeleted ? { not: null } : null;

  const leads = await db.lead.findMany({
    where,
    orderBy: viewingDeleted ? { deletedAt: "desc" } : { entryDate: "desc" },
    include: viewingDeleted ? DELETED_INCLUDE : LEAD_INCLUDE,
  });
  res.json({ success: true, leads });
});

router.get("/check-contact", async (req, res) => {
  const { contact } = req.query;
  if (!contact) return res.json({ success: true, exists: false });

  const canSeeDetail = req.userRecord.role === "SUPER_ADMIN" || req.userRecord.role === "ACCOUNT_ADMIN";
  const existing = await db.lead.findFirst({
    where: { contact: String(contact), deletedAt: null },
    select: canSeeDetail ? { id: true, bizName: true, city: true, section: true } : { id: true },
  });
  res.json({ success: true, exists: !!existing, lead: canSeeDetail ? existing || null : null });
});

// POST /leads/transfer — gated by the "Transfer leads" permission (Super
// Admin always has it; everyone else needs it from their Position).
// Only assignedToId changes, so each lead keeps its section (FRESH / DCR /
// DSR) and shows up on the same page for the new owner.
//
// Scope by role:
//   Super Admin   -> any lead, to any active user
//   Account Admin -> leads in their team, to someone on their team
//   Member holder -> only their own leads, to any active user
router.post("/transfer", requirePermission("canTransferLeads"), async (req, res) => {
  const role = req.userRecord.role;

  const { toUserId } = req.body;
  const leadIds = Array.isArray(req.body.leadIds) ? [...new Set(req.body.leadIds)] : [];
  if (leadIds.length === 0) {
    return res.status(400).json({ success: false, message: "No leads selected" });
  }
  if (!toUserId) {
    return res.status(400).json({ success: false, message: "Select a user to transfer these leads to" });
  }

  // null = no restriction
  const leadScopeIds =
    role === "SUPER_ADMIN" ? null : role === "ACCOUNT_ADMIN" ? teamIdsFor(req.userRecord) : [req.userRecord.id];
  const targetScopeIds = role === "ACCOUNT_ADMIN" ? teamIdsFor(req.userRecord) : null;

  const targetUser = await db.user.findUnique({ where: { id: toUserId } });
  if (!targetUser || targetUser.status !== "ACTIVE") {
    return res.status(400).json({ success: false, message: "Select an active user to transfer to" });
  }
  if (targetScopeIds && !targetScopeIds.includes(toUserId)) {
    return res.status(400).json({ success: false, message: "You can only transfer leads to someone on your team" });
  }

  const leadWhere = { id: { in: leadIds }, deletedAt: null };
  if (leadScopeIds) leadWhere.assignedToId = { in: leadScopeIds };
  const existingLeads = await db.lead.findMany({ where: leadWhere });
  if (existingLeads.length !== leadIds.length) {
    return res.status(404).json({ success: false, message: "One or more leads were not found" });
  }

  const results = [];
  for (const lead of existingLeads) {
    const updated = await db.lead.update({
      where: { id: lead.id },
      data: { assignedToId: toUserId },
      include: LEAD_INCLUDE,
    });
    await db.leadTransfer.create({
      data: {
        leadId: lead.id,
        fromUserId: lead.assignedToId || null,
        toUserId,
        byUserId: req.userRecord.id,
      },
    });
    results.push(updated);
  }

  // One notification per section, linking to the page the leads are on.
  const bySection = {};
  for (const l of results) (bySection[l.section] ||= []).push(l);

  for (const [section, list] of Object.entries(bySection)) {
    await notify(toUserId, {
      type: "LEAD_TRANSFERRED",
      title: "Lead(s) transferred to you",
      message: `${list.length} lead${list.length !== 1 ? "s" : ""} transferred to you (${section})`,
      link: SECTION_LINKS[section] || "/leads/fresh",
    });
  }

  res.json({ success: true, leads: results });
});

router.post("/bulk-delete", requirePermission("canDeleteLeads"), async (req, res) => {
  const { leadIds } = req.body;
  if (!Array.isArray(leadIds) || leadIds.length === 0) {
    return res.status(400).json({ success: false, message: "No leads selected" });
  }

  const existingLeads = await db.lead.findMany({ where: { id: { in: leadIds }, deletedAt: null } });
  const notFoundCount = leadIds.length - existingLeads.length;

  const deletable = existingLeads.filter((lead) => assertOwnsLead(req, lead));
  const skipped = notFoundCount + (existingLeads.length - deletable.length);

  let deleted = 0;
  for (const lead of deletable) {
    try {
      await db.lead.update({
        where: { id: lead.id },
        data: { deletedAt: new Date(), deletedById: req.user.id },
      });
      deleted++;
      try {
        await logDelete(lead, req.user.id);
      } catch (auditErr) {
        console.error("audit log (bulk delete) failed:", auditErr);
      }
    } catch (err) {
      console.error("bulk delete lead error:", err);
    }
  }

  if (deleted > 0 && req.userRecord.role !== "SUPER_ADMIN") {
    await notifyRelevantAdmins(req.userRecord.id, {
      type: "BULK_DELETE",
      title: "Bulk delete performed",
      message: `${req.userRecord.name || req.userRecord.email} deleted ${deleted} lead${deleted !== 1 ? "s" : ""}`,
      link: null,
    });
  }

  res.json({ success: true, deleted, skipped });
});

router.get("/:id/transfers", async (req, res) => {
  const lead = await db.lead.findFirst({ where: { id: req.params.id } });
  if (!lead) return res.status(404).json({ success: false, message: "Lead not found" });
  if (!assertOwnsLead(req, lead)) {
    return res.status(403).json({ success: false, message: "You don't have access to this lead" });
  }

  const transfers = await db.leadTransfer.findMany({
    where: { leadId: req.params.id },
    orderBy: { createdAt: "desc" },
    include: {
      fromUser: { select: { id: true, name: true, email: true, memberId: true, status: true } },
      toUser: { select: { id: true, name: true, email: true, memberId: true, status: true } },
      byUser: { select: { id: true, name: true, email: true, memberId: true, status: true } },
    },
  });
  res.json({ success: true, transfers });
});

// GET /leads/:id/sales-history — the full sales history of a business: every
// closed (DSR) entry that shares this lead's contact number, newest first,
// INCLUDING the entry that was opened (it is flagged with isCurrent).
router.get("/:id/sales-history", async (req, res) => {
  const lead = await db.lead.findFirst({ where: { id: req.params.id } });
  if (!lead) return res.status(404).json({ success: false, message: "Lead not found" });
  if (!assertOwnsLead(req, lead)) {
    return res.status(403).json({ success: false, message: "You don't have access to this lead" });
  }

  const where = { contact: lead.contact, section: "DSR", deletedAt: null };
  if (req.userRecord.role === "MEMBER") {
    where.assignedToId = req.userRecord.id;
  } else if (req.userRecord.role === "ACCOUNT_ADMIN") {
    where.assignedToId = { in: teamIdsFor(req.userRecord) };
  }

  const entries = await db.lead.findMany({
    where,
    orderBy: { closedDate: "desc" },
    include: LEAD_INCLUDE,
  });

  const history = entries.map((l) => ({ ...l, isCurrent: l.id === lead.id }));
  res.json({ success: true, history });
});

router.get("/stats", async (req, res) => {
  const role = req.userRecord.role;
  if (role !== "SUPER_ADMIN" && role !== "ACCOUNT_ADMIN") {
    return res.status(403).json({ success: false, message: "Admin access required" });
  }

  const groupWhere = { assignedToId: { not: null }, deletedAt: null };
  const usersWhere = { role: "MEMBER" };
  if (role === "ACCOUNT_ADMIN") {
    groupWhere.assignedToId = { in: teamIdsFor(req.userRecord) };
    usersWhere.managerId = req.userRecord.id;
  }

  const [grouped, users] = await Promise.all([
    db.lead.groupBy({
      by: ["assignedToId"],
      _count: { _all: true },
      where: groupWhere,
    }),
    db.user.findMany({
      where: usersWhere,
      select: { id: true, name: true, email: true, memberId: true, status: true },
    }),
  ]);

  const countByUser = new Map(grouped.map((g) => [g.assignedToId, g._count._all]));
  const stats = users
    .map((u) => ({ ...u, leadCount: countByUser.get(u.id) || 0 }))
    .sort((a, b) => b.leadCount - a.leadCount);

  res.json({ success: true, stats });
});

// POST /leads — open to every active user. Created leads are always owned
// by and assigned to the creator (see data.ownerId/assignedToId below), so
// there's nothing extra to gate — a Member creating a lead only ever
// creates one for themselves.
//
// The section is decided by the response: only "Fresh Data" (or no
// response) stays in FRESH. Any other response (New Customer, HFU, WFU,
// CFU, NI) goes to the Daily Call Record, and a "Deal Closed" call status
// goes to the Daily Sales Record.
router.post("/", async (req, res) => {
  try {
    // sourceType / referredByName come from the "How did this lead come in?"
    // field. They aren't lead columns, so they're pulled out here and folded
    // into `source` instead of being passed to the database.
    const { serviceIds, sourceType, referredByName, ...rest } = req.body;

    const phoneMsg = phoneError(rest, { requireContact: true });
    if (phoneMsg) return res.status(400).json({ success: false, message: phoneMsg });

    if (sourceType === "REFERRED") {
      const referrer = String(referredByName || "").trim();
      if (!referrer) {
        return res.status(400).json({ success: false, message: "Please enter the referrer's name" });
      }
      rest.source = `Referred by: ${referrer}`;
    } else if (sourceType === "COLD_CALL" && !String(rest.source || "").trim()) {
      rest.source = "Cold Call";
    }
    // "Reopen" is reserved for leads created through the Reopen action.
    if (isReopenText(rest.source)) rest.source = null;

    const data = { ...rest, ownerId: req.user.id, assignedToId: req.user.id };
    delete data.id;
    // System-managed fields should never come from the client on create.
    delete data.section;
    delete data.closedDate;
    delete data.status;

    data.section = sectionForNewLead(data);
    if (data.section === "DSR") data.closedDate = new Date();
    // A lead that goes straight into the Daily Call Record counts as called today.
    if (data.section === "DCR" && !data.lastCall) data.lastCall = new Date();
    if (data.response === "NI") data.status = "INACTIVE";

    const lead = await db.lead.create({ data });

    await syncLeadServices(lead.id, serviceIds);

    const withServices = await db.lead.findUnique({ where: { id: lead.id }, include: LEAD_INCLUDE });

    try {
      await logCreate(lead, req.user.id);
    } catch (auditErr) {
      console.error("audit log (create) failed:", auditErr);
    }

    res.status(201).json({ success: true, lead: withServices });
  } catch (err) {
    console.error("create lead error:", err);
    res.status(400).json({ success: false, message: "Could not create lead" });
  }
});

router.post("/:id/reopen", async (req, res) => {
  try {
    const existing = await db.lead.findFirst({ where: { id: req.params.id, deletedAt: null }, include: LEAD_INCLUDE });
    if (!existing) return res.status(404).json({ success: false, message: "Lead not found" });
    if (!assertOwnsLead(req, existing)) {
      return res.status(403).json({ success: false, message: "You don't have access to this lead" });
    }
    if (existing.section !== "DSR") {
      return res.status(400).json({ success: false, message: "Only closed (Daily Sales Record) leads can be reopened" });
    }

    const lead = await db.lead.create({
      data: {
        bizName: existing.bizName,
        ownerName: existing.ownerName,
        contact: existing.contact,
        altContact: existing.altContact,
        state: existing.state,
        city: existing.city,
        pin: existing.pin,
        address: existing.address,
        category: existing.category,
        source: REOPEN_SOURCE,
        website: existing.website,
        google: existing.google,
        fb: existing.fb,
        insta: existing.insta,
        youtube: existing.youtube,
        linkedin: existing.linkedin,
        section: "DCR",
        status: "ACTIVE",
        ownerId: req.user.id,
        assignedToId: existing.assignedToId || req.user.id,
      },
    });

    const withServices = await db.lead.findUnique({ where: { id: lead.id }, include: LEAD_INCLUDE });

    try {
      await logCreate(lead, req.user.id);
    } catch (auditErr) {
      console.error("audit log (reopen) failed:", auditErr);
    }

    res.status(201).json({ success: true, lead: withServices });
  } catch (err) {
    console.error("reopen lead error:", err);
    res.status(400).json({ success: false, message: "Could not reopen lead" });
  }
});

// PUT /leads/:id — open to every active user; assertOwnsLead below is the
// real gate (Member can only edit their own leads, Account Admin their
// team's, Super Admin anyone's).
router.put("/:id", async (req, res) => {
  try {
    const existing = await db.lead.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!existing) return res.status(404).json({ success: false, message: "Lead not found" });
    if (!assertOwnsLead(req, existing)) {
      return res.status(403).json({ success: false, message: "You don't have access to this lead" });
    }

    const { serviceIds, ...rest } = req.body;

    const phoneMsg = phoneError(rest);
    if (phoneMsg) return res.status(400).json({ success: false, message: phoneMsg });

    const data = { ...rest };
    delete data.id;

    data.wasEdited = true;

    delete data.closedDate;
    delete data.assignedTo;
    delete data.owner;
    delete data.activities;
    delete data.transfers;
    delete data.services;
    // The flat "servicesText" helper is added by the Leads page for
    // filtering only. It is not a database column.
    delete data.servicesText;
    // entryDate is intentionally kept editable (see below) — everything
    // else that's system-managed stays stripped.
    delete data.editedDate;
    delete data.assignedToId;
    delete data.ownerId;

    // Lead Source of a reopened lead is fixed, and nobody can set "Reopen"
    // on a lead that wasn't reopened.
    if (existing.source === REOPEN_SOURCE) {
      data.source = REOPEN_SOURCE;
    } else if (isReopenText(data.source)) {
      data.source = existing.source;
    }

    const forceSection = data.forceSection;
    delete data.forceSection;

    for (const field of ["renewalDate", "lastCall", "followup"]) {
      if (data[field] === "") {
        data[field] = null;
      } else if (data[field]) {
        data[field] = new Date(data[field]).toISOString();
      }
    }

    // Entry date is user-editable. Only touch it when a real value was
    // sent — an empty string means "leave it alone" rather than "clear it",
    // since entryDate isn't a nullable field.
    if (data.entryDate) {
      data.entryDate = new Date(data.entryDate).toISOString();
    } else {
      delete data.entryDate;
    }

    if (data.takenCall === "" || data.takenCall === null || data.takenCall === undefined) {
      data.takenCall = null;
    } else {
      data.takenCall = parseInt(data.takenCall, 10);
    }

    const isClosed = data.meetingStatus === "CLOSED";
    const isFreshReset = !isClosed && data.response === "Fresh Data";
    // Any real response other than "Fresh Data" (HFU, WFU, CFU, NI, New
    // Customer…) or any call status puts the lead in the Daily Call Record.
    const isDCR = !isClosed && !isFreshReset && (!!data.response || !!data.meetingStatus);

    if (data.followup) data.status = "ACTIVE";
    if (isFreshReset) data.status = "ACTIVE";
    if (data.response === "NI") data.status = "INACTIVE";

    if (forceSection === "DSR") {
      data.section = "DSR";
      data.closedDate = existing.closedDate || new Date();
    } else if (isClosed) {
      data.section = "DSR";
      data.closedDate = existing.closedDate || new Date();
    } else if (isFreshReset) {
      data.section = "FRESH";
    } else if (isDCR || forceSection === "DCR") {
      data.section = "DCR";
    }

    const lead = await db.lead.update({ where: { id: req.params.id }, data });

    if (req.userRecord.role !== "SUPER_ADMIN") {
      if (data.section === "DSR" && existing.section !== "DSR") {
        await notifyRelevantAdmins(lead.assignedToId, {
          type: "DEAL_CLOSED",
          title: "Deal closed",
          message: `${lead.bizName} was closed by ${req.userRecord.name || req.userRecord.email}`,
          link: "/leads/dsr",
        });
      }
      if (data.response === "NI" && existing.response !== "NI") {
        await notifyRelevantAdmins(lead.assignedToId, {
          type: "LEAD_NOT_INTERESTED",
          title: "Lead marked Not Interested",
          message: `${lead.bizName} was marked NI by ${req.userRecord.name || req.userRecord.email}`,
          link: "/leads/dcr",
        });
      }
    }

    if (serviceIds !== undefined) {
      await syncLeadServices(lead.id, serviceIds);
    }

    const withServices = await db.lead.findUnique({ where: { id: lead.id }, include: LEAD_INCLUDE });

    try {
      await logUpdate(existing, lead, req.user.id);
    } catch (auditErr) {
      console.error("audit log (update) failed:", auditErr);
    }

    res.json({ success: true, lead: withServices });
  } catch (err) {
    console.error("update lead error:", err);
    res.status(400).json({ success: false, message: err.message || "Could not update lead" });
  }
});

router.patch("/:id/star", async (req, res) => {
  const existing = await db.lead.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!existing) return res.status(404).json({ success: false, message: "Lead not found" });
  if (!assertOwnsLead(req, existing)) {
    return res.status(403).json({ success: false, message: "You don't have access to this lead" });
  }

  const starred = !!req.body.starred;
  const lead = await db.lead.update({ where: { id: req.params.id }, data: { starred } });
  res.json({ success: true, id: lead.id, starred: lead.starred });
});

router.patch("/:id/read", async (req, res) => {
  const existing = await db.lead.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!existing) return res.status(404).json({ success: false, message: "Lead not found" });
  if (!assertOwnsLead(req, existing)) {
    return res.status(403).json({ success: false, message: "You don't have access to this lead" });
  }

  const read = !!req.body.read;
  const lead = await db.lead.update({ where: { id: req.params.id }, data: { read } });
  res.json({ success: true, id: lead.id, read: lead.read });
});

router.delete("/:id", requirePermission("canDeleteLeads"), async (req, res) => {
  const existing = await db.lead.findFirst({ where: { id: req.params.id, deletedAt: null } });
  if (!existing) return res.status(404).json({ success: false, message: "Lead not found" });
  if (!assertOwnsLead(req, existing)) {
    return res.status(403).json({ success: false, message: "You don't have access to this lead" });
  }

  await db.lead.update({
    where: { id: req.params.id },
    data: { deletedAt: new Date(), deletedById: req.user.id },
  });

  try {
    await logDelete(existing, req.user.id);
  } catch (auditErr) {
    console.error("audit log (delete) failed:", auditErr);
  }

  res.json({ success: true });
});

router.post("/:id/restore", requirePermission("canDeleteLeads"), async (req, res) => {
  const existing = await db.lead.findFirst({ where: { id: req.params.id, deletedAt: { not: null } } });
  if (!existing) return res.status(404).json({ success: false, message: "Deleted lead not found" });
  if (!assertOwnsLead(req, existing)) {
    return res.status(403).json({ success: false, message: "You don't have access to this lead" });
  }

  const lead = await db.lead.update({
    where: { id: existing.id },
    data: { deletedAt: null, deletedById: null },
    include: LEAD_INCLUDE,
  });

  try {
    await logRestore(lead, req.user.id);
  } catch (auditErr) {
    console.error("audit log (restore) failed:", auditErr);
  }

  res.json({ success: true, lead });
});

router.post("/import", async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ success: false, message: "No rows to import" });
  }

  const required = ["bizName", "ownerName", "contact", "city", "pin", "category"];
  const errors = [];
  let created = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const missing = required.filter((f) => !String(row[f] || "").trim());
    if (missing.length) {
      errors.push({ row: i + 1, reason: `Missing: ${missing.join(", ")}` });
      continue;
    }
    try {
      // CSV import has no response column, so imported leads are always
      // Fresh Data (section defaults to FRESH).
      const lead = await db.lead.create({
        data: {
          bizName: row.bizName,
          ownerName: row.ownerName,
          contact: String(row.contact),
          altContact: row.altContact || null,
          state: row.state || null,
          city: row.city,
          pin: String(row.pin),
          address: row.address || null,
          category: row.category,
          source: isReopenText(row.source) ? null : row.source || null,
          website: row.website || null,
          google: row.google || null,
          fb: row.fb || null,
          insta: row.insta || null,
          youtube: row.youtube || null,
          linkedin: row.linkedin || null,
          product: row.product || null,
          amount: row.amount ? parseInt(row.amount, 10) || null : null,
          remark: row.remark || null,
          ownerId: req.user.id,
          assignedToId: req.user.id,
        },
      });
      created++;

      try {
        await logCreate(lead, req.user.id);
      } catch (auditErr) {
        console.error("audit log (import create) failed:", auditErr);
      }
    } catch (err) {
      errors.push({ row: i + 1, reason: err.message });
    }
  }

  if (created > 0) {
    const contacts = rows.map((r) => String(r.contact || "").trim()).filter(Boolean);
    if (contacts.length > 0) {
      const dupeGroups = await db.lead.groupBy({
        by: ["contact"],
        where: { section: "FRESH", contact: { in: contacts }, deletedAt: null },
        _count: { _all: true },
      });
      const newDupes = dupeGroups.filter((g) => g._count._all > 1);
      if (newDupes.length > 0) {
        await notifyRelevantAdmins(req.user.id, {
          type: "DUPLICATE_DETECTED",
          title: "Duplicate leads detected",
          message: `${newDupes.length} contact${newDupes.length !== 1 ? "s" : ""} now have duplicate FRESH leads after import`,
          link: "/leads/fresh",
        });
      }
    }
  }

  res.json({ success: true, created, skipped: errors.length, errors });
});

module.exports = router;
