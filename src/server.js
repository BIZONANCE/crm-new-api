const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const authRoutes = require("./routes/auth");
const otpRoutes = require("./routes/otp");
const leadsRoutes = require("./routes/leads");
const activityRoutes = require("./routes/Activity");
const usersRoutes = require("./routes/Users");
const positionsRoutes = require("./routes/positions");
const servicesRoutes = require("./routes/services");
const presenceRoutes = require("./routes/presence");
const analyticsRoutes = require("./routes/analytics");
const publicLeadsRoutes = require("./routes/publicLeads");
const publicServicesRoutes = require("./routes/publicServices");
const databankRoutes = require("./routes/databank");
const profileRoutes = require("./routes/profile");
const notificationsRoutes = require("./routes/notifications");
const catalogRoutes = require("./routes/catalog");
const publicCatalogRoutes = require("./routes/publicCatalog");
const mailRoutes = require("./routes/mail");
const helpRoutes = require("./routes/help");

const { scheduleActivityPurgeJob } = require("./jobs/activityPurge");
const { scheduleLeadPurgeJob } = require("./jobs/leadPurge");
const { scheduleReminderJobs } = require("./jobs/notificationReminders");

const app = express();

const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL,
  "https://crm.bizonance.com",
  "http://localhost:5173",

].filter(Boolean);

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      console.warn(`CORS blocked: ${origin}`);
      callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.options("*", cors());

app.use(express.json({ limit: "10mb" }));

app.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
});

app.use("/public", express.static(path.join(__dirname, "..", "public")));

app.use("/auth", authRoutes);
app.use("/otp", otpRoutes);
app.use("/leads", leadsRoutes);
app.use("/activity", activityRoutes);
app.use("/users", usersRoutes);
app.use("/positions", positionsRoutes);
app.use("/services", servicesRoutes);
app.use("/presence", presenceRoutes);
app.use("/analytics", analyticsRoutes);
app.use("/public/leads", publicLeadsRoutes);
app.use("/public/services", publicServicesRoutes);
app.use("/databank", databankRoutes);
app.use("/profile", profileRoutes);
app.use("/notifications", notificationsRoutes);
app.use("/catalog", catalogRoutes);
app.use("/public/catalog", publicCatalogRoutes);
app.use("/mail", mailRoutes);
app.use("/help", helpRoutes);

app.get("/", (req, res) => {
  res.send("Bizonance CRM backend running");
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ success: false, message: "Server error" });
});

const PORT = process.env.PORT || 4011;
app.listen(PORT, () => {
  console.log(`crm-backend running on port ${PORT}`);
  console.log(`Allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);

  scheduleActivityPurgeJob();
  scheduleLeadPurgeJob();
  scheduleReminderJobs();
});
