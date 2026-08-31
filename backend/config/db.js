"use strict";

const mysql = require("mysql2/promise");

const MYSQL_HOST = process.env.MYSQL_HOST;
const MYSQL_PORT = Number(process.env.MYSQL_PORT || 3306);
const MYSQL_USER = process.env.MYSQL_USER;
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD;
const MYSQL_DATABASE = process.env.MYSQL_DATABASE || "asterisk";
const MYSQL_CONNECTION_LIMIT = Number(process.env.MYSQL_CONNECTION_LIMIT || 10);

if (!MYSQL_HOST || !MYSQL_USER || MYSQL_PASSWORD === undefined || MYSQL_PASSWORD === "") {
  throw new Error(
    "Missing MySQL configuration. Set MYSQL_HOST, MYSQL_USER, and MYSQL_PASSWORD in backend/.env."
  );
}

const db = mysql.createPool({
  host: MYSQL_HOST,
  port: MYSQL_PORT,
  user: MYSQL_USER,
  password: MYSQL_PASSWORD,
  database: MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: MYSQL_CONNECTION_LIMIT,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  charset: "utf8mb4",
  // REAL BUG FIX, confirmed live via a real data anomaly: "Z" tells
  // mysql2 to serialize every JS Date parameter as UTC when inserting
  // — but MySQL's DATETIME columns store no timezone info at all, so
  // the resulting string gets written as if it WERE local time, no
  // conversion actually applied on read-back. Confirmed exact 4-hour
  // offset (this server's EDT) between abandoned_call_log's
  // call_started_at (passed as a JS Date parameter, affected) and its
  // own created_at (a MySQL-side CURRENT_TIMESTAMP default, never
  // affected by this driver setting at all) — the call never actually
  // happened in the future, this is where the 4 hours went. "local"
  // tells mysql2 to convert using the Node process's own local
  // timezone instead (confirmed America/New_York, matching the
  // server) — every column here is genuinely meant to represent this
  // server's local time throughout the app (see statsService.js's own
  // "Eastern-day-boundary" logic), never UTC.
  timezone: "local",
});

module.exports = db;