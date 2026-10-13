// Must run after requireActiveUser (needs req.userRecord already populated).
function requireSuperAdmin(req, res, next) {
  if (!req.userRecord || req.userRecord.role !== "SUPER_ADMIN") {
    return res.status(403).json({ success: false, message: "Super Admin access required" });
  }
  next();
}

module.exports = requireSuperAdmin;