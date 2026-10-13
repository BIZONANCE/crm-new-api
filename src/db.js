const { PrismaClient } = require("@prisma/client");

// Reuse a single PrismaClient instance across the app (and across
// nodemon hot-reloads in dev) instead of opening a new pool per import.
const db = new PrismaClient();

module.exports = db;
