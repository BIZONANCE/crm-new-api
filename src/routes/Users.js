const crypto = require("crypto");
const express = require("express");
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");
const requireActiveUser = require("../middleware/requireActiveUser");
const requireAdmin = require("../middleware/requireAdmin");
const requireSuperAdmin = require("../middleware/requireSuperAdmin");
const requirePermission = require("../middleware/requirePermission");
const { sendInviteEmail, sendVerifyEmailOtp } = require("../utils/mailer");
const { notify } = require("../lib/notify");

const router = express.Router();
router.use(requireAuth);
router.use(requireActiveUser);

// GET /users/transfer-targets — who a lead can be transferred to. Lives ABOVE
// the requireAdmin gate below on purpose: anyone holding the "Transfer leads"
// permission (including a plain Member) needs this list for the transfer
// popup, but must not get the full admin user list from GET /users.
//   Super Admin   -> every active user
//   Account Admin -> themselves + their team
//   Member holder -> every active user
// Only the fields the popup needs are returned — no phone/permission data.
router.get("/transfer-targets", requirePermission("canTransferLeads"), async (req, res) => {
  const where = { status: "ACTIVE" };
  if (req.userRecord.role === "ACCOUNT_ADMIN") {
    where.id = { in: [req.userRecord.id, ...(req.userRecord.teamMembers || []).map((u) => u.id)] };
  }
  const users = await db.user.findMany({
    where,
    select: { id: true, name: true, email: true, memberId: true, status: true },
    orderBy: { name: "asc" },
  });
  res.json({ success: true, users });
});

// Base gate: Super Admin and Account Admin both land in Manage Users.
// Specific routes below (invite, resend-invite, reject, manager/role
// assignment) add requireSuperAdmin directly since those stay Super-Admin-
// only regardless of this base gate.
router.use(requireAdmin);

const SELECT_FIELDS = {
  id: true,
  memberId: true,
  name: true,
  phone: true,
  email: true,
  role: true,
  status: true,
  createdAt: true,
  emailVerifiedAt: true,
  photoUrl: true,
  position: { select: { id: true, name: true, permissions: true } },
  managerId: true,
  manager: { select: { id: true, name: true, email: true, memberId: true } },
};

const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const VERIFY_EMAIL_TTL_MINUTES = 5;

const PHONE_RE = /^\d{10}$/;
const FIELD_LABEL = { memberId: "Member ID", phone: "Phone number" };

function newInviteToken() {
  return {
    inviteToken: crypto.randomBytes(32).toString("hex"),
    inviteTokenExpiresAt: new Date(Date.now() + INVITE_TOKEN_TTL_MS),
  };
}

function generateVerifyCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function assertUnique(field, value, excludeId) {
  const trimmed = value == null ? "" : String(value).trim();
  if (!trimmed) return null;
  const where = excludeId ? { [field]: trimmed, NOT: { id: excludeId } } : { [field]: trimmed };
  const clash = await db.user.findFirst({ where });
  if (clash) throw Object.assign(new Error("DUPLICATE_FIELD"), { code: "DUPLICATE_FIELD", field });
  return trimmed;
}

// Super Admin manages everyone. Account Admin manages only the Members
// whose managerId points at them. A Member reporting to no one (managerId
// null, or an Account Admin without teamMembers) is invisible to every
// Account Admin — only Super Admin sees the unmanaged pool, since only
// Super Admin can assign a manager in the first place.
function canManageUser(req, target) {
  if (req.userRecord.role === "SUPER_ADMIN") return true;
  if (req.userRecord.role === "ACCOUNT_ADMIN") return target.managerId === req.userRecord.id;
  return false;
}

router.get("/", async (req, res) => {
  const where = req.userRecord.role === "ACCOUNT_ADMIN" ? { managerId: req.userRecord.id } : {};
  const users = await db.user.findMany({ where, select: SELECT_FIELDS, orderBy: { createdAt: "desc" } });
  res.json({ success: true, users });
});

