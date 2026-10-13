const express = require("express");
const db = require("../db");
const { sectionForNewLead } = require("../lib/leadSection");
const { notify } = require("../lib/notify");

const router = express.Router();

const PHONE_RE = /^\d{10}$/;
const PIN_RE = /^\d{6}$/;

// Same option lists as the Add New Lead form. This route is public, so any
// dropdown value is checked against its list instead of being trusted.
const SOURCE_OPTIONS = ["Referral", "Walk-in", "Cold Call", "Website", "Google Ads", "Meta Ads", "Other"];
const RESPONSE_OPTIONS = ["Fresh Data", "New Customer", "HFU", "WFU", "CFU", "NI"];
const MEETING_STATUS_OPTIONS = ["Talked", "Visited", "Meeting Fixed", "CNR", "CNC", "CLOSED"];
const DEAL_DURATION_OPTIONS = ["One Time", "Monthly", "Annually", "Customize"];

// Real page paths of the app (the page the new lead lands on).
const SECTION_LINKS = { FRESH: "/leads", DCR: "/dcr", DSR: "/dsr" };

function clean(value, max = 255) {
  return String(value ?? "").trim().slice(0, max);
}

function optional(value, max = 255) {
  return clean(value, max) || null;
}

// Tells the member who owns the LeadGen link that a lead came in through it.
// Only that member is notified — every member has their own link (their ID is
// in the URL), so the notification is specific to them. A notification
// problem must never fail the submission, so this swallows its own errors.
async function notifyLinkOwner(ownerId, lead, section) {
  try {
    await notify(ownerId, {
      type: "LEADGEN_LEAD",
      title: "New lead from your LeadGen link",
      message: `${lead.bizName} (${lead.contact}) submitted your LeadGen form`,
      link: SECTION_LINKS[section] || "/leads",
    });
  } catch (err) {
    console.error("leadgen notification failed:", err);
  }
}

// GET /public/leads/catalog/services — the services list for the LeadGen
// form, including prices so the form can show each service's amount and the
// total. Two path segments, so it never clashes with /:memberId below.
router.get("/catalog/services", async (req, res) => {
  try {
    const items = await db.catalogItem.findMany({
      where: { status: "ACTIVE" },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: { id: true, title: true, price: true, discountedPrice: true },
    });
    const services = items.map((i) => ({
      id: i.id,
      name: i.title,
      price: i.price,
      discountedPrice: i.discountedPrice,
      // The amount a lead is charged: discounted price when there is one.
      amount: i.discountedPrice ?? i.price,
    }));
    res.json({ success: true, services });
  } catch (err) {
    console.error("public services list error:", err);
    res.status(500).json({ success: false, message: "Could not load services" });
  }
});

// GET /public/leads/:memberId — link check uses memberId so the URL shows a
// readable ID (e.g. BIZ-001) instead of an internal UUID.
router.get("/:memberId", async (req, res) => {
  const user = await db.user.findUnique({
    where: { memberId: req.params.memberId },
    select: { id: true, name: true, status: true, memberId: true },
  });
  if (!user || user.status === "DISABLED") {
    return res.status(404).json({ success: false, message: "This link is no longer active" });
  }
  res.json({ success: true, ownerName: user.name });
});

