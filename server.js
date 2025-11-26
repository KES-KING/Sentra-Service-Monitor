// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const mysql = require("mysql2/promise");
const { exec } = require("child_process");
const { listServices } = require("./services");

const app = express();
const PORT = process.env.PORT || 4001;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "change-this-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
    },
  })
);

// MySQL connection pool for auth
const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "sentra_monitor",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

async function findUserByUsername(username) {
  const [rows] = await pool.execute(
    "SELECT id, username, password_hash FROM users WHERE username = ? LIMIT 1",
    [username]
  );
  return rows[0] || null;
}

async function findUserById(id) {
  const [rows] = await pool.execute(
    "SELECT id, username, password_hash FROM users WHERE id = ? LIMIT 1",
    [id]
  );
  return rows[0] || null;
}

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  return res.status(401).json({ success: false, error: "Unauthorized" });
}

// Helpers ---------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeReadFile(path) {
  try {
    return fs.readFileSync(path, "utf8");
  } catch (err) {
    return null;
  }
}

function readCpuTimes() {
  const content = safeReadFile("/proc/stat");
  if (!content) return null;
  const line = content.split("\n")[0];
  const parts = line.trim().split(/\s+/);
  // cpu user nice system idle iowait irq softirq steal guest guest_nice
  const numbers = parts.slice(1).map((n) => parseInt(n, 10));
  if (numbers.some((n) => Number.isNaN(n))) return null;
  const idle = numbers[3] + numbers[4]; // idle + iowait
  const total = numbers.reduce((a, b) => a + b, 0);
  return { idle, total };
}

async function getCpuUsage() {
  const first = readCpuTimes();
  if (!first) return null;
  await sleep(200);
  const second = readCpuTimes();
  if (!second) return null;
  const idleDelta = second.idle - first.idle;
  const totalDelta = second.total - first.total || 1;
  const usage = 1 - idleDelta / totalDelta;
  const usagePct = Math.max(0, Math.min(100, usage * 100));
  return { usage: usagePct };
}

function parseMemInfo() {
  const content = safeReadFile("/proc/meminfo");
  if (!content) return null;
  const lines = content.split("\n");
  const map = {};
  for (const line of lines) {
    const match = line.match(/^([^:]+):\s+(\d+)/);
    if (match) {
      map[match[1]] = parseInt(match[2], 10) * 1024; // to bytes
    }
  }
  return map;
}

function getMemoryInfo() {
  const mem = parseMemInfo();
  if (!mem) return null;
  const total = mem.MemTotal || 0;
  const free = mem.MemFree || 0;
  const buffers = mem.Buffers || 0;
  const cached = mem.Cached || 0;
  const used = total - free - buffers - cached;
  const usedPct = total ? (used / total) * 100 : 0;

  const swapTotal = mem.SwapTotal || 0;
  const swapFree = mem.SwapFree || 0;
  const swapUsed = swapTotal - swapFree;
  const swapUsedPct = swapTotal ? (swapUsed / swapTotal) * 100 : 0;

  return {
    memory: {
      total,
      used,
      free,
      usedPct: Math.max(0, Math.min(100, usedPct)),
    },
    swap: {
      total: swapTotal,
      used: swapUsed,
      free: swapFree,
      usedPct: Math.max(0, Math.min(100, swapUsedPct)),
    },
  };
}

function pickPrimaryDisk(lines) {
  // choose first non-loop/ram/sr device
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 14) continue;
    const name = parts[2];
    if (
      name.startsWith("loop") ||
      name.startsWith("ram") ||
      name.startsWith("sr")
    ) {
      continue;
    }
    const readSectors = parseInt(parts[5], 10);
    const writeSectors = parseInt(parts[9], 10);
    if (Number.isNaN(readSectors) || Number.isNaN(writeSectors)) continue;
    return { name, readSectors, writeSectors };
  }
  return null;
}

function readDiskStats() {
  const content = safeReadFile("/proc/diskstats");
  if (!content) return null;
  const lines = content.split("\n").filter(Boolean);
  return pickPrimaryDisk(lines);
}

async function getDiskIO() {
  const first = readDiskStats();
  if (!first) return null;
  await sleep(200);
  const second = readDiskStats();
  if (!second || second.name !== first.name) return null;

  const sectorSize = 512; // bytes
  const deltaRead = Math.max(0, second.readSectors - first.readSectors);
  const deltaWrite = Math.max(0, second.writeSectors - first.writeSectors);
  const intervalSec = 0.2;
  const readKBps = (deltaRead * sectorSize) / 1024 / intervalSec;
  const writeKBps = (deltaWrite * sectorSize) / 1024 / intervalSec;
  return {
    device: second.name,
    readKBps,
    writeKBps,
  };
}

// Routes ----------------------------------------------------------
// Login / logout and page routing
app.get("/login", (req, res) => {
  res.sendFile(require("path").join(__dirname, "public", "login.html"));
});

