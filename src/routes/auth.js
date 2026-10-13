const express = require("express");
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");

const router = express.Router();

// POST /auth/verify-invite — consumes the token from the link in the invite
// email. This only proves the person clicked the link in their own inbox; it
// deliberately does NOT activate the account by itself. The account only
// flips from INVITED to ACTIVE once they also complete a real OTP login (see
// otp.js verify-otp) — so both "clicked the email" and "owns the inbox right
// now" have to be true before they can actually get in.
router.post("/verify-invite", async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ success: false, message: "Missing verification token" });
  }

  const user = await db.user.findUnique({ where: { inviteToken: token } });
  if (!user || user.status !== "INVITED") {
    return res.status(400).json({ success: false, message: "This verification link is invalid or has already been used" });
  }
  if (user.inviteTokenExpiresAt && user.inviteTokenExpiresAt < new Date()) {
    return res.status(400).json({ success: false, message: "This invite link has expired. Ask your Super Admin to resend it." });
  }

  // Clear the token so the link is single-use, but keep status as INVITED —
  // otp.js checks for a cleared token to know this step is already done.
  await db.user.update({ where: { id: user.id }, data: { inviteToken: null } });

  res.json({ success: true, email: user.email });
});

// GET /auth/me — used by the frontend on load to check if the stored token is
// still valid, and to know the user's role/status/position/permissions so it
// can route them to the right screen and show them what they can do.
// Deliberately NOT gated behind requireActiveUser — a pending or disabled
// user still needs this response to know why they're locked out.
router.get("/me", requireAuth, async (req, res) => {
  const user = await db.user.findUnique({
    where: { id: req.user.id },
    include: { position: true },
  });
  if (!user) return res.status(404).json({ success: false, message: "User not found" });

  res.json({
    success: true,
    user: {
      id: user.id,
      memberId: user.memberId,
      name: user.name,
      phone: user.phone,
      email: user.email,
      photoUrl: user.photoUrl,
      role: user.role,
      status: user.status,
      position: user.position
        ? { id: user.position.id, name: user.position.name, permissions: user.position.permissions }
        : null,
    },
  });
});

module.exports = router;
