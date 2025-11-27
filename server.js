// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const mysql = require("mysql2/promise");
const { exec } = require("child_process");
const IS_WINDOWS = process.platform === "win32";

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

// Agent auth via X-APP-ID header
async function verifyAgent(req, res, next) {
  try {
    const appId = req.headers["x-app-id"];
    if (!appId) {
      return res.status(400).json({ status: "error", error: "X-APP-ID header required" });
    }

    const [rows] = await pool.execute("SELECT * FROM agents WHERE app_id = ? LIMIT 1", [appId]);
    if (rows.length === 0) {
      return res.status(403).json({ status: "error", error: "Unknown AppID. Please register this agent first." });
    }

    req.agent = rows[0];
    next();
  } catch (err) {
    console.error("verifyAgent error:", err);
    res.status(500).json({ status: "error", error: "Agent verification failed", details: String(err) });
  }
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
  // Filter out loop, ram, and sr devices, but accept physical and virtual disks
  // Support: sda, sdb, vda, vdb, xvda, xvdb, nvme0n1, etc.
  const validDevices = [];
  
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 14) continue;
    const name = parts[2];
    
    // Skip irrelevant device types
    if (
      name.startsWith("loop") ||
      name.startsWith("ram") ||
      name.startsWith("sr") ||
      name.startsWith("dm-") ||
      name.startsWith("zram")
    ) {
      continue;
    }
    
    // Skip partitions (ends with numbers like sda1, vda1, nvme0n1p1)
    if (/\d+$/.test(name)) {
      continue;
    }
    
    const readSectors = parseInt(parts[5], 10);
    const writeSectors = parseInt(parts[9], 10);
    if (Number.isNaN(readSectors) || Number.isNaN(writeSectors)) continue;
    
    validDevices.push({ name, readSectors, writeSectors });
  }
  
  // Prioritize main disks: prefer sda, vda, xvda, nvme over others
  const priorities = ['sda', 'vda', 'xvda', 'nvme0n1'];
  for (const priority of priorities) {
    const disk = validDevices.find(d => d.name === priority);
    if (disk) return disk;
  }
  
  // Return first valid disk if no priority match
  return validDevices.length > 0 ? validDevices[0] : null;
}

function readDiskStats() {
  const content = safeReadFile("/proc/diskstats");
  if (!content) return null;
  const lines = content.split("\n").filter(Boolean);
  return pickPrimaryDisk(lines);
}

async function getDiskIO() {
  const first = readDiskStats();
  if (!first) {
    // If /proc/diskstats not available, return neutral value instead of null
    return {
      device: "N/A",
      readKBps: 0,
      writeKBps: 0,
    };
  }
  
  await sleep(200);
  const second = readDiskStats();
  
  if (!second) {
    return {
      device: first.name,
      readKBps: 0,
      writeKBps: 0,
    };
  }
  
  // If device name changed, try again with first device
  if (second.name !== first.name) {
    return {
      device: second.name,
      readKBps: 0,
      writeKBps: 0,
    };
  }

  const sectorSize = 512; // bytes
  const deltaRead = Math.max(0, second.readSectors - first.readSectors);
  const deltaWrite = Math.max(0, second.writeSectors - first.writeSectors);
  const intervalSec = 0.2;
  const readKBps = (deltaRead * sectorSize) / 1024 / intervalSec;
  const writeKBps = (deltaWrite * sectorSize) / 1024 / intervalSec;
  
  return {
    device: second.name,
    readKBps: Math.max(0, readKBps),
    writeKBps: Math.max(0, writeKBps),
  };
}

// Windows-specific metrics functions
function getWindowsCpuUsage() {
  return new Promise((resolve) => {
    const cmd = `powershell -Command "Get-WmiObject Win32_PerfFormattedData_PerfOS_Processor -Filter 'Name=\"_Total\"' | Select-Object -ExpandProperty PercentProcessorTime"`;
    
    exec(cmd, { maxBuffer: 1024 * 1024, shell: "powershell.exe" }, (error, stdout) => {
      if (error || !stdout) {
        resolve({ usage: 0 });
        return;
      }
      
      try {
        const usage = Math.max(0, Math.min(100, parseInt(stdout.trim(), 10)));
        resolve({ usage });
      } catch (e) {
        resolve({ usage: 0 });
      }
    });
  });
}

