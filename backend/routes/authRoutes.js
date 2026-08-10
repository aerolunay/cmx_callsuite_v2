"use strict";

const express = require("express");
const bcrypt = require("bcryptjs");

const db = require("../config/db");

const router = express.Router();

const SESSION_NAME = process.env.SESSION_NAME || "cmx_dialer_session";

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

// vicidial_users.pass is either plaintext or a bcrypt hash depending on this
// ViciDial install's "Encrypt User Passwords" system setting — detect by the
// bcrypt "$2a$/$2b$/$2y$" prefix rather than trusting a hardcoded flag, since
// that avoids depending on the exact system_settings column name/shape.
async function verifyPassword(suppliedPassword, storedHash) {
  const hash = String(storedHash || "");

  if (/^\$2[aby]\$/.test(hash)) {
    return bcrypt.compare(suppliedPassword, hash);
  }

  return suppliedPassword === hash;
}

async function findActiveAgentByUsername(username) {
  const [rows] = await db.execute(
    `
      SELECT
        vu.user,
        vu.pass,
        vu.full_name,
        vu.user_level,
        vu.user_group,
        vu.phone_login,
        vu.active,
        p.extension AS agent_extension,
        p.protocol AS agent_protocol
      FROM vicidial_users vu
      LEFT JOIN phones p ON p.login = vu.phone_login
      WHERE vu.user = ?
      LIMIT 1
    `,
    [username]
  );

  if (!rows.length) {
    return null;
  }

  const agent = rows[0];

  if (String(agent.active || "").trim().toUpperCase() !== "Y") {
    return null;
  }

  return agent;
}

function sanitizeAgent(agent) {
  return {
    username: agent.user,
    full_name: agent.full_name,
    user_level: agent.user_level,
    user_group: agent.user_group,
    extension: agent.agent_extension,
    protocol: agent.agent_protocol,
  };
}

/*
==================================================
LOGIN
==================================================
POST /api/auth/login
==================================================
*/
router.post("/login", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: "Please enter a username and password.",
      });
    }

    const agent = await findActiveAgentByUsername(username);

    if (!agent) {
      return res.status(401).json({
        success: false,
        message: "Invalid username or password.",
      });
    }

    const passwordMatches = await verifyPassword(password, agent.pass);

    if (!passwordMatches) {
      return res.status(401).json({
        success: false,
        message: "Invalid username or password.",
      });
    }

    if (!agent.agent_extension) {
      return res.status(409).json({
        success: false,
        message:
          "This agent has no phone extension configured in ViciDial's phones table.",
      });
    }

    await regenerateSession(req);

    req.session.authenticated = true;
    req.session.agent = sanitizeAgent(agent);
    req.session.login_datetime = new Date().toISOString();

    await saveSession(req);

    return res.json({
      success: true,
      message: "Login successful.",
      agent: req.session.agent,
    });
  } catch (error) {
    console.error("Login failed:", error);

    return res.status(500).json({
      success: false,
      message: "We could not log you in. Please try again.",
    });
  }
});

/*
==================================================
CURRENT SESSION
==================================================
GET /api/auth/me
==================================================
*/
router.get("/me", (req, res) => {
  if (!req.session || !req.session.authenticated || !req.session.agent) {
    return res.status(401).json({
      success: false,
      message: "Authentication required.",
    });
  }

  return res.json({
    success: true,
    agent: req.session.agent,
  });
});

/*
==================================================
LOGOUT
==================================================
POST /api/auth/logout
==================================================
*/
router.post("/logout", (req, res) => {
  if (!req.session) {
    res.clearCookie(SESSION_NAME, { path: "/" });

    return res.json({
      success: true,
      message: "You have been logged out.",
    });
  }

  req.session.destroy((error) => {
    if (error) {
      console.error("Logout failed:", error);

      return res.status(500).json({
        success: false,
        message: "We could not log you out. Please try again.",
      });
    }

    res.clearCookie(SESSION_NAME, { path: "/" });

    return res.json({
      success: true,
      message: "You have been logged out.",
    });
  });
});

module.exports = router;