app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (
      typeof username !== "string" ||
      typeof password !== "string" ||
      !username.trim() ||
      !password
    ) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid credentials" });
    }

    const user = await findUserByUsername(username.trim());
    if (!user) {
      return res
        .status(401)
        .json({ success: false, error: "Invalid username or password" });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res
        .status(401)
        .json({ success: false, error: "Invalid username or password" });
    }

    req.session.userId = user.id;
    req.session.username = user.username;

    return res.json({ success: true });
  } catch (err) {
    console.error("Login error:", err);
    return res
      .status(500)
      .json({ success: false, error: "Login failed", details: String(err) });
  }
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// Dashboard page (protect main UI)
app.get("/", (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.redirect("/login");
  }
  res.sendFile(require("path").join(__dirname, "public", "index.html"));
});

app.get("/index.html", (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.redirect("/login");
  }
  res.sendFile(require("path").join(__dirname, "public", "index.html"));
});

// User settings page
app.get("/user-settings", (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.redirect("/login");
  }
  res.sendFile(require("path").join(__dirname, "public", "user-settings.html"));
});

// Console page
app.get("/console", (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.redirect("/login");
  }
  res.sendFile(require("path").join(__dirname, "public", "console.html"));
});

// static assets (logo, etc.)
app.use(
  "/assets",
  express.static(require("path").join(__dirname, "public", "assets"))
);
// List all systemd services
app.get("/api/services", requireAuth, async (req, res) => {
  try {
    const services = await listServices();
    res.json({ success: true, services });
  } catch (err) {
    console.error("Error while listing services:", err);
    res.status(500).json({
      success: false,
      error: "Could not list services",
      details: String(err),
    });
  }
});

// Single service: status + logs
app.get("/api/services/:name", requireAuth, (req, res) => {
  const name = req.params.name;

  // Basic validation to avoid injection
  if (!/^[a-zA-Z0-9_.@\-]+\.service$/.test(name)) {
    return res
      .status(400)
      .json({ success: false, error: "Invalid service name" });
  }

  const statusCmd = `systemctl status ${name} --no-pager`;
  const logsCmd = `journalctl -u ${name} --no-pager -n 200 --output=short-iso`;

  exec(statusCmd, { maxBuffer: 1024 * 1024 }, (statusError, statusStdout) => {
    if (statusError && !statusStdout) {
      return res
        .status(500)
        .json({ success: false, error: "Could not read service status" });
    }

    exec(logsCmd, { maxBuffer: 1024 * 1024 }, (logsError, logsStdout) => {
      let logsText;
      if (logsError && !logsStdout) {
        logsText = "Could not fetch logs: " + String(logsError);
      } else {
        logsText = logsStdout.toString();
      }

      res.json({
        success: true,
        name,
        statusText: statusStdout.toString(),
        logsText,
      });
    });
  });
});

// Failed services with last state change timestamps
app.get("/api/failed-services", requireAuth, async (req, res) => {
  try {
    const services = await listServices();
    const failed = services.filter(
      (s) => String(s.active || "").toLowerCase() === "failed"
    );

    const promises = failed.map(
      (svc) =>
        new Promise((resolve) => {
          const showCmd = `systemctl show ${svc.name} -p StateChangeTimestamp -p ActiveEnterTimestamp -p InactiveEnterTimestamp`;
          exec(
            showCmd,
            { maxBuffer: 1024 * 1024 },
            (error, stdout /*, stderr */) => {
              let failedAt = null;
              if (!error && stdout) {
                const lines = stdout
                  .toString()
                  .split("\n")
                  .map((l) => l.trim())
                  .filter(Boolean);

                const readField = (key) => {
                  const line = lines.find((ln) => ln.startsWith(key + "="));
                  if (!line) return null;
                  const value = line.slice(key.length + 1).trim();
                  if (!value || value === "n/a") return null;
                  return value;
                };

                failedAt =
                  readField("StateChangeTimestamp") ||
                  readField("InactiveEnterTimestamp") ||
                  readField("ActiveEnterTimestamp");
              }

              resolve({
                name: svc.name,
                description: svc.description,
                active: svc.active,
                sub: svc.sub,
                load: svc.load,
                failedAt,
              });
            }
          );
        })
    );

    const failedWithTimes = await Promise.all(promises);
    res.json({ success: true, failedServices: failedWithTimes });
  } catch (err) {
    console.error("Error while listing failed services:", err);
    res.status(500).json({
      success: false,
      error: "Could not list failed services",
      details: String(err),
    });
  }
});

