const db = require("../db");

async function notify(userId, { type, title, message, link }) {
  if (!userId) return null;
  try {
    return await db.notification.create({
      data: { userId, type, title, message, link: link || null },
    });
  } catch (err) {
    console.error("notify() failed:", err);
    return null;
  }
}

async function notifyMany(userIds, payload) {
  const unique = [...new Set(userIds.filter(Boolean))];
  await Promise.all(unique.map((id) => notify(id, payload)));
}

async function notifyAllSuperAdmins(payload) {
  const admins = await db.user.findMany({
    where: { role: "SUPER_ADMIN", status: "ACTIVE" },
    select: { id: true },
  });
  await notifyMany(admins.map((a) => a.id), payload);
}

// Looks up the ACTIVE Account Admin managing this user, if any. Returns
// null for a user with no manager, an unassigned Member, or a manager who
// has since left/been disabled — same "no one to notify" outcome as an
// unmanaged user, just resolved from the DB instead of the caller having
// to know the shape of the manager relation.
async function managerIdFor(userId) {
  if (!userId) return null;
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { manager: { select: { id: true, role: true, status: true } } },
  });
  if (!user?.manager) return null;
  if (user.manager.role !== "ACCOUNT_ADMIN" || user.manager.status !== "ACTIVE") return null;
  return user.manager.id;
}

// The main fix: every "something happened on this user's lead/account"
// event should reach every Super Admin (as before) AND the specific
// Account Admin managing that user (new) — not just Super Admins. Use this
// in place of notifyAllSuperAdmins() wherever the event is tied to one
// specific user (a lead's assignedToId, a lead's owner, etc).
async function notifyRelevantAdmins(targetUserId, payload) {
  const [admins, managerId] = await Promise.all([
    db.user.findMany({ where: { role: "SUPER_ADMIN", status: "ACTIVE" }, select: { id: true } }),
    managerIdFor(targetUserId),
  ]);
  const ids = admins.map((a) => a.id);
  if (managerId) ids.push(managerId);
  await notifyMany(ids, payload);
}

// Batch variant for events touching several users at once (bulk delete,
// duplicate-detection sweeps, the nightly inactive-leads job). Notifies
// every Super Admin once with the full-account payload, then notifies each
// relevant Account Admin once with a payload scoped to just their own
// team's slice — built by buildTeamPayload(teamUserIds) so each manager
// sees an accurate count/description for their team, not the whole
// account's total.
//
// affectedUserIds: the owning/assigned user for each affected record.
// allAdminsPayload: the message Super Admins see (whole-account scope).
// buildTeamPayload(teamUserIds): (userIds: string[]) => notification
//   payload for one Account Admin, given just their team's affected ids.
async function notifyRelevantAdminsForUsers(affectedUserIds, allAdminsPayload, buildTeamPayload) {
  const uniqueIds = [...new Set(affectedUserIds.filter(Boolean))];

  await notifyAllSuperAdmins(allAdminsPayload);

  if (uniqueIds.length === 0) return;

  const users = await db.user.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, manager: { select: { id: true, role: true, status: true } } },
  });

  const teamsByManager = new Map();
  for (const u of users) {
    if (u.manager?.role === "ACCOUNT_ADMIN" && u.manager.status === "ACTIVE") {
      if (!teamsByManager.has(u.manager.id)) teamsByManager.set(u.manager.id, []);
      teamsByManager.get(u.manager.id).push(u.id);
    }
  }

  await Promise.all(
    [...teamsByManager.entries()].map(([managerId, teamUserIds]) =>
      notify(managerId, buildTeamPayload(teamUserIds))
    )
  );
}

module.exports = {
  notify,
  notifyMany,
  notifyAllSuperAdmins,
  notifyRelevantAdmins,
  notifyRelevantAdminsForUsers,
};
