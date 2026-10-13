const express = require("express");
const multer = require("multer");
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");
const requireActiveUser = require("../middleware/requireActiveUser");
const { uploadImage } = require("../utils/mediaServer");
const { notify } = require("../lib/notify");

const router = express.Router();
router.use(requireAuth);
router.use(requireActiveUser);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed"));
    }
    cb(null, true);
  },
});

const PHONE_RE = /^\d{10}$/;

function shapeUser(user) {
  return {
    id: user.id,
    memberId: user.memberId,
    name: user.name,
    phone: user.phone,
    email: user.email,
    role: user.role,
    status: user.status,
    photoUrl: user.photoUrl,
    position: user.position
      ? { id: user.position.id, name: user.position.name, permissions: user.position.permissions }
      : null,
  };
}

// PATCH /profile/me — the logged-in user editing their OWN name and/or
// phone number. Both fields are optional per-request, but each one sent
// is validated and applied; email and memberId are never accepted here —
// those stay admin-managed.
router.patch("/me", async (req, res) => {
  const { name, phone } = req.body;
  const data = {};

  if (name !== undefined) {
    const trimmedName = String(name).trim();
    if (!trimmedName) {
      return res.status(400).json({ success: false, message: "Name is required" });
    }
    data.name = trimmedName;
  }

  if (phone !== undefined) {
    const trimmedPhone = String(phone).trim();
    if (!trimmedPhone) {
      return res.status(400).json({ success: false, message: "Phone number is required" });
    }
    if (!PHONE_RE.test(trimmedPhone)) {
      return res.status(400).json({ success: false, message: "Phone number must be exactly 10 digits" });
    }

    const clash = await db.user.findFirst({ where: { phone: trimmedPhone, NOT: { id: req.userRecord.id } } });
    if (clash) {
      return res.status(409).json({ success: false, message: "That phone number is already in use" });
    }
    data.phone = trimmedPhone;
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ success: false, message: "Nothing to update" });
  }

  const user = await db.user.update({
    where: { id: req.userRecord.id },
    data,
    include: { position: true },
  });

  await notify(user.id, {
    type: "PROFILE_UPDATED",
    title: "Profile updated",
    message: "Your profile was updated successfully",
    link: null,
  });

  res.json({ success: true, user: shapeUser(user) });
});

// POST /profile/photo — uploads to the Bizonance media server, then stores
// the returned download URL on the caller's own photoUrl field.
router.post("/photo", upload.single("photo"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "No image file provided" });
  }

  let photoUrl;
  try {
    photoUrl = await uploadImage(req.file.buffer, req.file.originalname, req.file.mimetype);
  } catch (err) {
    console.error("media upload failed:", err);
    return res.status(502).json({ success: false, message: "Could not upload image to media server" });
  }

  const user = await db.user.update({
    where: { id: req.userRecord.id },
    data: { photoUrl },
    include: { position: true },
  });

  await notify(user.id, {
    type: "PROFILE_UPDATED",
    title: "Profile photo updated",
    message: "Your profile photo was updated successfully",
    link: null,
  });

  res.json({ success: true, user: shapeUser(user) });
});

// DELETE /profile/photo — removes the caller's own profile photo, reverting
// to the default avatar. Only clears the DB reference; doesn't delete the
// file from the media server itself.
router.delete("/photo", async (req, res) => {
  const user = await db.user.update({
    where: { id: req.userRecord.id },
    data: { photoUrl: null },
    include: { position: true },
  });

  await notify(user.id, {
    type: "PROFILE_UPDATED",
    title: "Profile photo removed",
    message: "Your profile photo was removed",
    link: null,
  });

  res.json({ success: true, user: shapeUser(user) });
});

module.exports = router;
