"use strict";

const path = require("path");
const http = require("http");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const session = require("express-session");
const FileStore = require("session-file-store")(session);

require("dotenv").config();

const db = require("./config/db");
const ws = require("./config/ws");
require("./services/inboundCallService"); // self-registers AMI listeners on require
const authRoutes = require("./routes/authRoutes");
const dialerRoutes = require("./routes/dialerRoutes");
const adminRoutes = require("./routes/adminRoutes");
const internalRoutes = require("./routes/internalRoutes");

const app = express();

const PORT = Number(process.env.SERVER_PORT) || 5060;

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

const isProduction = process.env.NODE_ENV === "production";

const SESSION_NAME = process.env.SESSION_NAME || "cmx_dialer_session";

const SESSION_MAX_AGE_MS =
  Number(process.env.SESSION_MAX_AGE_HOURS || 12) * 60 * 60 * 1000;

if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET is missing from the backend .env file.");
}

if (!Number.isFinite(SESSION_MAX_AGE_MS) || SESSION_MAX_AGE_MS <= 0) {
  throw new Error("SESSION_MAX_AGE_HOURS must be a positive number.");
}

if (isProduction) {
  app.set("trust proxy", 1);
}

/*
==================================================
SECURITY AND REQUEST MIDDLEWARE
==================================================
*/

app.use(helmet());

app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
  })
);

app.use(express.json({ limit: "1mb" }));

app.use(morgan("dev"));

/*
==================================================
SESSION MIDDLEWARE
==================================================
*/

const sessionStore = new FileStore({
  path: path.join(__dirname, "sessions"),
  ttl: SESSION_MAX_AGE_MS / 1000,
  retries: 1,
  reapInterval: 60 * 60,

  logFn: (message) => {
    if (String(message).toLowerCase().includes("error")) {
      console.error(message);
    }
  },
});

app.use(
  session({
    name: SESSION_NAME,
    secret: process.env.SESSION_SECRET,

    store: sessionStore,

    resave: false,
    saveUninitialized: false,
    rolling: true,

    cookie: {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
      maxAge: SESSION_MAX_AGE_MS,
    },
  })
);

/*
==================================================
HEALTH CHECK
==================================================
*/

app.get("/api/health", (req, res) => {
  return res.status(200).json({
    success: true,
    app: "CMX Dialer API",
    status: "running",
    environment: process.env.NODE_ENV || "development",
  });
});

/*
==================================================
API ROUTES
==================================================
*/

app.use("/api/auth", authRoutes);
app.use("/api", dialerRoutes);
app.use("/api/admin", adminRoutes);

// Not session-authenticated — called by Asterisk's dialplan via
// CURL(), protected by INTERNAL_API_SECRET instead. See
// internalRoutes.js for why this is mounted separately from /api.
app.use("/internal", internalRoutes);

/*
==================================================
404 HANDLER
==================================================
*/

app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message: "API route not found.",
    method: req.method,
    path: req.originalUrl,
  });
});

/*
==================================================
ERROR HANDLER
==================================================
*/

app.use((error, req, res, next) => {
  console.error("Unhandled server error:", error);

  if (res.headersSent) {
    return next(error);
  }

  if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
    return res.status(400).json({
      success: false,
      message: "The request body contains invalid JSON.",
    });
  }

  return res.status(error.status || 500).json({
    success: false,
    message: "An unexpected server error occurred.",
    error_details: !isProduction ? error.sqlMessage || error.message : undefined,
  });
});

/*
==================================================
START SERVER
==================================================
*/

async function startServer() {
  try {
    await db.query("SELECT 1 AS connected");

    console.log("Connected to MySQL (asterisk schema).");

    const httpServer = http.createServer(app);
    ws.attach(httpServer, sessionStore);

    httpServer.listen(PORT, () => {
      console.log(`CMX Dialer API running on port ${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
      console.log(`Frontend URL: ${FRONTEND_URL}`);
      console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws/dialer`);
    });
  } catch (error) {
    console.error("CMX Dialer API failed to start:", {
      code: error.code || null,
      errno: error.errno || null,
      sqlState: error.sqlState || null,
      message: error.sqlMessage || error.message,
    });

    process.exit(1);
  }
}

startServer();