// POST /public/leads/:memberId — creates a lead owned by and assigned to
// the member the link belongs to. Business Name, Contact No and Lead Source
// are required; everything else is optional.
//
// The section follows the response, same as the Add New Lead form: only
// "Fresh Data" (or no response) stays in FRESH; any other response goes to
// DCR; a "Deal Closed" call status goes to DSR.
//
// Once saved, the member who owns the link is notified.
router.post("/:memberId", async (req, res) => {
  try {
    const user = await db.user.findUnique({ where: { memberId: req.params.memberId } });
    if (!user || user.status === "DISABLED") {
      return res.status(404).json({ success: false, message: "This link is no longer active" });
    }

    const b = req.body || {};

    const bizName = clean(b.bizName);
    const contact = clean(b.contact);
    const source = clean(b.source);

    const missing = Object.entries({ bizName, contact, source }).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) {
      return res.status(400).json({ success: false, message: "Missing required fields: " + missing.join(", ") });
    }
    if (!PHONE_RE.test(contact)) {
      return res.status(400).json({ success: false, message: "Contact number must be 10 digits" });
    }
    if (!SOURCE_OPTIONS.includes(source)) {
      return res.status(400).json({ success: false, message: "Invalid lead source" });
    }

    // Optional fields. If filled they still have to be well-formed.
    const ownerName = clean(b.ownerName);
    const altContact = clean(b.altContact);
    const state = clean(b.state);
    const city = clean(b.city);
    const pin = clean(b.pin);
    const category = clean(b.category);

    if (altContact && !PHONE_RE.test(altContact)) {
      return res.status(400).json({ success: false, message: "Alternate number must be 10 digits" });
    }
    if (pin && !PIN_RE.test(pin)) {
      return res.status(400).json({ success: false, message: "Pin code must be 6 digits" });
    }

    const response = clean(b.response);
    const meetingStatus = clean(b.meetingStatus);
    const dealDuration = clean(b.dealDuration);

    if (response && !RESPONSE_OPTIONS.includes(response)) {
      return res.status(400).json({ success: false, message: "Invalid response" });
    }
    if (meetingStatus && !MEETING_STATUS_OPTIONS.includes(meetingStatus)) {
      return res.status(400).json({ success: false, message: "Invalid call status" });
    }
    if (dealDuration && !DEAL_DURATION_OPTIONS.includes(dealDuration)) {
      return res.status(400).json({ success: false, message: "Invalid service duration" });
    }

    // ----- Services -----
    // The form sends service names (catalog ones picked from the list, plus
    // any custom ones typed in). Catalog names are linked to the catalog
    // item; custom names are stored by name only.
    const seen = new Set();
    const names = [];
    for (const raw of Array.isArray(b.productInterested) ? b.productInterested : []) {
      const name = clean(raw, 120);
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      names.push(name);
      if (names.length >= 20) break;
    }

    let selections = [];
    let allFromCatalog = false;
    let catalogTotal = 0;

    if (names.length > 0) {
      const items = await db.catalogItem.findMany({
        where: {
          status: "ACTIVE",
          OR: names.map((n) => ({ title: { equals: n, mode: "insensitive" } })),
        },
      });
      const byTitle = new Map(items.map((i) => [i.title.toLowerCase(), i]));

      selections = names.map((n) => {
        const item = byTitle.get(n.toLowerCase());
        return item ? { catalogItemId: item.id, name: item.title } : { catalogItemId: null, name: n };
      });

      allFromCatalog = selections.every((s) => s.catalogItemId);
      if (allFromCatalog) {
        catalogTotal = selections.reduce((sum, s) => {
          const item = byTitle.get(s.name.toLowerCase());
          return sum + (item.discountedPrice ?? item.price);
        }, 0);
      }
    }

    // Same rule as the Add New Lead form: when the services come from the
    // catalog, the amount is their total. Otherwise use the typed amount.
    let amount = null;
    if (allFromCatalog) {
      amount = catalogTotal;
    } else if (b.amount !== undefined && b.amount !== null && b.amount !== "") {
      const parsed = parseInt(b.amount, 10);
      amount = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    }

    // Which page the lead lands on, decided by the response / call status.
    const section = sectionForNewLead({ response, meetingStatus });

    const lead = await db.lead.create({
      data: {
        bizName,
        // These four columns can't be null in the database, so a blank value
        // is stored as an empty string — same as the Add New Lead form does.
        ownerName,
        city,
        pin,
        category,
        contact,
        altContact: altContact || null,
        state: state || null,
        address: optional(b.address, 500),
        source,
        website: optional(b.website, 500),
        google: optional(b.google, 500),
        fb: optional(b.fb, 500),
        insta: optional(b.insta, 500),
        youtube: optional(b.youtube, 500),
        linkedin: optional(b.linkedin, 500),
        amount,
        response: response || null,
        meetingStatus: meetingStatus || null,
        dealDuration: dealDuration || null,
        remark: optional(b.remark, 2000),
        section,
        closedDate: section === "DSR" ? new Date() : null,
        lastCall: section === "DCR" ? new Date() : null,
        status: response === "NI" ? "INACTIVE" : "ACTIVE",
        assignedToId: user.id,
        ownerId: user.id,
      },
    });

    if (selections.length > 0) {
      await db.leadServiceSelection.createMany({
        data: selections.map((s) => ({ leadId: lead.id, catalogItemId: s.catalogItemId, name: s.name })),
      });
    }

    // Tell the member who owns this link. Never blocks or fails the submit.
    await notifyLinkOwner(user.id, lead, section);

    res.status(201).json({ success: true, message: "Submitted successfully", leadId: lead.id });
  } catch (err) {
    console.error("public lead submit error:", err);
    res.status(500).json({ success: false, message: "Could not submit. Please try again." });
  }
});

module.exports = router;
