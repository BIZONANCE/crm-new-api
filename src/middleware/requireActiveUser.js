const db = require("../db");

// Runs after requireAuth. Loads the full user record (role + status) fresh
// from the DB on every request — deliberately not trusting the JWT for this,
// so a Super Admin disabling someone takes effect on their very next request,
// not just after their token expires.
async function requireActiveUser(req, res, next) {
  const user = await db.user.findUnique({
    where: { id: req.user.id },
    include: {
      position: true, // needed so hasPermission() can read position.permissions
      // Needed so an Account Admin's "visible user ids" can be computed
      // without an extra query on every team-scoped route. Empty array for
      // Super Admin and Member, since only Account Admins have reports.
      teamMembers: { select: { id: true } },
    },
  });

  if (!user) {
    return res.status(401).json({ success: false, message: "User not found" });
  }
  if (user.status === "PENDING") {
    return res.status(403).json({ success: false, message: "Your account is awaiting approval from a Super Admin.", status: "PENDING" });
  }
  if (user.status === "DISABLED") {
    return res.status(403).json({ success: false, message: "Your account has been disabled.", status: "DISABLED" });
  }
  // A soft-deleted ("Left") user still has a row in the DB — for history's
  // sake — but must be blocked exactly like DISABLED for every live request.
  if (user.status === "LEFT") {
    return res.status(403).json({ success: false, message: "This account is no longer active.", status: "LEFT" });
  }

  req.userRecord = user; // { id, email, role, status, createdAt, position, teamMembers }
  next();
}

module.exports = requireActiveUser;