router.post("/verify-email/send", requireSuperAdmin, async (req, res) => {
  const { email } = req.body;
  if (!email || !String(email).trim()) {
    return res.status(400).json({ success: false, message: "Email is required" });
  }
  const trimmedEmail = email.trim();

  const existing = await db.user.findUnique({ where: { email: trimmedEmail } });
  if (existing) {
    return res.status(409).json({ success: false, message: "A user with this email already exists" });
  }

  const code = generateVerifyCode();
  const expiresAt = new Date(Date.now() + VERIFY_EMAIL_TTL_MINUTES * 60 * 1000);

  await db.emailVerification.deleteMany({ where: { email: trimmedEmail } });
  await db.emailVerification.create({ data: { email: trimmedEmail, code, expiresAt } });

  try {
    await sendVerifyEmailOtp(trimmedEmail, code);
  } catch (mailErr) {
    console.error("verify-email send failed:", mailErr);
    return res.status(500).json({ success: false, message: "Could not send the verification code" });
  }

  res.json({ success: true, message: "Verification code sent" });
});

router.post("/verify-email/confirm", requireSuperAdmin, async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) {
    return res.status(400).json({ success: false, message: "Email and code are required" });
  }
  const trimmedEmail = String(email).trim();

  const record = await db.emailVerification.findFirst({
    where: { email: trimmedEmail },
    orderBy: { createdAt: "desc" },
  });

  if (!record) {
    return res.status(400).json({
      success: false,
      message: "No verification code found for this email. Send a new one first.",
    });
  }
  if (record.expiresAt < new Date()) {
    return res.status(400).json({ success: false, message: "This code has expired. Send a new one." });
  }
  if (record.code !== String(otp).trim()) {
    return res.status(400).json({ success: false, message: "Incorrect code" });
  }

  await db.emailVerification.update({
    where: { id: record.id },
    data: { verified: true, verifiedAt: new Date() },
  });

  res.json({ success: true, message: "Email verified" });
});

// Invite always goes through Super Admin — Account Admin cannot invite, but
// Super Admin can optionally assign the new Member straight to an Account
// Admin at invite time via managerId.
router.post("/invite", requireSuperAdmin, async (req, res) => {
  const { email, positionId, name, phone, memberId, managerId } = req.body;
  if (!email || !String(email).trim()) {
    return res.status(400).json({ success: false, message: "Email is required" });
  }
  if (!name || !String(name).trim()) {
    return res.status(400).json({ success: false, message: "Name is required" });
  }
  const trimmedPhone = phone ? String(phone).trim() : "";
  if (!PHONE_RE.test(trimmedPhone)) {
    return res.status(400).json({ success: false, message: "Phone number must be exactly 10 digits" });
  }
  if (!memberId || !String(memberId).trim()) {
    return res.status(400).json({ success: false, message: "A Member ID is required" });
  }
  const trimmedEmail = email.trim();

  const existing = await db.user.findUnique({ where: { email: trimmedEmail } });
  if (existing) {
    return res.status(409).json({ success: false, message: "A user with this email already exists" });
  }

  const verification = await db.emailVerification.findFirst({
    where: { email: trimmedEmail },
    orderBy: { createdAt: "desc" },
  });
  if (!verification?.verified) {
    return res.status(400).json({ success: false, message: "Please verify this email before inviting" });
  }

  if (positionId) {
    const position = await db.position.findUnique({ where: { id: positionId } });
    if (!position) return res.status(400).json({ success: false, message: "Invalid position" });
  }

  let cleanManagerId = null;
  if (managerId) {
    const manager = await db.user.findUnique({ where: { id: managerId } });
    if (!manager || manager.role !== "ACCOUNT_ADMIN" || manager.status === "LEFT") {
      return res.status(400).json({ success: false, message: "Invalid Account Admin selected" });
    }
    cleanManagerId = manager.id;
  }

  let cleanMemberId, cleanPhone;
  try {
    cleanMemberId = await assertUnique("memberId", memberId);
    cleanPhone = await assertUnique("phone", trimmedPhone);
  } catch (err) {
    if (err.code === "DUPLICATE_FIELD") {
      return res.status(409).json({ success: false, message: `That ${FIELD_LABEL[err.field]} is already in use` });
    }
    throw err;
  }

  const { inviteToken, inviteTokenExpiresAt } = newInviteToken();

  const user = await db.user.create({
    data: {
      email: trimmedEmail,
      name: name.trim(),
      phone: cleanPhone,
      memberId: cleanMemberId,
      role: "MEMBER",
      status: "INVITED",
      positionId: positionId || null,
      managerId: cleanManagerId,
      inviteToken,
      inviteTokenExpiresAt,
      emailVerifiedAt: verification.verifiedAt,
    },
    select: SELECT_FIELDS,
  });

  await db.emailVerification.deleteMany({ where: { email: trimmedEmail } });

  try {
    const loginUrl = process.env.FRONTEND_URL || "http://localhost:5173";
    await sendInviteEmail(user.email, `${loginUrl}/verify-invite?token=${inviteToken}`);
  } catch (mailErr) {
    console.error("invite email failed:", mailErr);
  }

  res.status(201).json({ success: true, user });
});