// Restart a service
app.post("/api/services/:name/restart", requireAuth, (req, res) => {
  const name = req.params.name;

  if (!/^[a-zA-Z0-9_.@\-]+\.service$/.test(name)) {
    return res
      .status(400)
      .json({ success: false, error: "Invalid service name" });
  }

  const restartCmd = `systemctl restart ${name}`;

  exec(restartCmd, { maxBuffer: 1024 * 1024 }, (error /*, stdout, stderr */) => {
    if (error) {
      console.error("Service could not be restarted:", error);
      return res
        .status(500)
        .json({ success: false, error: "Service could not be restarted" });
    }

    res.json({
      success: true,
      name,
      message: "Service restarted",
    });
  });
});

// System metrics: CPU / memory / swap / disk IO
app.get("/api/metrics", requireAuth, async (req, res) => {
  try {
    const [cpu, memSwap, disk] = await Promise.all([
      getCpuUsage(),
      Promise.resolve(getMemoryInfo()),
      getDiskIO(),
    ]);

    res.json({
      success: true,
      metrics: {
        cpu,
        memory: memSwap ? memSwap.memory : null,
        swap: memSwap ? memSwap.swap : null,
        disk,
      },
    });
  } catch (err) {
    console.error("Error while fetching metrics:", err);
    res.status(500).json({
      success: false,
      error: "Could not fetch metrics",
      details: String(err),
    });
  }
});

// Change password for current user
app.post("/api/user/change-password", requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { currentPassword, newPassword } = req.body || {};

    if (
      typeof currentPassword !== "string" ||
      typeof newPassword !== "string" ||
      !currentPassword ||
      !newPassword
    ) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid password input" });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        error: "New password must be at least 8 characters",
      });
    }

    const user = await findUserById(userId);
    if (!user) {
      return res
        .status(404)
        .json({ success: false, error: "User not found" });
    }

    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) {
      return res
        .status(401)
        .json({ success: false, error: "Current password is incorrect" });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.execute("UPDATE users SET password_hash = ? WHERE id = ?", [
      newHash,
      user.id,
    ]);

    res.json({ success: true, message: "Password updated successfully" });
  } catch (err) {
    console.error("Change password error:", err);
    res.status(500).json({
      success: false,
      error: "Could not change password",
      details: String(err),
    });
  }
});

// Limited console command execution
app.post("/api/console/exec", requireAuth, (req, res) => {
  try {
    const { command } = req.body || {};

    if (typeof command !== "string") {
      return res
        .status(400)
        .json({ success: false, error: "Command must be a string" });
    }

    const trimmed = command.trim();
    if (!trimmed) {
      return res
        .status(400)
        .json({ success: false, error: "Command must not be empty" });
    }

    if (trimmed.length > 200) {
      return res.status(400).json({
        success: false,
        error: "Command is too long (max 200 characters)",
      });
    }

    const lowered = trimmed.toLowerCase();

    // Block sudo explicitly
    if (/\bsudo\b/.test(lowered)) {
      return res
        .status(400)
        .json({ success: false, error: "sudo is not allowed" });
    }

    // Block some obviously dangerous commands (defence in depth)
    const forbiddenWords = [
      "rm ",
      " rm",
      "mkfs",
      "shutdown",
      "reboot",
      "poweroff",
      "halt",
      "dd ",
      " :(){:|:;&};:",
      "systemctl",
      "service ",
      "kill ",
      "killall",
      "pkill",
      "mount",
      "umount",
      "docker",
      "kubectl",
      "passwd",
      "useradd",
      "userdel",
      "chown ",
      "chmod ",
      "cp ",
      "mv ",
    ];
    if (forbiddenWords.some((w) => lowered.includes(w))) {
      return res.status(400).json({
        success: false,
        error: "This command is not allowed for safety reasons",
      });
    }

    // Disallow shell metacharacters to avoid chaining/injection
    if (/[;&|`$<>]/.test(trimmed)) {
      return res.status(400).json({
        success: false,
        error: "Command contains forbidden characters",
      });
    }

    // Basic allowed charset: letters, digits, space, dot, slash, dash, underscore, equals
    if (!/^[a-zA-Z0-9_./=\-\s]+$/.test(trimmed)) {
      return res.status(400).json({
        success: false,
        error: "Command contains unsupported characters",
      });
    }

    exec(
      trimmed,
      {
        timeout: 5000,
        maxBuffer: 1024 * 128,
      },
      (error, stdout, stderr) => {
        if (error && !stdout && !stderr) {
          return res.status(500).json({
            success: false,
            error: "Command failed or timed out",
            details: String(error),
          });
        }

        res.json({
          success: true,
          command: trimmed,
          stdout: stdout ? stdout.toString().slice(0, 8000) : "",
          stderr: stderr ? stderr.toString().slice(0, 8000) : "",
        });
      }
    );
  } catch (err) {
    console.error("Console exec error:", err);
    res.status(500).json({
      success: false,
      error: "Could not execute command",
      details: String(err),
    });
  }
});

app.listen(PORT, () => {
  console.log(
    `Linux Service Dashboard is running on http://localhost:${PORT}`
  );
});