function getWindowsMemoryInfo() {
  return new Promise((resolve) => {
    const cmd = `powershell -Command "Get-WmiObject Win32_OperatingSystem | Select-Object TotalVisibleMemorySize, FreePhysicalMemory | ConvertTo-Json"`;
    
    exec(cmd, { maxBuffer: 1024 * 1024, shell: "powershell.exe" }, (error, stdout) => {
      if (error || !stdout) {
        resolve(null);
        return;
      }
      
      try {
        const data = JSON.parse(stdout);
        const total = (data.TotalVisibleMemorySize || 0) * 1024; // Convert KB to bytes
        const free = (data.FreePhysicalMemory || 0) * 1024; // Convert KB to bytes
        const used = total - free;
        const usedPct = total ? (used / total) * 100 : 0;
        
        // Windows doesn't have traditional swap, but uses virtual memory
        resolve({
          memory: {
            total,
            used,
            free,
            usedPct: Math.max(0, Math.min(100, usedPct)),
          },
          swap: {
            total: 0,
            used: 0,
            free: 0,
            usedPct: 0,
          },
        });
      } catch (e) {
        resolve(null);
      }
    });
  });
}

function getWindowsDiskIO() {
  return new Promise((resolve) => {
    const cmd = `powershell -Command "Get-WmiObject Win32_PerfFormattedData_PerfDisk_LogicalDisk -Filter 'Name=\"C:\"' | Select-Object DiskReadBytesPerSec, DiskWriteBytesPerSec | ConvertTo-Json"`;
    
    exec(cmd, { maxBuffer: 1024 * 1024, shell: "powershell.exe" }, (error, stdout) => {
      if (error || !stdout) {
        resolve({
          device: "C:",
          readKBps: 0,
          writeKBps: 0,
        });
        return;
      }
      
      try {
        const data = JSON.parse(stdout);
        const readBytes = parseInt(data.DiskReadBytesPerSec || "0", 10);
        const writeBytes = parseInt(data.DiskWriteBytesPerSec || "0", 10);
        
        resolve({
          device: "C:",
          readKBps: readBytes / 1024,
          writeKBps: writeBytes / 1024,
        });
      } catch (e) {
        resolve({
          device: "C:",
          readKBps: 0,
          writeKBps: 0,
        });
      }
    });
  });
}

// OS-agnostic metrics wrapper functions
async function getSystemMetrics() {
  const os = require("os");
  const isWindows = os.platform() === "win32";
  
  let cpu, memSwap, disk;
  
  if (isWindows) {
    // Get Windows metrics
    cpu = await getWindowsCpuUsage();
    memSwap = await getWindowsMemoryInfo();
    disk = await getWindowsDiskIO();
  } else {
    // Get Linux metrics
    cpu = await getCpuUsage();
    memSwap = getMemoryInfo();
    disk = await getDiskIO();
  }
  
  return { cpu, memSwap, disk };
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

// Dashboard page (agents/services view)
app.get("/dashboard", (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.redirect("/login");
  }
  res.sendFile(require("path").join(__dirname, "public", "dashboard.html"));
});

// Apps page (App ID registration)
app.get("/apps", (req, res) => {
  if (!req.session || !req.session.userId) {
    return res.redirect("/login");
  }
  res.sendFile(require("path").join(__dirname, "public", "apps.html"));
});

// static assets (logo, etc.)
app.use(
  "/assets",
  express.static(require("path").join(__dirname, "public", "assets"))
);