router.post("/:id/resend-invite", requireSuperAdmin, async (req, res) => {
  const target = await db.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ success: false, message: "User not found" });
  if (target.status !== "INVITED") {
    return res.status(400).json({ success: false, message: "This user has already verified their invite" });
  }

  const { inviteToken, inviteTokenExpiresAt } = newInviteToken();
  await db.user.update({ where: { id: target.id }, data: { inviteToken, inviteTokenExpiresAt } });

  try {
    const loginUrl = process.env.FRONTEND_URL || "http://localhost:5173";
    await sendInviteEmail(target.email, `${loginUrl}/verify-invite?token=${inviteToken}`);
  } catch (mailErr) {
    console.error("resend invite email failed:", mailErr);
    return res.status(500).json({ success: false, message: "Could not send the invite email" });
  }

  res.json({ success: true, message: "Invite resent" });
});

router.patch("/:id", async (req, res) => {
  const { status, positionId, memberId, name, phone } = req.body;

  if (status && !["PENDING", "ACTIVE", "DISABLED"].includes(status)) {
    return res.status(400).json({ success: false, message: "Invalid status" });
  }
  if (req.params.id === req.userRecord.id && status && status !== "ACTIVE") {
    return res.status(400).json({ success: false, message: "You can't change your own status" });
  }
  if (positionId) {
    const position = await db.position.findUnique({ where: { id: positionId } });
    if (!position) return res.status(400).json({ success: false, message: "Invalid position" });
  }
  if (phone !== undefined && phone && !PHONE_RE.test(String(phone).trim())) {
    return res.status(400).json({ success: false, message: "Phone number must be exactly 10 digits" });
  }

  const target = await db.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ success: false, message: "User not found" });
  if (target.role === "SUPER_ADMIN") {
    return res.status(400).json({ success: false, message: "The Super Admin account can't be modified here" });
  }
  if (target.status === "LEFT") {
    return res.status(400).json({ success: false, message: "This user has left and can't be edited. Re-invite them instead." });
  }
  // Covers both "target is an Account Admin, requester is a different
  // Account Admin" (managerId is always null on an Account Admin, so this
  // never matches) and "target is a Member managed by someone else".
  if (!canManageUser(req, target)) {
    return res.status(403).json({ success: false, message: "You don't manage this user." });
  }

  const isApproving = status === "ACTIVE" && target.status === "PENDING";
  const effectiveMemberId = memberId !== undefined ? memberId?.trim() : target.memberId;
  const effectiveName = name !== undefined ? name?.trim() : target.name;
  const effectivePhone = phone !== undefined ? phone?.trim() : target.phone;
  if (isApproving && (!effectiveMemberId || !effectiveName || !effectivePhone)) {
    return res
      .status(400)
      .json({ success: false, message: "Name, phone, and Member ID are required to approve this user" });
  }

  // Captured before the update so we can tell whether positionId actually
  // changed — used below to fire the "permissions changed" notification.
  const positionChanged = positionId !== undefined && positionId !== target.positionId;

  const data = {};
  if (status) data.status = status;
  if (positionId !== undefined) data.positionId = positionId || null;
  if (name !== undefined) data.name = name.trim() || null;

  try {
    if (phone !== undefined) {
      data.phone = (await assertUnique("phone", phone, req.params.id)) || null;
    }
    if (memberId !== undefined) {
      data.memberId = (await assertUnique("memberId", memberId, req.params.id)) || null;
    }
  } catch (err) {
    if (err.code === "DUPLICATE_FIELD") {
      return res.status(409).json({ success: false, message: `That ${FIELD_LABEL[err.field]} is already in use` });
    }
    throw err;
  }

  const user = await db.user.update({ where: { id: req.params.id }, data, select: SELECT_FIELDS });

  // Member — Account & Session: "your role or permissions were changed by
  // an admin".
  if (positionChanged) {
    await notify(user.id, {
      type: "PERMISSIONS_CHANGED",
      title: "Your position was updated",
      message: "Your assigned position/permissions were changed by a Super Admin",
      link: "/profile",
    });
  }

  res.json({ success: true, user });
});

