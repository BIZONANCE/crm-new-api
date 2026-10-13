const express = require("express");
const ExcelJS = require("exceljs");
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");
const requireActiveUser = require("../middleware/requireActiveUser");
const requirePermission = require("../middleware/requirePermission");

const router = express.Router();
router.use(requireAuth);
router.use(requireActiveUser);
// Databank is open to every active user — no permission gate. buildWhere
// below already scopes results by role (Account Admin: team, Member: own
// leads only), the same visibility model used by /leads and /activity.

// Only the fields the manager actually needs — no user/permission data,
// except assignedTo, which IS needed now for the Lead Manager column/filter.
// `starred` is needed too: the Databank table has its own star toggle and
// "Starred" filter, and without this field every lead comes back with
// starred === undefined, so the UI can never show — or count — a star.
// `closedDate` and `services` are needed for LeadDetailModal, which is
// opened from this page (readOnly) and reads both directly off the lead —
// without them here the modal shows a blank Deal Date and no Services.
// `source` is needed by LeadDetailModal too: it shows the Lead Source and
// uses the fixed "Reopen" source to label a lead as "Reopened".
const SELECT_FIELDS = {
  id: true, section: true, entryDate: true, status: true,
  bizName: true, ownerName: true, contact: true, altContact: true,
  city: true, pin: true, address: true, category: true, source: true,
  website: true, google: true, fb: true, insta: true, youtube: true, linkedin: true,
  amount: true, response: true, meetingStatus: true, dealDuration: true, remark: true,
  starred: true, closedDate: true, renewalDate: true,
  services: { select: { id: true, catalogItemId: true, name: true } },
  assignedTo: { select: { id: true, name: true, email: true, memberId: true, status: true } },
};

// Section/Response/Lead-Manager filters are all multi-select on the
// frontend, sent as a comma-separated list (e.g. "FRESH,DCR" or two user
// ids for assignedTo). A single value still works the same way. "ALL" is
// ignored for backward compatibility with any old caller still sending it.
function parseList(v) {
  if (!v) return [];
  const raw = Array.isArray(v) ? v : String(v).split(",");
  return raw.map((s) => s.trim()).filter((s) => s && s !== "ALL");
}

// Everyone an Account Admin can see data for: themselves plus their team.
// Super Admin has no restriction here (returns null, checked by callers).
function teamIdsFor(userRecord) {
  return [userRecord.id, ...(userRecord.teamMembers || []).map((u) => u.id)];
}

function buildWhere(q, req) {
  // Databank has no "show deleted" toggle — it's a live view of the working
  // lead set, same as every other list in the app. Deleted leads live in
  // the Activity page's dedicated Deleted Leads tab (?deleted=true on
  // /leads), never here, so they're excluded unconditionally.
  const where = { deletedAt: null };
  const sections = parseList(q.section);
  if (sections.length) where.section = { in: sections };
  const responses = parseList(q.response);
  if (responses.length) where.response = { in: responses };
  const managers = parseList(q.assignedTo);
  if (managers.length) where.assignedToId = { in: managers };
  if (q.dateFrom || q.dateTo) {
    where.entryDate = {};
    if (q.dateFrom) where.entryDate.gte = new Date(q.dateFrom);
    if (q.dateTo) where.entryDate.lte = new Date(q.dateTo + "T23:59:59");
  }
  if (q.search) {
    where.OR = [
      { bizName: { contains: q.search, mode: "insensitive" } },
      { ownerName: { contains: q.search, mode: "insensitive" } },
      { contact: { contains: q.search } },
      { city: { contains: q.search, mode: "insensitive" } },
      { category: { contains: q.search, mode: "insensitive" } },
    ];
  }

  // Account Admin: restrict to their team, intersecting with any explicit
  // manager filter above rather than overwriting it (so a stray old caller
  // still passing ?assignedTo=... doesn't accidentally widen their scope).
  if (req.userRecord.role === "ACCOUNT_ADMIN") {
    const teamIds = teamIdsFor(req.userRecord);
    if (where.assignedToId?.in) {
      where.assignedToId = { in: where.assignedToId.in.filter((id) => teamIds.includes(id)) };
    } else {
      where.assignedToId = { in: teamIds };
    }
  } else if (req.userRecord.role === "MEMBER") {
    // A Member reaches this router freely now (no permission gate), so
    // every Member must be restricted to their own leads here — otherwise
    // they'd see every lead in the company with no assignedToId filter at
    // all.
    if (where.assignedToId?.in) {
      where.assignedToId = { in: where.assignedToId.in.filter((id) => id === req.userRecord.id) };
    } else {
      where.assignedToId = req.userRecord.id;
    }
  }

  return where;
}

// GET /databank/leads — filtered list for the table view
router.get("/leads", async (req, res) => {
  const leads = await db.lead.findMany({
    where: buildWhere(req.query, req),
    select: SELECT_FIELDS,
    orderBy: { entryDate: "desc" },
  });
  res.json({ success: true, leads });
});

// GET /databank/export — same filters, returns a real .xlsx file.
// Separately gated by canExportData on top of the now-open router above: a
// Position can grant someone the ability to view the Databank table
// without also letting them pull a full data export, mirroring the
// frontend's Export button, which is hidden unless the user has this same
// permission (see pages/Databank.jsx and pages/Leads.jsx).
router.get("/export", requirePermission("canExportData"), async (req, res) => {
  const leads = await db.lead.findMany({
    where: buildWhere(req.query, req),
    select: SELECT_FIELDS,
    orderBy: { entryDate: "desc" },
  });

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Leads");

  sheet.columns = [
    { header: "Section", key: "section", width: 10 },
    { header: "Entry Date", key: "entryDate", width: 14 },
    { header: "Business Name", key: "bizName", width: 24 },
    { header: "Contact Person", key: "ownerName", width: 20 },
    { header: "Contact", key: "contact", width: 14 },
    { header: "Alternate No", key: "altContact", width: 14 },
    { header: "City", key: "city", width: 14 },
    { header: "Pin", key: "pin", width: 10 },
    { header: "Address", key: "address", width: 26 },
    { header: "Category", key: "category", width: 16 },
    { header: "Website", key: "website", width: 24 },
    { header: "Google", key: "google", width: 24 },
    { header: "Facebook", key: "fb", width: 20 },
    { header: "Instagram", key: "insta", width: 20 },
    { header: "YouTube", key: "youtube", width: 20 },
    { header: "LinkedIn", key: "linkedin", width: 20 },
    { header: "Amount", key: "amount", width: 12 },
    { header: "Response", key: "response", width: 14 },
    { header: "Meeting Status", key: "meetingStatus", width: 14 },
    { header: "Package", key: "dealDuration", width: 12 },
    { header: "Deal Date", key: "closedDateFmt", width: 14 },
    { header: "Lead Manager", key: "assignedToName", width: 20 },
    { header: "Remark", key: "remark", width: 26 },
  ];
  sheet.getRow(1).font = { bold: true };

  leads.forEach((l) => {
    sheet.addRow({
      ...l,
      entryDate: l.entryDate ? new Date(l.entryDate).toLocaleDateString("en-IN") : "",
      closedDateFmt: l.closedDate ? new Date(l.closedDate).toLocaleDateString("en-IN") : "",
      assignedToName: l.assignedTo?.name || l.assignedTo?.email || "—",
    });
  });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="leads-databank-${Date.now()}.xlsx"`);
  await workbook.xlsx.write(res);
  res.end();
});

module.exports = router;
