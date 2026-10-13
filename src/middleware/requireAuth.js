const jwt = require("jsonwebtoken");
const db = require("../db");

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ success: false, message: "No token provided" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, email }

    // Fire-and-forget presence heartbeat — never awaited, never blocks the
    // request, and a failure here should never take down an otherwise-valid
    // request. This is what powers the "live" green dot.
    db.user
      .update({ where: { id: payload.id }, data: { lastSeenAt: new Date() } })
      .catch(() => {});

    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
}

module.exports = requireAuth;