router.post("/:id/reassign-leads", async (req, res) => {
  const target = await db.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ success: false, message: "User not found" });
  if (target.role === "SUPER_ADMIN") {
    return res.status(400).json({ success: false, message: "The Super Admin account can't be modified here" });
  }
  if (target.status === "LEFT") {
    return res.status(400).json({ success: false, message: "This user has already left." });
  }
  if (!canManageUser(req, target)) {
    return res.status(403).json({ success: false, message: "You don't manage this user." });
  }

  const { reassignTo } = req.body;
  let toUserId = null;

  if (reassignTo && reassignTo !== "POOL") {
    const reassignUser = await db.user.findUnique({ where: { id: reassignTo } });
    if (!reassignUser) return res.status(400).json({ success: false, message: "Invalid reassignment target" });
    if (req.userRecord.role === "ACCOUNT_ADMIN") {
      const teamIds = [req.userRecord.id, ...req.userRecord.teamMembers.map((u) => u.id)];
      if (!teamIds.includes(reassignUser.id)) {
        return res.status(400).json({ success: false, message: "You can only reassign leads to someone on your team" });
      }
    }
    toUserId = reassignUser.id;
  }

  const assignedLeads = await db.lead.findMany({ where: { assignedToId: target.id } });

  try {
    await db.$transaction(async (tx) => {
      for (const lead of assignedLeads) {
        await tx.lead.update({ where: { id: lead.id }, data: { assignedToId: toUserId } });
        await tx.leadTransfer.create({
          data: {
            leadId: lead.id,
            fromUserId: target.id,
            toUserId,
            byUserId: req.userRecord.id,
          },
        });
      }
    });
  } catch (err) {
    console.error("reassign-leads error:", err);
    return res.status(500).json({ success: false, message: "Could not transfer this user's leads" });
  }

  res.json({ success: true, reassignedLeads: assignedLeads.length });
});

// Removing a user is Super-Admin-only now — Account Admin can edit, approve,
// disable, and manage their team's positions, but not remove an account.
router.delete("/:id", requireSuperAdmin, async (req, res) => {
  const target = await db.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ success: false, message: "User not found" });
  if (target.role === "SUPER_ADMIN") {
    return res.status(400).json({ success: false, message: "The Super Admin account can't be removed" });
  }
  if (target.id === req.userRecord.id) {
    return res.status(400).json({ success: false, message: "You can't remove your own account" });
  }
  if (target.status === "LEFT") {
    return res.status(400).json({ success: false, message: "This user has already left" });
  }

  const stillAssigned = await db.lead.count({ where: { assignedToId: target.id } });
  if (stillAssigned > 0) {
    return res.status(400).json({
      success: false,
      message: "Transfer this user's leads before removing their account",
    });
  }

  const user = await db.user.update({
    where: { id: target.id },
    data: { status: "LEFT" },
    select: SELECT_FIELDS,
  });

  res.json({ success: true, message: "User removed", user });
});

