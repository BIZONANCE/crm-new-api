const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");
const { sendOtpEmail } = require("../utils/mailer");
const { notify } = require("../lib/notify");

const router = express.Router();

const OTP_TTL_MINUTES = 2;

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

router.post("/send-otp", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, message: "Email is required" });
    }

    const existingUser = await db.user.findUnique({ where: { email } });
    if (existingUser?.status === "INVITED" && existingUser.inviteToken) {
      return res.status(403).json({
        success: false,
        message: "Please verify your invite first — check your inbox for the verification link we sent you.",
      });
    }

    const code = generateCode();
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    await db.otp.deleteMany({ where: { email } });
    await db.otp.create({ data: { email, code, expiresAt } });

    const devMode = process.env.DEV_MODE === "true";

    if (devMode) {
      console.log(`\n[DEV_MODE] OTP for ${email}: ${code}\n`);
      return res.json({ success: true, message: "OTP generated (dev mode, not emailed)", devOtp: code });
    }

    await sendOtpEmail(email, code);

    res.json({ success: true, message: "OTP sent" });
  } catch (err) {
    console.error("send-otp error:", err);
    res.status(500).json({ success: false, message: "Could not send OTP" });
  }
});

router.post("/verify-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) {
      return res.status(400).json({ success: false, message: "Email and OTP are required" });
    }

    const record = await db.otp.findFirst({
      where: { email },
      orderBy: { createdAt: "desc" },
    });

    if (!record) {
      return res.status(400).json({ success: false, message: "No OTP found for this email. Please request a new one." });
    }
    if (record.expiresAt < new Date()) {
      return res.status(400).json({ success: false, message: "OTP has expired. Please request a new one." });
    }
    if (record.code !== otp) {
      return res.status(400).json({ success: false, message: "Incorrect OTP" });
    }

    await db.otp.delete({ where: { id: record.id } });

    let user = await db.user.findUnique({ where: { email }, include: { position: true } });

    if (!user) {
      const isFirstUserEver = (await db.user.count()) === 0;
      user = await db.user.create({
        data: {
          email,
          role: isFirstUserEver ? "SUPER_ADMIN" : "MEMBER",
          status: isFirstUserEver ? "ACTIVE" : "PENDING",
        },
        include: { position: true },
      });
    }

    if (user.status === "DISABLED") {
      return res.status(403).json({ success: false, message: "Your account has been disabled. Contact your Super Admin." });
    }

    if (user.status === "LEFT") {
      return res.status(403).json({ success: false, message: "This account is no longer active. Contact your Super Admin." });
    }

    if (user.status === "INVITED") {
      if (user.inviteToken) {
        return res.status(403).json({
          success: false,
          message: "Please verify your invite first — check your inbox for the verification link we sent you.",
        });
      }
      user = await db.user.update({
        where: { id: user.id },
        data: { status: "ACTIVE" },
        include: { position: true },
      });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
    );

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    await db.sessionLog.deleteMany({ where: { createdAt: { lt: startOfToday } } });
    await db.sessionLog.create({ data: { userId: user.id, type: "LOGIN" } });

    // Account & Session — lets the user see a record of sign-ins to their
    // own account from the notification bell.
    await notify(user.id, {
      type: "NEW_LOGIN",
      title: "New login detected",
      message: "A new sign-in to your account was just recorded",
      link: null,
    });

    res.json({
      success: true,
      message: "Email verified",
      token,
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
          ? {
            id: user.position.id,
            name: user.position.name,
            permissions: user.position.permissions,
          }
          : null,
      },
    });
  } catch (err) {
    console.error("verify-otp error:", err);
    res.status(500).json({ success: false, message: "Could not verify OTP" });
  }
});

module.exports = router;
