// lib/mailStorage.js
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const MAIL_UPLOAD_DIR = path.join(__dirname, "..", "uploads", "mail");
fs.mkdirSync(MAIL_UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, MAIL_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}-${file.originalname.replace(/[^\w.\-]/g, "_")}`);
  },
});

const uploadMailAttachments = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024, files: 5 }, // 15MB/file, 5 files/message
});

module.exports = { MAIL_UPLOAD_DIR, uploadMailAttachments };
