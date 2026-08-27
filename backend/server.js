"use strict";

const http = require("http");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const session = require("express-session");
const MySQLStoreFactory = require("express-mysql-session");
const MySQLStore = MySQLStoreFactory(session);
const mysql = require("mysql2/promise");

require("dotenv").config();

const db = require("./config/db");
const ws = require("./config/ws");
require("./services/inboundCallService"); // self-registers AMI listeners on require
require("./services/microsipOutboundService").start(); // Phase 8 — direct MicroSIP outbound detection
const authRoutes = require("./routes/authRoutes");
const dialerRoutes = require("./routes/dialerRoutes");
const adminRoutes = require("./routes/adminRoutes");
const campaignRoutes = require("./routes/campaignRoutes");
const leadRoutes = require("./routes/leadRoutes");
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
REAL BUG FIX, confirmed via direct source inspection of
session-file-store itself: if a session file's JSON ever gets
corrupted mid-read (a parse error), the library automatically DELETES
the session file entirely — not a transient failure. rolling: true
below re-saves the session on every single request to extend its
expiry, and DialerPage.jsx fires a burst of ~8-10 near-simultaneous
API calls on mount — meaning ~8-10 near-simultaneous WRITES to the
exact same session file every time that page loads. File writes
aren't atomic; two overlapping writes can corrupt the file, triggering
that automatic deletion and permanently losing the session — this is
what was actually producing both the ENOENT errors seen directly in
testing tonight and the intermittent "Authentication required" bug
specifically tied to Dialer page navigation.

MySQL correctly serializes concurrent writes to the same row — no
corruption risk the way flat-file writes have. This is the real fix,
not a retry/tuning workaround.

Deliberately a SEPARATE, dedicated pool from config/db.js's own —
that pool's default database is whatever MYSQL_DATABASE resolves to
(asterisk in production), but the sessions table lives in cmx_dialer,
matching this app's own-schema convention elsewhere. express-mysql-
session's tableName option is escaped as a single SQL identifier
(mysql2's ?? placeholder) — a "schema.table" string would NOT resolve
as a qualified reference, it would just be an invalid identifier — so
a dedicated pool with database: "cmx_dialer" set directly is the
correct way to get this right, not a qualified table name string.

Table itself: see backend/sql/007_create_sessions_table.sql — schema
matches express-mysql-session's own reference schema.sql exactly
(verified directly against the installed package).

ONE-TIME SIDE EFFECT: existing file-based sessions won't exist in this
new table — everyone currently logged in needs to log in again once
this deploys. Expected, not a bug.
==================================================
*/

const sessionDbPool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: "cmx_dialer",
  waitForConnections: true,
  connectionLimit: 3,
  queueLimit: 0,
});

const sessionStore = new MySQLStore(
  {
    createDatabaseTable: false, // created explicitly via 007_create_sessions_table.sql
    expiration: SESSION_MAX_AGE_MS,
    schema: {
      tableName: "sessions",
      columnNames: { session_id: "session_id", expires: "expires", data: "data" },
    },
  },
  sessionDbPool
);

sessionStore.on("error", (err) => {
  console.error("[sessionStore] MySQL session store error:", err.message);
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
app.use("/api/admin/campaigns", campaignRoutes);
app.use("/api/admin", leadRoutes);

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