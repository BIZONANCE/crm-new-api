const { hasPermission } = require("../lib/permissions");

// Must run after requireActiveUser (needs req.userRecord, including .position).
function requirePermission(key) {
  return (req, res, next) => {
    if (!hasPermission(req.userRecord, key)) {
      return res.status(403).json({ success: false, message: "You don't have permission to do this." });
    }
    next();
  };
}

module.exports = requirePermission;