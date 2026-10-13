// Super Admin OR Account Admin. Must run after requireActiveUser (needs
// req.userRecord). This only gets a request past the door — every route
// using this still needs to scope its data by team for Account Admin (see
// lib/permissions.js's visibleUserIds), since this middleware alone doesn't
// restrict *which* users' data someone can touch.
function requireAdmin(req, res, next) {
  if (!req.userRecord || !["SUPER_ADMIN", "ACCOUNT_ADMIN"].includes(req.userRecord.role)) {
    return res.status(403).json({ success: false, message: "Admin access required" });
  }
  next();
}

module.exports = requireAdmin;