// Rejecting a still-PENDING/INVITED signup stays Super-Admin-only — these
// accounts haven't been assigned to any Account Admin yet, so there's no
// "your team" scope to check against.
router.delete("/:id/reject", requireSuperAdmin, async (req, res) => {
  const target = await db.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ success: false, message: "User not found" });
  if (target.role === "SUPER_ADMIN") {
    return res.status(400).json({ success: false, message: "The Super Admin account can't be removed" });
  }
  if (!["PENDING", "INVITED"].includes(target.status)) {
    return res.status(400).json({ success: false, message: "Only pending or invited users can be rejected" });
  }

  await db.user.delete({ where: { id: target.id } });
  res.json({ success: true, message: "User rejected" });
});

// PATCH /:id/manager — Super Admin only. Assigns or reassigns which Account
// Admin a Member reports to. managerId: null returns them to the unmanaged
// pool (visible only to Super Admin, same as before any assignment).
router.patch("/:id/manager", requireSuperAdmin, async (req, res) => {
  const target = await db.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ success: false, message: "User not found" });
  if (target.role !== "MEMBER") {
    return res.status(400).json({ success: false, message: "Only Members can be assigned to an Account Admin" });
  }

  const { managerId } = req.body;
  let cleanManagerId = null;
  if (managerId) {
    const manager = await db.user.findUnique({ where: { id: managerId } });
    if (!manager || manager.role !== "ACCOUNT_ADMIN" || manager.status === "LEFT") {
      return res.status(400).json({ success: false, message: "Invalid Account Admin selected" });
    }
    cleanManagerId = manager.id;
  }

  const user = await db.user.update({
    where: { id: target.id },
    data: { managerId: cleanManagerId },
    select: SELECT_FIELDS,
  });

  if (cleanManagerId) {
    await notify(user.id, {
      type: "MANAGER_ASSIGNED",
      title: "Account Admin assigned",
      message: "You've been assigned to a new Account Admin",
      link: "/profile",
    });
  }

  res.json({ success: true, user });
});

// PATCH /:id/role — Super Admin only. Toggles a user between MEMBER and
// ACCOUNT_ADMIN. Never touches SUPER_ADMIN — there's exactly one, and it's
// never granted or revoked through this endpoint.
router.patch("/:id/role", requireSuperAdmin, async (req, res) => {
  const { role } = req.body;
  if (!["MEMBER", "ACCOUNT_ADMIN"].includes(role)) {
    return res.status(400).json({ success: false, message: "Invalid role" });
  }

  const target = await db.user.findUnique({ where: { id: req.params.id }, include: { teamMembers: true } });
  if (!target) return res.status(404).json({ success: false, message: "User not found" });
  if (target.role === "SUPER_ADMIN") {
    return res.status(400).json({ success: false, message: "The Super Admin account can't be modified here" });
  }
  if (target.id === req.userRecord.id) {
    return res.status(400).json({ success: false, message: "You can't change your own role" });
  }
  if (target.role === role) {
    const unchanged = await db.user.findUnique({ where: { id: target.id }, select: SELECT_FIELDS });
    return res.json({ success: true, user: unchanged });
  }
  if (target.role === "ACCOUNT_ADMIN" && role === "MEMBER" && target.teamMembers.length > 0) {
    return res.status(400).json({
      success: false,
      message: `Reassign this Account Admin's ${target.teamMembers.length} team member(s) before demoting them`,
    });
  }

  const data = { role };
  // Promoting to Account Admin: they no longer report to anyone themselves.
  if (role === "ACCOUNT_ADMIN") data.managerId = null;

  const user = await db.user.update({ where: { id: target.id }, data, select: SELECT_FIELDS });

  await notify(user.id, {
    type: "ROLE_CHANGED",
    title: role === "ACCOUNT_ADMIN" ? "You're now an Account Admin" : "Your role was updated",
    message:
      role === "ACCOUNT_ADMIN"
        ? "You can now manage the users assigned to you"
        : "Your account was changed back to a standard Member",
    link: "/profile",
  });

  res.json({ success: true, user });
});

module.exports = router;
