const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const authRoutes = require("./routes/auth");
const feedbackRoutes = require("./routes/feedback");
const taskRoutes = require("./routes/tasks");
const dashboardRoutes = require("./routes/dashboard");
const settingsRoutes = require("./routes/settings");
const teamRoutes = require("./routes/team");
const activityRoutes = require("./routes/activity");
const timerRoutes = require("./routes/timers");
const sprintRoutes = require("./routes/sprints");

const app = express();
const PORT = process.env.PORT || 5000;
const mongoUri = process.env.MONGODB_URL;

mongoose.set("bufferCommands", false);

// Security middleware
app.use(helmet());
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  }),
);

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: "Too many requests, please try again later." },
});
app.use("/api/", limiter);

// AI rate limit - stricter
const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: {
    error:
      "AI rate limit reached. Please wait before processing more feedback.",
  },
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    database:
      mongoose.connection.readyState === 1 ? "connected" : "disconnected",
    timestamp: new Date().toISOString(),
  });
});

app.use("/api", (req, res, next) => {
  if (mongoose.connection.readyState === 1) {
    return next();
  }

  return res.status(503).json({
    error: "Database unavailable",
    message:
      "MongoDB is not connected. Check backend logs and your MONGODB_URL/DNS/network settings.",
  });
});

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/feedback", aiLimiter, feedbackRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/team", teamRoutes);
app.use("/api/activity", activityRoutes);
app.use("/api/timers", timerRoutes);
app.use("/api/sprints", sprintRoutes);

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: err.message || "Internal Server Error",
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
});

const explainMongoError = (err) => {
  if (err?.code === "ECONNREFUSED" && err?.syscall === "querySrv") {
    return [
      "MongoDB SRV DNS lookup was refused.",
      "This usually means your network/DNS cannot resolve mongodb+srv records.",
      "Try another network, set DNS to 8.8.8.8/1.1.1.1, disable VPN/proxy filtering, or use a non-SRV mongodb:// connection string.",
    ].join(" ");
  }

  return err?.message || "Unknown MongoDB connection error.";
};

const connectToMongo = async () => {
  if (!mongoUri) {
    console.error(
      "MongoDB connection failed: missing MONGODB_URL environment variable.",
    );
    return;
  }

  try {
    console.log("MongoDB connection starting with MONGODB_URL.");
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 10000,
    });
    console.log(`MongoDB connection successful: ${mongoose.connection.host}`);
  } catch (err) {
    console.error("MongoDB connection failed:", err);
    console.error("MongoDB connection help:", explainMongoError(err));
  }
};

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  connectToMongo();
});

module.exports = app;
