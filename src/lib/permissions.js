// The full set of permission flags a Position can grant. Add new entries here
// as new gated actions get built — no migration needed since Position.permissions
// is a JSON column.
//
// Viewing/creating/editing leads, viewing the Activity feed, and accessing
// Databank are no longer permission-gated — every active user can do these,
// scoped automatically by role (Member: own data only, Account Admin: their
// team, Super Admin: everything), exactly as the underlying routes already
// filter data. Only the flags below are still something a Position can grant
// or withhold.
const PERMISSION_DEFS = [
  { key: "canDeleteLeads", label: "Delete leads" },
  { key: "canTransferLeads", label: "Transfer leads" },
  { key: "canExportData", label: "Export leads (CSV / Excel)" },
  { key: "canViewAnalytics", label: "View Analytics Report" },
  { key: "canManageCatalog", label: "Manage Product Catalog (create/edit/delete/reorder)" },
];

const PERMISSION_KEYS = PERMISSION_DEFS.map((p) => p.key);

// Only Super Admin is unconditionally granted every permission — there's
// exactly one, and it's the account owner. Account Admin gets NO automatic
// grant: their permissions (delete leads, transfer leads, export, analytics,
// catalog management) come from their assigned Position, exactly like a
// Member's.
function hasPermission(userRecord, key) {
  if (userRecord.role === "SUPER_ADMIN") return true;
  return !!userRecord.position?.permissions?.[key];
}

// True for the two roles that manage other users' accounts and can see
// more than just their own leads. Account Admin's actual reach is still
// narrowed per-route — see visibleUserIds below.
function isAdmin(userRecord) {
  return userRecord.role === "SUPER_ADMIN" || userRecord.role === "ACCOUNT_ADMIN";
}

// The set of user ids this person is allowed to see/manage data for.
// - Super Admin: null, meaning "no restriction" — callers should skip the
//   id filter entirely rather than treating null as an empty set.
// - Account Admin: themselves + everyone reporting to them.
// - Member: just themselves.
// Requires req.userRecord to have been loaded with its teamMembers relation
// (see middleware/requireActiveUser.js).
function visibleUserIds(userRecord) {
  if (userRecord.role === "SUPER_ADMIN") return null;
  if (userRecord.role === "ACCOUNT_ADMIN") {
    return [userRecord.id, ...(userRecord.teamMembers || []).map((u) => u.id)];
  }
  return [userRecord.id];
}

module.exports = { PERMISSION_DEFS, PERMISSION_KEYS, hasPermission, isAdmin, visibleUserIds };