// Get server information (hostname, IP, OS)
app.get("/api/server-info", requireAuth, (req, res) => {
  try {
    const os = require("os");
    const hostname = os.hostname();
    const networkInterfaces = os.networkInterfaces();
    
    // Get primary IP address (preferring non-localhost, non-loopback)
    let ipAddress = "127.0.0.1";
    for (const [ifname, addrs] of Object.entries(networkInterfaces)) {
      for (const addr of addrs) {
        // Prefer IPv4 and skip loopback
        if (addr.family === "IPv4" && !addr.address.startsWith("127.")) {
          ipAddress = addr.address;
          break;
        }
      }
      if (ipAddress !== "127.0.0.1") break;
    }
    
    // Get OS information
    const platform = os.platform();
    let osName = "Unknown";
    let osVersion = os.release();
    
    if (platform === "linux") {
      osName = "Linux";
    } else if (platform === "darwin") {
      osName = "macOS";
    } else if (platform === "win32") {
      osName = "Windows";
    }
    
    // Try to read more detailed OS info from /etc/os-release on Linux
    let osDetail = osName;
    if (platform === "linux") {
      try {
        const osReleaseContent = fs.readFileSync("/etc/os-release", "utf8");
        const lines = osReleaseContent.split("\n");
        const idLine = lines.find(l => l.startsWith("ID="));
        const versionLine = lines.find(l => l.startsWith("VERSION_ID="));
        const prettyNameLine = lines.find(l => l.startsWith("PRETTY_NAME="));
        
        if (prettyNameLine) {
          osDetail = prettyNameLine.split("=")[1].replace(/"/g, "");
        } else if (idLine && versionLine) {
          const id = idLine.split("=")[1].toUpperCase();
          const version = versionLine.split("=")[1].replace(/"/g, "");
          osDetail = `${id} ${version}`;
        }
      } catch (e) {
        // Fallback to default
      }
    }
    
    res.json({
      success: true,
      hostname,
      ipAddress,
      osName,
      osVersion: osDetail,
      isWindows: IS_WINDOWS,
    });
  } catch (err) {
    console.error("Error getting server info:", err);
    res.status(500).json({
      success: false,
      error: "Could not get server information",
      details: String(err),
    });
  }
});

// System metrics: CPU / memory / swap / disk IO
app.get("/api/metrics", requireAuth, async (req, res) => {
  try {
    const { cpu, memSwap, disk } = await getSystemMetrics();

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

// -------- Agent API (from WinAppApi) ----------------------------

// Agent registration via X-APP-ID header
app.post("/api/auth/register", async (req, res) => {
  try {
    const appId = req.headers["x-app-id"];
    const { hostname, os } = req.body || {};

    if (!appId) {
      return res.status(400).json({ status: "error", error: "X-APP-ID header required" });
    }

    const [rows] = await pool.execute("SELECT * FROM agents WHERE app_id = ? LIMIT 1", [appId]);

    if (rows.length === 0) {
      return res.status(403).json({
        status: "error",
        registered: false,
        error: "Unknown AppID. Please pre-register this agent (App ID) on the server.",
      });
    }

    await pool.execute(
      "UPDATE agents SET last_seen = NOW(), hostname = ?, os = ? WHERE app_id = ?",
      [hostname || null, os || null, appId]
    );

    return res.json({ status: "ok", registered: true });
  } catch (err) {
    console.error("auth/register error:", err);
    return res.status(500).json({ status: "error", error: "register failed", details: String(err) });
  }
});

// Agent status update
app.post("/api/status/update", verifyAgent, async (req, res) => {
  try {
    const agent = req.agent;
    const { cpu, ram, uptime, timestamp, hostname, os } = req.body || {};

    await pool.execute(
      "INSERT INTO agent_status (agent_id, cpu, ram, uptime, timestamp) VALUES (?, ?, ?, ?, ?)",
      [agent.id, cpu, ram, uptime, timestamp]
    );

    await pool.execute(
      "UPDATE agents SET last_seen = NOW(), hostname = COALESCE(?, hostname), os = COALESCE(?, os) WHERE id = ?",
      [hostname || null, os || null, agent.id]
    );

    const [rows] = await pool.execute("SELECT last_seen FROM agents WHERE id = ?", [agent.id]);
    const lastSeen = rows.length > 0 ? rows[0].last_seen : null;

    const [cmdRows] = await pool.execute(
      "SELECT id, service_name, command_type FROM agent_service_commands WHERE agent_id = ? AND status = 'pending'",
      [agent.id]
    );

    const commands = cmdRows.map((c) => ({
      id: c.id,
      type: c.command_type,
      service_name: c.service_name,
    }));

    res.json({ status: "ok", updated: true, last_seen: lastSeen, commands });
  } catch (err) {
    console.error("status/update error:", err);
    res.status(500).json({ status: "error", error: "status update failed", details: String(err) });
  }
});

// Agent services snapshot
app.post("/api/status/services", verifyAgent, async (req, res) => {
  try {
    const agent = req.agent;
    const { services, timestamp } = req.body || {};

    if (!Array.isArray(services)) {
      return res.status(400).json({ status: "error", error: "services array required" });
    }

    for (const svc of services) {
      const name = svc.name || svc.service_name;
      if (!name) continue;

      const displayName = svc.display_name || svc.displayName || null;
      const status = svc.status || null;

      await pool.execute(
        `INSERT INTO agent_services (agent_id, service_name, display_name, status, last_updated)
         VALUES (?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE display_name = VALUES(display_name),
                                 status = VALUES(status),
                                 last_updated = VALUES(last_updated)`,
        [agent.id, name, displayName, status]
      );
    }

    res.json({
      status: "ok",
      updated: true,
      count: services.length,
      timestamp: timestamp || null,
    });
  } catch (err) {
    console.error("status/services error:", err);
    res.status(500).json({ status: "error", error: "services update failed", details: String(err) });
  }
});

// Agent reports command execution result
app.post("/api/status/service-command-result", verifyAgent, async (req, res) => {
  try {
    const agent = req.agent;
    const { id, success, error } = req.body || {};

    if (!id) {
      return res.status(400).json({ status: "error", error: "id required" });
    }

    await pool.execute(
      `UPDATE agent_service_commands
       SET status = ?, error_message = ?, executed_at = NOW()
       WHERE id = ? AND agent_id = ?`,
      [success ? "done" : "failed", error || null, id, agent.id]
    );

    res.json({ status: "ok" });
  } catch (err) {
    console.error("service-command-result error:", err);
    res.status(500).json({ status: "error", error: "command result update failed", details: String(err) });
  }
});

// Queue a service restart command for an agent (web, authenticated)
app.post("/api/agent-services/:agentId/:serviceName/restart", requireAuth, async (req, res) => {
  try {
    const { agentId, serviceName } = req.params;
    const userId = req.session.userId;

    if (!agentId || !serviceName) {
      return res.status(400).json({ success: false, error: "agentId and serviceName required" });
    }

    const [rows] = await pool.execute(
      "SELECT id FROM agents WHERE id = ? AND (user_id = ? OR user_id IS NULL) LIMIT 1",
      [agentId, userId]
    );

    if (rows.length === 0) {
      return res.status(403).json({ success: false, error: "No permission for this agent" });
    }

    await pool.execute(
      `INSERT INTO agent_service_commands (agent_id, service_name, command_type, status)
       VALUES (?, ?, 'restart', 'pending')`,
      [agentId, serviceName]
    );

    res.json({ success: true, message: "Restart command queued" });
  } catch (err) {
    console.error("queue restart error:", err);
    res.status(500).json({ success: false, error: "Could not queue restart", details: String(err) });
  }
});

// Agent/app management (web)
app.get("/api/agents", requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const [rows] = await pool.execute(
      "SELECT id, app_id, hostname, os, last_seen, created_at FROM agents WHERE user_id = ? ORDER BY last_seen DESC, id ASC",
      [userId]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("api/agents error:", err);
    res.status(500).json({ success: false, error: "Could not list agents" });
  }
});

app.post("/api/apps", requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { app_id } = req.body || {};
    if (!app_id || typeof app_id !== "string") {
      return res.status(400).json({ success: false, error: "app_id required" });
    }

    const [existing] = await pool.execute("SELECT id FROM agents WHERE app_id = ? LIMIT 1", [app_id]);
    if (existing.length > 0) {
      await pool.execute("UPDATE agents SET user_id = ? WHERE app_id = ?", [userId, app_id]);
    } else {
      await pool.execute("INSERT INTO agents (user_id, app_id) VALUES (?, ?)", [userId, app_id]);
    }

    res.json({ success: true, message: "App ID registered to your account" });
  } catch (err) {
    console.error("api/apps error:", err);
    res.status(500).json({ success: false, error: "Could not register app id" });
  }
});

app.get("/api/agent-status", requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const [rows] = await pool.execute(
      `SELECT s.id, s.agent_id, s.cpu, s.ram, s.uptime, s.timestamp,
              a.app_id, a.hostname
       FROM agent_status s
       JOIN agents a ON a.id = s.agent_id
       WHERE a.user_id = ?
       ORDER BY s.timestamp DESC, s.id DESC
       LIMIT 50`,
      [userId]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("api/agent-status error:", err);
    res.status(500).json({ success: false, error: "Could not list status" });
  }
});

app.get("/api/agent-services", requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const [rows] = await pool.execute(
      `SELECT sv.agent_id, sv.service_name, sv.display_name, sv.status, sv.last_updated,
              a.app_id, a.hostname
       FROM agent_services sv
       JOIN agents a ON a.id = sv.agent_id
       WHERE a.user_id = ?
       ORDER BY a.hostname, sv.service_name`,
      [userId]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("api/agent-services error:", err);
    res.status(500).json({ success: false, error: "Could not list services" });
  }
});

app.listen(PORT, () => {
  console.log(
    `Linux Service Dashboard is running on http://localhost:${PORT}`
  );
});
