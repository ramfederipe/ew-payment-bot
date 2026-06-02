require("dotenv").config();
const express = require("express");
const path = require("path");
const session = require("express-session");
const { requireAuth, requirePermission, requireAnyPermission } = require("./middleware/auth");
const bcrypt = require("bcrypt");
const { decryptAES, generateMark } = require("./crypto");
const { sendTelegram, sendVideoTelegram, sendWalletHealthTelegram, deleteTelegramMessage, bot } = require("./bot");
const db = require("./db");
const now = new Date().toISOString();
const { updateStatusByRef } = require("./gsheet");
const {
  DEFAULT_SYNC_COLUMN_MAP,
  DEFAULT_UPDATE_COLUMN_MAP,
  parseColumnMap
} = require("./sheetColumns");
const activeRefs = {}; 

const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const zlib = require("zlib");
const { google } = require("googleapis");

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },

  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);

    cb(
      null,
      Date.now() + ext
    );
  }
});

const upload = multer({ storage });

const app = express();
app.use(express.json());

const { syncSheets } = require("./sync");
const { getIO } = require("./socket");
let isSyncing = false;
let chatIdPaused = false;

const googleSheetsAuth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, "credentials", "credentials.json"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
});

function requireDynamicPermission(resolvePermission) {
  return (req, res, next) => {
    const permission = resolvePermission(req);
    return requirePermission(permission)(req, res, next);
  };
}

function parseMoney(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const cleaned = String(value || "")
    .replace(/,/g, "")
    .replace(/[^\d.-]/g, "")
    .trim();
  const amount = Number(cleaned);
  return Number.isFinite(amount) ? amount : 0;
}

function normalizeMatchValue(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
}

function extractSpreadsheetId(value) {
  const match = String(value || "").match(/\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : String(value || "").trim();
}

function normalizeSheetKey(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
}

function normalizeSheetHeader(value) {
  return normalizeSheetKey(value).replace(/[^A-Z0-9]/g, "");
}

function parseSheetDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(Math.round((value - 25569) * 86400 * 1000));
  }

  const raw = String(value || "").trim();
  if (!raw) return null;

  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));

  const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slash) {
    const year = Number(slash[3].length === 2 ? `20${slash[3]}` : slash[3]);
    return new Date(year, Number(slash[1]) - 1, Number(slash[2]));
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function sheetDateKey(value) {
  const date = parseSheetDate(value);
  if (!date) return "";

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayDateKey() {
  const now = new Date();
  return sheetDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
}

const requireTransactionUpdatePermission = requireDynamicPermission((req) => {
  if (req.body?.status === "APPROVED") return "approve_transactions";
  if (req.body?.status === "REJECTED") return "reject_transactions";
  return "edit_transaction";
});

const requireVideoUpdatePermission = requireDynamicPermission((req) => {
  if (req.body?.status === "RECEIVED") return "approve_transactions";
  if (req.body?.status === "NOT RECEIVED" || req.body?.status === "REJECTED") {
    return "reject_transactions";
  }
  return "edit_transaction";
});


let appSettings = {};

function loadSettings() {
  db.get(`SELECT * FROM settings WHERE id = 1`, (err, row) => {
    if (row) {
      appSettings = row;
      console.log("⚙️ Settings loaded");
    }
  });
}

function maskSecret(value) {
  const secret = String(value || "");
  if (!secret) return "";
  if (secret.length <= 10) return "********";
  return `${secret.slice(0, 6)}********${secret.slice(-4)}`;
}

function isMaskedSecret(value) {
  return String(value || "").includes("********");
}

const DEFAULT_MANUAL_REPLY_PARSER = {
  shopLabels: ["Shop Name", "Agent", "Agent Name"],
  agentNumberLabels: ["Agent Number", "Wallet Number", "Agent No"],
  amountLabels: ["Amount"],
  referenceLabels: ["Reference", "Ref"],
  statusLabels: ["Status"],
  receivedKeywords: ["YES", "Y", "RECEIVED"],
  notReceivedKeywords: ["NO", "N", "NOT RECEIVED"]
};

const DEFAULT_BALANCE_CALCULATION_SETTINGS = {
  defaultDailyLimit: 50000,
  highBalanceAllowance: 0,
  settlementAllowance: 50000,
  lowBalanceThreshold: 1000
};

const DEFAULT_WALLET_TYPES = ["bKash", "Nagad", "Rocket", "Upay"];

function normalizeWalletTypeKey(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
}

function normalizeWalletTypes(value) {
  let list = value;

  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      list = Array.isArray(parsed) ? parsed : value;
    } catch (err) {
      list = value;
    }
  }

  if (typeof list === "string") {
    list = list.split(/[\n,]+/);
  }

  if (!Array.isArray(list)) list = [];

  const normalized = [];
  const seen = new Set();

  [...list, ...DEFAULT_WALLET_TYPES].forEach(item => {
    const name = String(item || "").trim().replace(/\s+/g, " ");
    const key = normalizeWalletTypeKey(name);
    if (!name || seen.has(key)) return;
    seen.add(key);
    normalized.push(name);
  });

  return normalized;
}

function buildWalletTypeDisplayMap(value) {
  const map = new Map();
  normalizeWalletTypes(value).forEach(type => {
    map.set(normalizeWalletTypeKey(type), type);
  });
  return map;
}

function normalizeBalanceCalculationSettings(value) {
  let settings = value;

  if (typeof value === "string" && value.trim()) {
    try {
      settings = JSON.parse(value);
    } catch (err) {
      settings = {};
    }
  }

  if (!settings || typeof settings !== "object") settings = {};

  const normalizeNumber = (key) => {
    const number = Number(settings[key]);
    return Number.isFinite(number) && number >= 0
      ? number
      : DEFAULT_BALANCE_CALCULATION_SETTINGS[key];
  };

  return {
    defaultDailyLimit: normalizeNumber("defaultDailyLimit"),
    highBalanceAllowance: normalizeNumber("highBalanceAllowance"),
    settlementAllowance: normalizeNumber("settlementAllowance"),
    lowBalanceThreshold: normalizeNumber("lowBalanceThreshold")
  };
}

function normalizeManualReplyParser(value) {
  let parser = value;

  if (typeof value === "string" && value.trim()) {
    try {
      parser = JSON.parse(value);
    } catch (err) {
      parser = {};
    }
  }

  if (!parser || typeof parser !== "object") parser = {};

  const normalizeList = (key) => {
    const source = Array.isArray(parser[key])
      ? parser[key]
      : String(parser[key] || "").split(",");
    const values = source.map(item => String(item || "").trim()).filter(Boolean);
    return values.length ? values : DEFAULT_MANUAL_REPLY_PARSER[key];
  };

  return {
    shopLabels: normalizeList("shopLabels"),
    agentNumberLabels: normalizeList("agentNumberLabels"),
    amountLabels: normalizeList("amountLabels"),
    referenceLabels: normalizeList("referenceLabels"),
    statusLabels: normalizeList("statusLabels"),
    receivedKeywords: normalizeList("receivedKeywords"),
    notReceivedKeywords: normalizeList("notReceivedKeywords")
  };
}

app.use(session({
  secret: process.env.SESSION_SECRET || "super-secret-key",
  resave: false,
  saveUninitialized: false
}));

app.use(updateLastActive);
app.use(checkAccountStatus);


// 🌐 Serve dashboard
app.use(express.static(path.join(__dirname, "public")));

// 📥 WEBHOOK (REAL PAYMENT)
app.post("/webhook", async (req, res) => {
  try {
    const { data } = req.body;

    const decrypted = decryptAES(data, process.env.SECURITY_KEY);
    const parsed = JSON.parse(decrypted);
    const payment = parsed.data;

    const mark = generateMark(payment, process.env.RESPONSE_PASS);
    if (mark !== payment.mark) {
      return res.status(400).json({ success: false });
    }

    const ref = payment.transactionReference;
    const amount = Number(payment.amount) || 0;
    const groupName = payment.agentName || payment.agent || "";

    db.get(
      `SELECT id, amount FROM transactions WHERE transactionReference = ?`,
      [ref],
      (err, existing) => {

        if (existing) {
          if (Number(existing.amount) !== amount) {
            db.run(`UPDATE transactions SET amount = ? WHERE transactionReference = ?`, [amount, ref]);
          }

          sendToTelegram(groupName, payment, amount, existing.id);
          return res.json({ success: true });
        }

        db.run(`
          INSERT INTO transactions 
          (transactionReference, amount, status, brand, agentName, customerNumber, imageLink)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
          ref,
          amount,
          "PENDING",
          "API",
          groupName,
          payment.customerNumber || "",
          payment.image || ""
        ], function (err) {

          if (err) return res.status(500).json({ success: false });

          const id = this.lastID;

          sendToTelegram(groupName, payment, amount, id);

          res.json({ success: true });
        });

      }
    );

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false });
  }
});

function sendToTelegram(groupName, payment, amount, id) {
  getChat(groupName).then(async (chatId) => {
    try {
      const result = await sendTelegram({
        chatId,
        id,
        transactionReference: payment.transactionReference,
        amount,
        agentName: groupName,
        customerNumber: payment.customerNumber || "",
        imageLink: payment.image || ""
      });

      if (!result) {
        addLog("ERROR", `Telegram send failed (ID ${id})`);
      }

    } catch (err) {
      const msg = err.message || "Unknown error";

      // 🔥 ADD HERE TOO
      if (msg.includes("upgraded to a supergroup")) {
        addLog("WARN", `Outdated chatId detected (Webhook ID ${id}, Group ${groupName})`);
      }

      addLog("ERROR", `Telegram error (Webhook ID ${id}): ${msg}`);
    }
  });
}

app.post("/api/resend-telegram", requirePermission("send_telegram"), (req, res) => {
  const { id, messageOptions } = req.body || {};

  if (activeRefs[id]) {
    return res.json({ success: false, message: "Already sending" });
  }

  activeRefs[id] = true;

  db.get(`SELECT * FROM transactions WHERE id = ?`, [id], (err, row) => {
    if (err || !row) {
      delete activeRefs[id];
      return res.status(404).json({ success: false });
    }

    const previousTelegramMessage = {
      chatId: row.chatId,
      messageId: row.telegramMessageId
    };

    processSend(row, null, messageOptions).then(async (result) => {
      if (!result.success) {
        return res.json(result);
      }

      let deletedPreviousMessage = false;

      if (
        previousTelegramMessage.chatId &&
        previousTelegramMessage.messageId &&
        (
          String(previousTelegramMessage.chatId) !== String(result.chatId) ||
          String(previousTelegramMessage.messageId) !== String(result.messageId)
        )
      ) {
        deletedPreviousMessage = await deleteTelegramMessage(
          previousTelegramMessage.chatId,
          previousTelegramMessage.messageId
        );
      }

      db.run(`
        UPDATE transactions
        SET
          sent = 1,
          agentStatus = ?,
          followUpCount = ?,
          reason = NULL,
          confirmedBy = NULL,
          confirmedAt = NULL
        WHERE id = ?
      `, [result.agentStatus || "1st FF", result.followUpCount || 1, id]);
      res.json({
        success: true,
        status: result.agentStatus || "1st FF",
        reason: null,
        confirmedBy: null,
        confirmedAt: null,
        deletedPreviousMessage
      });
    }).catch((err) => {
      console.error("RESEND ERROR:", err.message);
      res.status(500).json({ success: false });
    }).finally(() => {
      setTimeout(() => delete activeRefs[id], 5000);
    });
  });
});

// 🧪 TEST ROUTE
app.get("/test", requirePermission("send_telegram"), async (req, res) => {
  const ref = "TEST123";
  const amount = 100;
  const groupName = "ESS-PS1-BORO001-BKASH";

  db.run(`
    INSERT OR IGNORE INTO transactions 
    (transactionReference, amount, status, brand, agentName, customerNumber, imageLink)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [
    ref,
    amount,
    "PENDING",
    "TEST",
    groupName,
    "01700000000",
    "https://example.com/test.jpg"
  ], function (err) {

    if (err) {
      console.error(err);
      return res.status(500).send("Error");
    }

    let id = this.lastID;

    // 🔥 IMPORTANT: if already exists, fetch id
    if (!id) {
      db.get(`SELECT id FROM transactions WHERE transactionReference = ?`, [ref], (err, row) => {
        if (!row) return res.send("❌ No ID found");

        sendTestTelegram(row.id);
      });
    } else {
      sendTestTelegram(id);
    }

    function sendTestTelegram(id) {
      getChat(groupName, async (chatId) => {
        console.log("🚀 TEST SEND ID:", id);

        await sendTelegram({
          chatId,
          id, // 🔥 THIS FIXES EVERYTHING
          transactionReference: ref,
          amount: amount,
          agentName: groupName,
          customerNumber: "01700000000",
          imageLink: "https://example.com/test.jpg"
        });

        res.send("✅ Test sent to Telegram");
      });
    }

  });
});

// 📊 API (for dashboard)
app.get("/api/transactions", requirePermission("view_page_pending_deposits"), (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;

  const brand = String(req.query.brand || "").trim();
  const essStatus = req.query.essStatus;
  const search = req.query.search;
  const status = req.query.status;
  const agentPrefix = req.query.agentPrefix;
  const sent = req.query.sent;
  const smsMatched = req.query.smsMatched;

  let where = `WHERE (actionStatus IS NULL OR actionStatus = 'PENDING')`;
  const params = [];

  if (brand) {
    where += ` AND LOWER(TRIM(brand)) = LOWER(TRIM(?))`;
    params.push(brand);
  }

  if (essStatus) {
    where += ` AND essStatus = ?`;
    params.push(essStatus);
  }

  if (search) {
    where += `
      AND (
        transactionReference LIKE ?
        OR depositId LIKE ?
        OR agentName LIKE ?
      )
    `;
    const like = `%${search}%`;
    params.push(like, like, like);
  }

  if (agentPrefix) {
  where += ` AND agentName LIKE ?`;
  params.push(`${agentPrefix}%`);
  }

  if (status) {
  where += ` AND agentStatus = ?`;
  params.push(status);
}

  if (sent !== undefined && sent !== "") {
  where += ` AND sent = ?`;
  params.push(Number(sent));
}

  if (smsMatched === "1") {
  where += " AND smsMatched = 1";
}

  if (smsMatched === "0") {
  where += " AND (smsMatched = 0 OR smsMatched IS NULL)";
}

  db.get(`
    SELECT COUNT(*) as total 
    FROM transactions
    ${where}
  `, params, (err, countRow) => {
    if (err) {
      console.error("Transactions count error:", err);
      return res.status(500).json({ success: false, error: "Failed to load transactions" });
    }

    db.all(`
      SELECT * FROM transactions
      ${where}
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset], (err, rows) => {
      if (err) {
        console.error("Transactions list error:", err);
        return res.status(500).json({ success: false, error: "Failed to load transactions" });
      }

      res.json({
        data: rows,
        total: countRow.total,
        totalPages: Math.ceil(countRow.total / limit)
      });

    });
  });
});

// 🔄 Sync
app.post("/api/sync", requirePermission("sync_sheets"), async (req, res) => {
  const { mode = "all" } = req.body;
  const user = req.session.user;

  // Full sync stays developer-only because it touches every sheet.
  if (user.role !== "developer" && mode === "all") {
    return res.status(403).json({
      success: false,
      error: "Only developer can run full sync"
    });
  }

  if (isSyncing) {
    return res.json({ success: false, message: "Already syncing" });
  }

  const io = getIO();
  isSyncing = true;

  io.emit("sync-status", { syncing: true });

  // 🔔 🔥 SYNC START NOTIFICATION
  createNotification({
    type: "SYNC",
    title: "Sync Started",
    message: `${user.username} started Sync (${mode})`,
    target: "ALL"
  });

  try {
    addLog("INFO", `Sync started (${mode}) by ${user.username} (${user.role})`);
    console.log(`🔄 Sync started by ${user.username} (${user.role})`);

    const result = await syncSheets(mode);
    if (result?.errors?.length && !result.inserted) {
      throw new Error(result.errors.slice(0, 3).join("; "));
    }
    // 👆 OPTIONAL: return stats from sync

    console.log("✅ Sync finished");
    addLog("INFO", `Sync completed (${mode}) by ${user.username}`);

    // 🔔 🔥 SYNC FINISH NOTIFICATION
    createNotification({
      type: "SYNC",
      title: "Sync Completed",
      message: `${user.username} finished Sync (${mode})`,
      meta: result || {}, // 👈 include stats if available
      target: "ALL"
    });

    res.json({ success: true, result });

  } catch (err) {
    console.error("❌ Sync error:", err);
    addLog("ERROR", `Sync failed: ${err.message}`);

    // 🔔 🔥 SYNC ERROR NOTIFICATION
    createNotification({
      type: "SYNC",
      title: "Sync Failed",
      message: `${user.username} failed Sync (${mode})`,
      meta: { error: err.message },
      target: "ALL"
    });

    res.status(500).json({
      success: false,
      error: err.message
    });

  } finally {
    isSyncing = false;
    io.emit("sync-status", { syncing: false });
  }
});

app.get("/api/brands", requirePermission("view_page_pending_deposits"), (req, res) => {
  db.all(`
    SELECT TRIM(brand) as brand
    FROM transactions
    WHERE (actionStatus IS NULL OR actionStatus = 'PENDING')
      AND brand IS NOT NULL
      AND TRIM(brand) != ''
    GROUP BY LOWER(TRIM(brand))
    ORDER BY brand COLLATE NOCASE ASC
  `, (err, rows) => {
    if (err) {
      console.error("Brands load error:", err);
      return res.json([]);
    }

    res.json(rows.map(r => r.brand));
  });
});

// 🚀 START SERVER (ONLY ONCE!)
const http = require("http");
const { init } = require("./socket");

const server = http.createServer(app);

init(server); // ✅ initialize socket

loadSettings();
server.listen(process.env.PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${process.env.PORT}`);
  addLog("INFO", `Server started on port ${process.env.PORT}`);
});

app.post("/api/update", requireTransactionUpdatePermission, async (req, res) => {
  const { ref, status, reason, username } = req.body;

  const user = username || req.session.user.username;

  if (!ref || !status) {
    return res.status(400).json({
      success: false,
      message: "Missing ref or status"
    });
  }

  try {
    let query = "";
    let params = [];

    // ✅ AGENT ANSWER
    if (status === "RECEIVED" || status === "NOT RECEIVED") {
      query = `
        UPDATE transactions
        SET agentStatus = ?
        WHERE transactionReference = ?
      `;
      params = [status, ref];
    }

    // ✅ APPROVED
    else if (status === "APPROVED") {
      query = `
        UPDATE transactions
        SET 
          actionStatus = 'APPROVED',
          reason = ?,
          settledBy = ?,
          settledAt = datetime('now', '+8 hours')
        WHERE transactionReference = ?
      `;
      params = [reason || "", user, ref];
    }

    // ❌ REJECTED
    else if (status === "REJECTED") {
      query = `
        UPDATE transactions
        SET 
          actionStatus = 'REJECTED',
          reason = ?,
          settledBy = ?,
          settledAt = datetime('now', '+8 hours')
        WHERE transactionReference = ?
      `;
      params = [reason || "", user, ref];
    }

    // 🔥 EXECUTE
    const result = await new Promise((resolve, reject) => {
      db.run(query, params, function(err) {
        if (err) reject(err);
        else resolve(this);
      });
    });

    if (!result || result.changes === 0) {
      addLog("WARN", `Transaction update skipped; ref not found (${ref}, status ${status})`, user);
      return res.status(400).json({
        success: false,
        message: "No rows updated (ref not found)"
      });
    }

    // 🔥 GET INFO (NO BRAND NEEDED)
    db.get(`
      SELECT depositId, amount, agentName 
      FROM transactions 
      WHERE transactionReference = ?
    `, [ref], (err, row) => {

      if (!row) return;

      if (status === "APPROVED" || status === "REJECTED") {
        createNotification({
          type: "SETTLED",
          title: status === "APPROVED"
            ? "Deposit Approved"
            : "Deposit Rejected",

          message: `${user} ${status.toLowerCase()} ${row.depositId} (${row.amount}) • ${row.agentName}`,

          meta: {
            depositIds: [row.depositId],
            status
          },

          target: "ALL"
        });
      }
    });

    if (status === "APPROVED" || status === "REJECTED") {
      addLog("INFO", `Transaction ${status.toLowerCase()} (ref ${ref}, reason: ${reason || "-"})`, user);
    } else if (status === "RECEIVED" || status === "NOT RECEIVED") {
      addLog("INFO", `Agent answer updated to ${status} (ref ${ref})`, user);
    }

    res.json({ success: true });

  } catch (err) {
    console.log("UPDATE ERROR:", err.message);
    addLog("ERROR", `Transaction update failed (ref ${ref}, status ${status}): ${err.message}`, user);

    createNotification({
      type: "SYSTEM",
      title: "Update Failed",
      message: `${user} failed to update ${ref}`,
      meta: { error: err.message },
      target: "ALL"
    });

    res.status(500).json({ success: false });
  }
});

app.post("/api/upload-wallet", requirePermission("manage_wallets"), upload.single("file"), (req, res) => {
  const user = getLogUser(req);

  const results = [];

  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", (data) => results.push(data))
    .on("end", () => {

      const stmt = db.prepare(`
        INSERT INTO wallets (
          walletAccountId, walletId, walletType, ownerName,
          accountType, network, currency, openingBalance, balance, status,
          agentGroup, depositDailyLimit, withdrawalDailyLimit,
          todayDeposits, todayWithdrawals,
          depositPriority, withdrawalPriority,
          remarks, createdAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      results.forEach(row => {

        stmt.run([
          row["Wallet Account ID"] || "",
          row["Wallet ID"] || "",
          row["Wallet Type"] || "",
          row["Owner Name"] || "",
          row["Account Type"] || "",
          row["Network"] || "",
          row["Currency"] || "",
          parseMoney(row["Opening Balance"] || row["Opening"] || row["Balance"] || 0),
          parseMoney(row["Balance"] || row["Opening Balance"] || row["Opening"] || 0),
          row["Status"] || "",
          row["Agent Group"] || "",
          row["Deposit Daily Limit"] || 0,
          row["Withdrawal Daily Limit"] || 0,
          row["Today Deposits"] || 0,
          row["Today Withdrawals"] || 0,
          row["Deposit Priority"] || 0,
          row["Withdrawal Priority"] || 0,
          row["Remarks"] || "",
          row["Created At"] || ""
        ]);

      });

      stmt.finalize((err) => {

        if (err) {
          console.error(err);
          addLog("ERROR", `Wallet upload failed: ${err.message}`, user);

          return res.status(500).json({
            success: false
          });
        }

        fs.unlinkSync(req.file.path);

        console.log("✅ Wallets uploaded:", results.length);
        addLog("INFO", `Wallet upload completed (${results.length} rows)`, user);

        // ✅ FIX
        const io = getIO();

        io.emit("walletUpdated", {
          updatedBy: req.session.user.username,
          total: results.length,
          time: new Date().toLocaleString()
        });

        res.json({
          success: true,
          total: results.length
        });

      });

    });

});

function readZipEntries(filePath) {
  const buffer = fs.readFileSync(filePath);
  const entries = new Map();
  let eocd = -1;

  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }

  if (eocd < 0) throw new Error("Invalid XLSX archive");

  const totalEntries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  for (let i = 0; i < totalEntries; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);

    entries.set(name, method === 8
      ? zlib.inflateRawSync(compressed).toString("utf8")
      : compressed.toString("utf8")
    );

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function getColumnIndex(ref) {
  const letters = String(ref || "").replace(/\d/g, "").toUpperCase();
  let index = 0;

  for (const letter of letters) {
    index = index * 26 + letter.charCodeAt(0) - 64;
  }

  return index - 1;
}

function parseSharedStrings(xml) {
  if (!xml) return [];

  return [...xml.matchAll(/<si[\s\S]*?<\/si>/g)].map(match => {
    const parts = [...match[0].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
      .map(part => decodeXml(part[1]));
    return parts.join("");
  });
}

function parseXlsxFirstSheet(filePath) {
  const entries = readZipEntries(filePath);
  const sheetXml = entries.get("xl/worksheets/sheet1.xml");

  if (!sheetXml) throw new Error("First worksheet not found");

  const sharedStrings = parseSharedStrings(entries.get("xl/sharedStrings.xml"));

  return [...sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map(rowMatch => {
    const row = [];

    [...rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].forEach(cellMatch => {
      const attrs = cellMatch[1];
      const body = cellMatch[2];
      const ref = attrs.match(/\br="([^"]+)"/)?.[1] || "";
      const type = attrs.match(/\bt="([^"]+)"/)?.[1] || "";
      const colIndex = getColumnIndex(ref);
      const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1]
        || body.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1]
        || "";

      row[colIndex] = type === "s"
        ? sharedStrings[Number(raw)] || ""
        : decodeXml(raw);
    });

    return row;
  });
}

function parseDelimitedRows(filePath) {
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function parseSheetRows(filePath, originalName = "") {
  const name = originalName || filePath;
  if (/\.csv$/i.test(name)) return parseDelimitedRows(filePath);
  if (/\.xlsx$/i.test(name)) return parseXlsxFirstSheet(filePath);
  throw new Error("Only .csv or .xlsx files are allowed");
}

function normalizeOpeningBalanceRows(rows, shopColumn, balanceColumn) {
  const normalizedShop = normalizeMatchValue(shopColumn || "SHOP");
  const normalizedBalance = normalizeMatchValue(balanceColumn || "BALANCE");
  const headerIndex = rows.findIndex(row => {
    const cells = row.map(normalizeMatchValue);
    return cells.includes(normalizedShop) && cells.includes(normalizedBalance);
  });

  if (headerIndex < 0) {
    throw new Error(`Could not find headers ${shopColumn || "SHOP"} and ${balanceColumn || "BALANCE"}`);
  }

  const headers = rows[headerIndex].map(normalizeMatchValue);
  const shopIndex = headers.indexOf(normalizedShop);
  const balanceIndex = headers.indexOf(normalizedBalance);

  return rows.slice(headerIndex + 1)
    .map(row => ({
      shop: String(row[shopIndex] || "").trim(),
      balance: parseMoney(row[balanceIndex])
    }))
    .filter(row => row.shop);
}

function findHeaderIndex(rows, requiredHeaders) {
  const normalizedRequired = requiredHeaders.map(normalizeMatchValue);
  return rows.findIndex(row => {
    const cells = row.map(normalizeMatchValue);
    return normalizedRequired.every(header => cells.includes(header));
  });
}

function normalizeDailyActivityRows(rows, direction) {
  const isDeposit = direction === "deposit";
  const ownerHeader = isDeposit ? "Wallet Owner Name" : "Owner Name";
  const requiredHeaders = [ownerHeader, "Wallet Type", "Amount", "Status"];
  const headerIndex = findHeaderIndex(rows, requiredHeaders);

  if (headerIndex < 0) {
    throw new Error(`Could not find headers ${requiredHeaders.join(", ")}`);
  }

  const headers = rows[headerIndex].map(normalizeMatchValue);
  const ownerIndex = headers.indexOf(normalizeMatchValue(ownerHeader));
  const walletTypeIndex = headers.indexOf(normalizeMatchValue("Wallet Type"));
  const amountIndex = headers.indexOf(normalizeMatchValue("Amount"));
  const statusIndex = headers.indexOf(normalizeMatchValue("Status"));
  const totals = new Map();

  rows.slice(headerIndex + 1).forEach(row => {
    const ownerName = String(row[ownerIndex] || "").trim();
    const walletType = String(row[walletTypeIndex] || "").trim();
    const status = String(row[statusIndex] || "").trim();
    const amount = parseMoney(row[amountIndex]);

    if (!ownerName || !walletType || normalizeMatchValue(status) !== "COMPLETED") return;

    const key = `${normalizeMatchValue(ownerName)}|${normalizeMatchValue(walletType)}`;
    const current = totals.get(key) || {
      ownerName,
      normalizedOwnerName: normalizeMatchValue(ownerName),
      walletType,
      normalizedWalletType: normalizeMatchValue(walletType),
      amount: 0,
      status: "Completed"
    };

    current.amount += amount;
    totals.set(key, current);
  });

  return [...totals.values()];
}

function getOpeningBalanceColumns(callback) {
  db.get(`SELECT openingBalanceShopColumn, openingBalanceAmountColumn FROM settings WHERE id = 1`, (err, row) => {
    callback({
      shopColumn: row?.openingBalanceShopColumn || "SHOP",
      balanceColumn: row?.openingBalanceAmountColumn || "BALANCE"
    });
  });
}

app.post("/api/wallet/opening-balance/upload", requirePermission("manage_wallets"), upload.single("file"), (req, res) => {
  const user = getLogUser(req);

  if (!req.file) {
    return res.status(400).json({ success: false, message: "File is required" });
  }

  getOpeningBalanceColumns(({ shopColumn, balanceColumn }) => {
    let rows;

    try {
      rows = normalizeOpeningBalanceRows(
        parseXlsxFirstSheet(req.file.path),
        shopColumn,
        balanceColumn
      );
    } catch (err) {
      fs.unlink(req.file.path, () => {});
      console.error("Opening balance upload failed:", err.message);
      addLog("ERROR", `Opening balance upload failed: ${err.message}`, user);
      return res.status(400).json({ success: false, message: err.message });
    }

    db.serialize(() => {
      db.run(`DELETE FROM opening_balances`, (err) => {
      if (err) {
        fs.unlink(req.file.path, () => {});
        return res.status(500).json({ success: false, message: "Could not clear opening balances" });
      }

      const stmt = db.prepare(`
        INSERT INTO opening_balances (shop, normalizedShop, openingBalance, uploadedAt)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(normalizedShop) DO UPDATE SET
          shop = excluded.shop,
          openingBalance = excluded.openingBalance,
          uploadedAt = excluded.uploadedAt
      `);

      rows.forEach(row => {
        stmt.run(row.shop, normalizeMatchValue(row.shop), row.balance);
      });

      stmt.finalize((err) => {
        fs.unlink(req.file.path, () => {});

        if (err) {
          console.error("Opening balance save failed:", err.message);
          addLog("ERROR", `Opening balance save failed: ${err.message}`, user);
          return res.status(500).json({ success: false, message: "Opening balance save failed" });
        }

        const io = getIO();
        io.emit("walletUpdated", {
          updatedBy: req.session.user.username,
          total: rows.length,
          time: new Date().toLocaleString()
        });

        addLog("INFO", `Opening balance uploaded (${rows.length} shops)`, user);

        res.json({
          success: true,
          total: rows.length,
          updated: rows.length,
          unmatched: 0
        });
      });
    });
    });
  });
});

app.post("/api/wallet/daily-activity/upload/:direction", requirePermission("manage_wallets"), upload.single("file"), (req, res) => {
  const user = getLogUser(req);
  const direction = req.params.direction === "withdrawal" ? "withdrawal" : "deposit";
  const label = direction === "deposit" ? "Deposit" : "Withdrawal";

  if (!req.file) {
    return res.status(400).json({ success: false, message: "File is required" });
  }

  let rows;

  try {
    rows = normalizeDailyActivityRows(
      parseSheetRows(req.file.path, req.file.originalname),
      direction
    );
  } catch (err) {
    fs.unlink(req.file.path, () => {});
    console.error(`${label} upload failed:`, err.message);
    addLog("ERROR", `${label} upload failed: ${err.message}`, user);
    return res.status(400).json({ success: false, message: err.message });
  }

  db.serialize(() => {
    db.run(`DELETE FROM wallet_daily_activity WHERE direction = ?`, [direction], (err) => {
      if (err) {
        fs.unlink(req.file.path, () => {});
        return res.status(500).json({ success: false, message: `Could not clear ${label.toLowerCase()} rows` });
      }

      const stmt = db.prepare(`
        INSERT INTO wallet_daily_activity (
          direction, ownerName, normalizedOwnerName, walletType,
          normalizedWalletType, amount, status, uploadedAt
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `);

      rows.forEach(row => {
        stmt.run(
          direction,
          row.ownerName,
          row.normalizedOwnerName,
          row.walletType,
          row.normalizedWalletType,
          row.amount,
          row.status
        );
      });

      stmt.finalize((err) => {
        fs.unlink(req.file.path, () => {});

        if (err) {
          console.error(`${label} save failed:`, err.message);
          addLog("ERROR", `${label} save failed: ${err.message}`, user);
          return res.status(500).json({ success: false, message: `${label} save failed` });
        }

        getIO().emit("walletUpdated", {
          updatedBy: req.session.user.username,
          total: rows.length,
          time: new Date().toLocaleString()
        });

        addLog("INFO", `${label} daily activity uploaded (${rows.length} owner/type rows)`, user);
        res.json({ success: true, total: rows.length, updated: rows.length });
      });
    });
  });
});

app.delete("/api/wallet/opening-balance/clear", requirePermission("manage_wallets"), (req, res) => {
  const user = getLogUser(req);

  db.run(`DELETE FROM opening_balances`, function(err) {
    if (err) {
      console.error("Opening balance clear failed:", err.message);
      addLog("ERROR", `Opening balance clear failed: ${err.message}`, user);
      return res.status(500).json({ success: false, message: "Opening balance clear failed" });
    }

    getIO().emit("walletUpdated", {
      updatedBy: req.session.user.username,
      total: 0,
      time: new Date().toLocaleString()
    });

    addLog("WARN", `Opening balance cleared (${this.changes} rows)`, user);
    res.json({ success: true, deleted: this.changes });
  });
});

app.delete("/api/wallet/daily-activity/clear", requirePermission("manage_wallets"), (req, res) => {
  const user = getLogUser(req);

  db.run(`DELETE FROM wallet_daily_activity`, function(err) {
    if (err) {
      console.error("DP/WD clear failed:", err.message);
      addLog("ERROR", `DP/WD clear failed: ${err.message}`, user);
      return res.status(500).json({ success: false, message: "DP/WD clear failed" });
    }

    getIO().emit("walletUpdated", {
      updatedBy: req.session.user.username,
      total: 0,
      time: new Date().toLocaleString()
    });

    addLog("WARN", `DP/WD daily activity cleared (${this.changes} rows)`, user);
    res.json({ success: true, deleted: this.changes });
  });
});

app.get("/api/wallets", requirePermission("view_page_wallet"), (req, res) => {
  db.all(`
    SELECT * FROM wallets ORDER BY id DESC
  `, (err, rows) => {
    if (err) return res.status(500).json([]);
    res.json(rows);
  });
});

app.delete("/api/wallet/reset", requirePermission("manage_wallets"), (req, res) => {
  const user = getLogUser(req);
  db.run(`DELETE FROM wallets`, function (err) {
    if (err) {
      console.error("❌ WALLET RESET ERROR:", err);
      addLog("ERROR", `Wallet reset failed: ${err.message}`, user);
      return res.status(500).json({ success: false });
    }

    addLog("WARN", `Wallet data reset (${this.changes} rows deleted)`, user);
    res.json({
      success: true,
      deleted: this.changes
    });
  });
});

app.get("/api/wallet-health", requireAnyPermission([
  "view_page_wallet_health",
  "wallet_health"
]), async (req, res) => {
  let apiBalances = new Map();
  try {
    apiBalances = await getSettlementSheetDeductions();
  } catch (err) {
    console.error("WALLET HEALTH API BALANCE ERROR:", err.message);
    addLog("WARN", `Wallet health API balance skipped: ${err.message}`);
  }

  db.all(`
    SELECT *
    FROM wallet_health
    ORDER BY id DESC
  `, (err, rows) => {
    if (err) {
      console.error("WALLET HEALTH LOAD ERROR:", err);
      return res.status(500).json([]);
    }

    res.json(rows.map(row => {
      const uploadedApiBalance = Number(row.apiBalance || 0);
      const sheetApiBalance = apiBalances.get(`${normalizeSheetKey(row.ownerName)}|${normalizeSheetKey(row.walletType)}`) || 0;

      return {
        ...row,
        apiBalance: uploadedApiBalance || sheetApiBalance
      };
    }));
  });
});

app.post("/api/upload-wallet-health", requireAnyPermission([
  "manage_wallets",
  "wallet_health",
  "view_page_wallet_health"
]), upload.single("file"), (req, res) => {
  const user = getLogUser(req);
  if (!req.file) {
    return res.status(400).json({ success: false, message: "No file uploaded" });
  }

  const results = [];

  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", row => results.push(row))
    .on("end", () => {
      db.serialize(() => {
        db.run(`DELETE FROM wallet_health`, err => {
          if (err) {
            fs.unlinkSync(req.file.path);
            console.error("WALLET HEALTH RESET ERROR:", err);
            addLog("ERROR", `Wallet health upload reset failed: ${err.message}`, user);
            return res.status(500).json({ success: false, message: "Could not reset wallet health data" });
          }

          const stmt = db.prepare(`
            INSERT INTO wallet_health (
              walletAccountId, walletId, walletType, accountType, walletActive,
              personalAccountId, ownerName, teamLeader, agentGroup, appCondition,
              depositStatus, withdrawalStatus, deviceName, deviceId, appVersion,
              smsPermission, notificationListener, appNotifications, fullScreenAlert,
              batteryOptimizationDisabled, lastActive, lastApiSync, apiBalance, apiFailures,
              lastApiFailReason, lastApiFailAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          results.forEach(row => {
            stmt.run([
              row["Wallet Account ID"] || "",
              row["Wallet ID"] || "",
              row["Wallet Type"] || "",
              row["Account Type"] || "",
              row["Wallet Active"] || "",
              row["Personal Account ID"] || "",
              row["Owner"] || "",
              row["Team Leader"] || "",
              row["Agent Group"] || "",
              row["App Condition"] || "",
              row["Deposit Status"] || "",
              row["Withdrawal Status"] || "",
              row["Device Name"] || "",
              row["Device ID"] || "",
              row["App Version"] || "",
              row["SMS Permission"] || "",
              row["Notification Listener"] || "",
              row["App Notifications"] || "",
              row["Full Screen Alert"] || "",
              row["Battery Optimization Disabled"] || "",
              row["Last Active"] || "",
              row["Last API Sync"] || "",
              parseMoney(row["API Balance"]),
              Number(row["API Failures"] || 0),
              row["Last API Fail Reason"] || "",
              row["Last API Fail At"] || ""
            ]);
          });

          stmt.finalize(finalizeErr => {
            fs.unlinkSync(req.file.path);

            if (finalizeErr) {
              console.error("WALLET HEALTH INSERT ERROR:", finalizeErr);
              addLog("ERROR", `Wallet health upload failed: ${finalizeErr.message}`, user);
              return res.status(500).json({ success: false, message: "Upload failed" });
            }

            addLog("INFO", `Wallet health uploaded (${results.length} rows)`, user);
            res.json({ success: true, total: results.length });
          });
        });
      });
    })
    .on("error", err => {
      fs.unlinkSync(req.file.path);
      console.error("WALLET HEALTH CSV ERROR:", err);
      addLog("ERROR", `Wallet health CSV read failed: ${err.message}`, user);
      res.status(500).json({ success: false, message: "Could not read CSV" });
    });
});

app.delete("/api/wallet-health/reset", requireAnyPermission([
  "manage_wallets",
  "wallet_health",
  "view_page_wallet_health"
]), async (req, res) => {
  const user = getLogUser(req);
  db.run(`DELETE FROM wallet_health`, function(err) {
    if (err) {
      console.error("WALLET HEALTH RESET ERROR:", err);
      addLog("ERROR", `Wallet health reset failed: ${err.message}`, user);
      return res.status(500).json({ success: false, message: "Reset failed" });
    }

    addLog("WARN", `Wallet health reset (${this.changes} rows deleted)`, user);
    res.json({ success: true, deleted: this.changes });
  });
});

app.post("/api/wallet-health/send", requirePermission("send_telegram"), async (req, res) => {
  const agentGroup = String(req.body.agentGroup || "").trim();
  const rowIds = Array.isArray(req.body.rowIds)
    ? req.body.rowIds.map(id => Number(id)).filter(Number.isInteger)
    : [];
  const messageType = String(req.body.messageType || "health_report").trim();
  const latestVersion = String(req.body.latestVersion || "").trim();

  if (!agentGroup && rowIds.length === 0) {
    return res.status(400).json({ success: false, message: "Select rows or choose an Agent Group" });
  }

  try {
    let rows;

    if (rowIds.length > 0) {
      const placeholders = rowIds.map(() => "?").join(",");

      rows = await dbAll(`
        SELECT *
        FROM wallet_health
        WHERE id IN (${placeholders})
        ORDER BY agentGroup ASC, walletId ASC
      `, rowIds);
    } else {
      rows = await dbAll(`
        SELECT *
        FROM wallet_health
        WHERE UPPER(TRIM(agentGroup)) = UPPER(TRIM(?))
        ORDER BY walletId ASC
      `, [agentGroup]);
    }

    if (!rows.length) {
      return res.status(404).json({ success: false, message: "No wallet health rows found" });
    }

    const rowsByGroup = rows.reduce((map, row) => {
      const group = String(row.agentGroup || "").trim();
      if (!group) return map;
      if (!map.has(group)) map.set(group, []);
      map.get(group).push(row);
      return map;
    }, new Map());

    let sentGroups = 0;
    let sentRows = 0;
    const missingGroups = [];

    for (const [group, groupRows] of rowsByGroup.entries()) {
      const chatRow = await dbGet(`
        SELECT chatId
        FROM chat_ids
        WHERE UPPER(TRIM(agentName)) = UPPER(TRIM(?))
           OR UPPER(TRIM(groupName)) = UPPER(TRIM(?))
           OR UPPER(TRIM(groupName)) = UPPER(TRIM(?))
        ORDER BY id DESC
        LIMIT 1
      `, [group, group, `ESS-${group}`]);

      if (!chatRow?.chatId) {
        missingGroups.push(group);
        continue;
      }

      await sendWalletHealthTelegram({
        chatId: chatRow.chatId,
        agentGroup: group,
        rows: groupRows,
        messageType,
        latestVersion
      });

      sentGroups += 1;
      sentRows += groupRows.length;
    }

    if (sentRows === 0) {
      return res.status(404).json({
        success: false,
        message: `No Chat ID found for ${missingGroups.join(", ")}`
      });
    }

    res.json({
      success: true,
      total: sentRows,
      groups: sentGroups,
      missingGroups
    });

  } catch (err) {
    console.error("WALLET HEALTH SEND ERROR:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

app.delete("/api/chatids/:id", requirePermission("manage_chat_ids"), (req, res) => {
  const { id } = req.params;
  const user = req.session?.user?.username || "unknown";

  db.get(`SELECT * FROM chat_ids WHERE id = ?`, [id], (err, row) => {

    // ❌ DB ERROR
    if (err) {
      addLog("ERROR", `Delete chatId DB error (ID ${id}): ${err.message}`, user);
      return res.status(500).json({ success: false });
    }

    // ❌ NOT FOUND
    if (!row) {
      addLog("WARN", `Delete chatId failed (not found ID ${id})`, user);
      return res.status(404).json({ success: false });
    }

    // 🗑 DELETE
    db.run(`DELETE FROM chat_ids WHERE id = ?`, [id], function(err) {

      if (err) {
        addLog("ERROR", `Delete chatId failed (ID ${id}): ${err.message}`, user);
        return res.status(500).json({ success: false });
      }

      // ✅ SUCCESS LOG
      addLog(
        "WARN",
        `Chat ID deleted (ID ${id}) → Agent: ${row.agentName}, Group: ${row.groupName}, ChatId: ${row.chatId}`,
        user
      );

      addLog("WARN", "Google credential file uploaded/replaced", user);
      res.json({ success: true });
    });
  });
});

//////////////////Settled & Revert API////////////////////
app.get("/api/settled", requirePermission("view_page_settled_deposits"), (req, res) => {

  const {
    startDate, 
    endDate, 
    status, 
    search,
    settledBy,
    brand,
    sortBy
  } = req.query;

  let query = `
    SELECT * FROM transactions
    WHERE actionStatus IN ('APPROVED','REJECTED')
  `;

  const params = [];

  // 🔍 SEARCH
  if (search) {
  query += `
    AND (
      transactionReference LIKE ?
      OR agentName LIKE ?
      OR depositId LIKE ?
      OR reason LIKE ?
    )
  `;

  params.push(
    `%${search}%`,
    `%${search}%`,
    `%${search}%`,
    `%${search}%`
  );
}

  // 🎯 STATUS
  if (status) {
    query += ` AND actionStatus = ?`;
    params.push(status);
  }

  // 👤 SETTLED BY
  if (settledBy) {
    query += ` AND settledBy = ?`;
    params.push(settledBy);
  }

  // 🏷 BRAND
  if (brand) {
    query += ` AND brand = ?`;
    params.push(brand);
  }

  // 📅 DATE FILTER
  if (req.query.all !== "1") {

    if (startDate && endDate) {

      query += ` AND date(settledAt) BETWEEN date(?) AND date(?)`;
      params.push(startDate, endDate);

    } else {

    // 🔥 default today only
      query += ` AND date(settledAt) = date('now', '+8 hours')`;

    }

  }

  // 🔽 SORT
  const sortMap = {
    settledAt_desc: "datetime(settledAt) DESC",
    settledAt_asc: "datetime(settledAt) ASC",
    settledBy_asc: "settledBy ASC",
    settledBy_desc: "settledBy DESC",
    status_asc: "actionStatus ASC",
    status_desc: "actionStatus DESC"
  };

  if (sortBy && sortMap[sortBy]) {
    query += ` ORDER BY ${sortMap[sortBy]}`;
  } else {
    query += ` ORDER BY datetime(settledAt) DESC`;
  }

  db.all(query, params, (err, rows) => {
    if (err) {
      console.error("❌ SETTLED ERROR:", err);
      return res.json([]);
    }

    res.json(rows);
  });
});

app.post("/api/revert", requirePermission("edit_transaction"), (req, res) => {
  const { id } = req.body;

  db.run(`
    UPDATE transactions
    SET 
      actionStatus = 'PENDING',
      agentStatus = NULL,
      reason = NULL,
      confirmedBy = NULL,
      followUpCount = 0,
      lastFollowUpAt = NULL,
      telegramMessageId = NULL
    WHERE id = ?
  `, [id]);

  res.json({ success: true });
});

app.post("/api/manual-add", requirePermission("edit_transaction"), (req, res) => {
  const {
    ref,
    amount,
    agent,
    brand,
    depositId,
    customer,
    date,
    agentNo,
    image
  } = req.body;

  const sql = `
    INSERT INTO transactions (
      transactionReference,
      depositId,
      agentName,
      customerNumber,
      amount,
      depositDate,
      agentNumber,
      imageLink,
      essStatus,
      status,
      actionStatus,
      agentStatus,
      brand
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  db.run(sql, [
  ref,
  depositId,
  agent,
  customer,
  amount,
  date,
  agentNo,
  image,
  "MANUAL",         
  "PENDING", 
  "PENDING", 
  null,
  brand || "MANUAL"
], function (err) {

    // 🔥 HANDLE ERROR PROPERLY
    if (err) {
      console.error("❌ Insert error:", err.message);

      if (err.code === "SQLITE_CONSTRAINT") {
        return res.status(400).json({
          success: false,
          type: "duplicate",
          message: "Duplicate reference + deposit ID"
        });
      }

      return res.status(500).json({
        success: false,
        message: "Database error"
      });
    }

    // ✅ SUCCESS
    res.json({
      success: true,
      id: this.lastID
    });
  });
});

app.use("/uploads", express.static("uploads"));

app.post(
  "/api/upload-image",
  requirePermission("edit_transaction"),
  upload.single("file"),
  (req, res) => {

    if (!req.file) {
      return res.status(400).json({
        error: "No file uploaded"
      });
    }
    const allowed = [
  ".png",
  ".jpg",
  ".jpeg",
  ".webp"
];

const ext = path.extname(req.file.originalname).toLowerCase();

if (!allowed.includes(ext)) {

  fs.unlinkSync(req.file.path);

  return res.status(400).json({
    error: "Only PNG/JPG/WEBP allowed"
  });
}

    const url =
      `https://${req.get("host")}/uploads/${req.file.filename}`;

    res.json({ url });
  }
);

app.post("/api/edit", requirePermission("edit_transaction"), (req, res) => {
  const { id, amount } = req.body;

  db.run(`
    UPDATE transactions
    SET amount = ?
    WHERE id = ?
  `, [amount, id]);

  res.json({ success: true });
});

function extractBaseGroup(groupName) {

  if (!groupName) return null;

  groupName = groupName.trim().toUpperCase();

  const parts = groupName.split("-");

  // 🔥 SIMPLE FORMAT
  // ex: ESS-Integration
  if (parts.length === 2) {

    return `${parts[0]}-${parts[1]}`;

  }

  // 🔥 NORMAL FORMAT
  // ex: ESS-AG1-HAFIZU006-BKASH
  if (parts.length >= 3) {

    const agent = parts[2].replace(/[0-9]/g, "");

    return `${parts[0]}-${parts[1]}-${agent}`;

  }

  return null;
}

function getChat(groupName) {
  return new Promise((resolve) => {

    if (!groupName) {
      return resolve(process.env.DEFAULT_CHAT_ID);
    }

    const baseGroup = extractBaseGroup(groupName);

    console.log("🔍 Incoming:", groupName);
    console.log("🔍 BaseGroup:", baseGroup);

    if (!baseGroup) {
      return resolve(process.env.DEFAULT_CHAT_ID);
    }

    db.get(
      `SELECT chatId
FROM chat_ids
WHERE UPPER(groupName) = UPPER(?)
LIMIT 1`,
      [baseGroup],
      (err, row) => {

        if (err) {
          console.log("❌ DB ERROR:", err.message);
          return resolve(process.env.DEFAULT_CHAT_ID);
        }

        if (row?.chatId) {
          console.log("✅ MATCH:", baseGroup, "→", row.chatId);
          return resolve(row.chatId);
        }

        console.log("❌ No match for:", baseGroup);

        return resolve(process.env.DEFAULT_CHAT_ID);
      }
    );

  });
}

////////////Developer Utility////////////
app.post("/api/settings", requirePermission("settings_access")
, (req, res) => {
  const user = getLogUser(req);
  const { 
    botToken,
    gsheetLink,
    sheetNames,
    videoGsheetLink,
    videoSheetNames,
    followUpIntervalMinutes,
    followUpEnabled,
    followUpStartTime,
    followUpEndTime,
    followUpMessageText,
    followUpMessageFields,
    followUpDeletePrevious,
    followUpImagePreview,
    followUpImageFormat,
    followUpExcludedAgents,
    sheetColumnMap,
    sheetUpdateColumnMap,
    manualReplyParser,
    openingBalanceShopColumn,
    openingBalanceAmountColumn,
    settlementSheetLink,
    settlementWorksheetName,
    settlementAgentColumn,
    settlementWalletColumn,
    settlementAmountColumn,
    settlementDateColumn,
    balanceCalculationSettings,
    walletTypes,
    balanceTodaySource
  } = req.body;

  if (!gsheetLink) {
    return res.json({ success: false, message: "Invalid settings" });
  }

  const normalizedFollowUpInterval = Math.max(
    1,
    Math.floor(Number(followUpIntervalMinutes) || 30)
  );

  const normalizedFollowUpEnabled = followUpEnabled === false || followUpEnabled === "0"
    ? 0
    : 1;

  const allowedFollowUpFields = new Set(["agent", "ref", "amount", "customer", "image"]);
  const normalizedFollowUpFields = Array.isArray(followUpMessageFields)
    ? followUpMessageFields.filter(field => allowedFollowUpFields.has(field))
    : [];
  const normalizedImageFormat = followUpImageFormat === "url" ? "url" : "link";
  const normalizedFollowUpExcludedAgents = String(followUpExcludedAgents || "")
    .split(/[\n,]+/)
    .map(item => item.trim())
    .filter(Boolean)
    .join("\n");
  const normalizedSheetColumnMap = JSON.stringify(
    parseColumnMap(sheetColumnMap, DEFAULT_SYNC_COLUMN_MAP)
  );
  const normalizedSheetUpdateColumnMap = JSON.stringify(
    parseColumnMap(sheetUpdateColumnMap, DEFAULT_UPDATE_COLUMN_MAP)
  );
  const normalizedManualReplyParser = JSON.stringify(
    normalizeManualReplyParser(manualReplyParser)
  );
  const normalizedBalanceCalculationSettings = JSON.stringify(
    normalizeBalanceCalculationSettings(balanceCalculationSettings)
  );
  const normalizedOpeningBalanceShopColumn = String(openingBalanceShopColumn || "SHOP").trim() || "SHOP";
  const normalizedOpeningBalanceAmountColumn = String(openingBalanceAmountColumn || "BALANCE").trim() || "BALANCE";
  const normalizedSettlementSheetLink = String(settlementSheetLink || "").trim();
  const normalizedSettlementWorksheetName = String(settlementWorksheetName || "").trim();
  const normalizedSettlementAgentColumn = String(settlementAgentColumn || "Agent Name").trim() || "Agent Name";
  const normalizedSettlementWalletColumn = String(settlementWalletColumn || "Wallet").trim() || "Wallet";
  const normalizedSettlementAmountColumn = String(settlementAmountColumn || "Amount").trim() || "Amount";
  const normalizedSettlementDateColumn = String(settlementDateColumn || "Date").trim() || "Date";
  const normalizedWalletTypes = JSON.stringify(normalizeWalletTypes(walletTypes));
  const normalizedBalanceTodaySource = balanceTodaySource === "wallet" ? "wallet" : "upload";

  db.get(`SELECT botToken FROM settings WHERE id = 1`, (err, existingSettings) => {
    if (err) {
      console.error("Settings save lookup failed:", err.message);
      return res.json({ success: false, message: "Settings save failed" });
    }

    const incomingBotToken = String(botToken || "").trim();
    const normalizedBotToken = incomingBotToken && !isMaskedSecret(incomingBotToken)
      ? incomingBotToken
      : existingSettings?.botToken || "";

    if (!normalizedBotToken) {
      return res.json({ success: false, message: "Bot token is required" });
    }

    db.run(`
    INSERT INTO settings (
      id, botToken, gsheetLink, sheetNames,
      videoGsheetLink, videoSheetNames, followUpIntervalMinutes,
      followUpEnabled, followUpStartTime, followUpEndTime,
      followUpMessageText, followUpMessageFields, followUpDeletePrevious,
      followUpImagePreview, followUpImageFormat, followUpExcludedAgents, sheetColumnMap,
      sheetUpdateColumnMap, manualReplyParser,
      openingBalanceShopColumn, openingBalanceAmountColumn,
      settlementSheetLink, settlementWorksheetName, settlementAgentColumn,
      settlementWalletColumn, settlementAmountColumn, settlementDateColumn,
      balanceCalculationSettings, walletTypes, balanceTodaySource
    )
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      botToken = excluded.botToken,
      gsheetLink = excluded.gsheetLink,
      sheetNames = excluded.sheetNames,
      videoGsheetLink = excluded.videoGsheetLink,
      videoSheetNames = excluded.videoSheetNames,
      followUpIntervalMinutes = excluded.followUpIntervalMinutes,
      followUpEnabled = excluded.followUpEnabled,
      followUpStartTime = excluded.followUpStartTime,
      followUpEndTime = excluded.followUpEndTime,
      followUpMessageText = excluded.followUpMessageText,
      followUpMessageFields = excluded.followUpMessageFields,
      followUpDeletePrevious = excluded.followUpDeletePrevious,
      followUpImagePreview = excluded.followUpImagePreview,
      followUpImageFormat = excluded.followUpImageFormat,
      followUpExcludedAgents = excluded.followUpExcludedAgents,
      sheetColumnMap = excluded.sheetColumnMap,
      sheetUpdateColumnMap = excluded.sheetUpdateColumnMap,
      manualReplyParser = excluded.manualReplyParser,
      openingBalanceShopColumn = excluded.openingBalanceShopColumn,
      openingBalanceAmountColumn = excluded.openingBalanceAmountColumn,
      settlementSheetLink = excluded.settlementSheetLink,
      settlementWorksheetName = excluded.settlementWorksheetName,
      settlementAgentColumn = excluded.settlementAgentColumn,
      settlementWalletColumn = excluded.settlementWalletColumn,
      settlementAmountColumn = excluded.settlementAmountColumn,
      settlementDateColumn = excluded.settlementDateColumn,
      balanceCalculationSettings = excluded.balanceCalculationSettings,
      walletTypes = excluded.walletTypes,
      balanceTodaySource = excluded.balanceTodaySource
  `, [
    normalizedBotToken,
    gsheetLink,
    sheetNames,
    videoGsheetLink,
    videoSheetNames,
    normalizedFollowUpInterval,
    normalizedFollowUpEnabled,
    followUpStartTime || "",
    followUpEndTime || "",
    String(followUpMessageText || ""),
    JSON.stringify(normalizedFollowUpFields),
    followUpDeletePrevious ? 1 : 0,
    followUpImagePreview ? 1 : 0,
    normalizedImageFormat,
    normalizedFollowUpExcludedAgents,
    normalizedSheetColumnMap,
    normalizedSheetUpdateColumnMap,
    normalizedManualReplyParser,
    normalizedOpeningBalanceShopColumn,
    normalizedOpeningBalanceAmountColumn,
    normalizedSettlementSheetLink,
    normalizedSettlementWorksheetName,
    normalizedSettlementAgentColumn,
    normalizedSettlementWalletColumn,
    normalizedSettlementAmountColumn,
    normalizedSettlementDateColumn,
    normalizedBalanceCalculationSettings,
    normalizedWalletTypes,
    normalizedBalanceTodaySource
  ], (err) => {
    if (err) {
      console.error("Settings save failed:", err.message);
      return res.json({ success: false, message: "Settings save failed" });
    }

    loadSettings();
    addLog(
      "WARN",
      `Settings changed (follow-up ${normalizedFollowUpEnabled ? "enabled" : "disabled"}, interval ${normalizedFollowUpInterval}m, schedule ${followUpStartTime || "all-day"}-${followUpEndTime || "all-day"})`,
      user
    );
    res.json({ success: true });
  });
  });
});

app.get("/api/settings", requirePermission("settings_access"), (req, res) => {
  db.get(`SELECT * FROM settings WHERE id = 1`, (err, row) => {
    const settings = row || {};
    settings.sheetColumnMap = JSON.stringify(
      parseColumnMap(settings.sheetColumnMap, DEFAULT_SYNC_COLUMN_MAP)
    );
    settings.sheetUpdateColumnMap = JSON.stringify(
      parseColumnMap(settings.sheetUpdateColumnMap, DEFAULT_UPDATE_COLUMN_MAP)
    );
    settings.manualReplyParser = JSON.stringify(
      normalizeManualReplyParser(settings.manualReplyParser)
    );
    settings.balanceCalculationSettings = JSON.stringify(
      normalizeBalanceCalculationSettings(settings.balanceCalculationSettings)
    );
    settings.walletTypes = JSON.stringify(normalizeWalletTypes(settings.walletTypes));
    settings.balanceTodaySource = settings.balanceTodaySource === "wallet" ? "wallet" : "upload";
    settings.hasBotToken = Boolean(settings.botToken);
    settings.botToken = maskSecret(settings.botToken);
    res.json(settings);
  });
});

app.get("/api/balance/calculation-settings", requirePermission("view_page_balance"), (req, res) => {
  db.get(`SELECT balanceCalculationSettings FROM settings WHERE id = 1`, (err, row) => {
    if (err) {
      console.error("Balance settings load failed:", err.message);
      return res.json(DEFAULT_BALANCE_CALCULATION_SETTINGS);
    }

    res.json(normalizeBalanceCalculationSettings(row?.balanceCalculationSettings));
  });
});

async function getSettlementSheetDeductions() {
  const settings = await new Promise((resolve) => {
    db.get(`
      SELECT
        settlementSheetLink,
        settlementWorksheetName,
        settlementAgentColumn,
        settlementWalletColumn,
        settlementAmountColumn,
        settlementDateColumn
      FROM settings
      WHERE id = 1
      LIMIT 1
    `, (err, row) => resolve(err ? null : row));
  });

  const spreadsheetId = extractSpreadsheetId(settings?.settlementSheetLink);
  const worksheetName = String(settings?.settlementWorksheetName || "").trim();
  if (!spreadsheetId || !worksheetName) return new Map();

  const sheets = google.sheets({
    version: "v4",
    auth: await googleSheetsAuth.getClient()
  });

  const result = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${worksheetName.replace(/'/g, "''")}'!A:Z`
  });

  const values = result.data.values || [];
  if (values.length < 2) return new Map();

  const headers = values[0].map(normalizeSheetHeader);
  const getIndex = (headerName) => headers.indexOf(normalizeSheetHeader(headerName));
  const agentIndex = getIndex(settings?.settlementAgentColumn || "Agent Name");
  const walletIndex = getIndex(settings?.settlementWalletColumn || "Wallet");
  const amountIndex = getIndex(settings?.settlementAmountColumn || "Amount");
  const dateIndex = getIndex(settings?.settlementDateColumn || "Date");

  if ([agentIndex, walletIndex, amountIndex, dateIndex].some(index => index < 0)) {
    throw new Error("Settlement sheet headers are incomplete");
  }

  const today = todayDateKey();
  const deductions = new Map();

  values.slice(1).forEach(row => {
    if (sheetDateKey(row[dateIndex]) !== today) return;

    const agent = normalizeSheetKey(row[agentIndex]);
    const wallet = normalizeSheetKey(row[walletIndex]);
    const amount = parseMoney(row[amountIndex]);
    if (!agent || !wallet || amount <= 0) return;

    const key = `${agent}|${wallet}`;
    deductions.set(key, (deductions.get(key) || 0) + amount);
  });

  return deductions;
}

app.post("/api/reconcile", requirePermission("reconcile_data"), async (req, res) => {
  const user = getLogUser(req);
  try {
    console.log("🧠 Manual reconcile started...");

    addLog("INFO", "Manual reconcile started", user);
    const result = await syncSheets(true); // let sync return stats
    addLog("INFO", `Manual reconcile completed (fixed ${result?.fixed || 0}, inserted ${result?.inserted || 0})`, user);

    res.json({
      success: true,
      fixed: result?.fixed || 0,
      inserted: result?.inserted || 0
    });

  } catch (err) {
    console.error("❌ RECONCILE ERROR:", err);
    addLog("ERROR", `Manual reconcile failed: ${err.message}`, user);
    res.status(500).json({ success: false });
  }
});

app.post(
  "/api/upload-credential",
  requirePermission("upload_credentials"),
  upload.single("credential"),
  (req, res) => {
    const user = getLogUser(req);

    try {

      if (!req.file) {
        return res.json({
          success: false,
          message: "No file uploaded"
        });
      }

      const credentialsDir = path.join(
        __dirname,
        "credentials"
      );

      if (!fs.existsSync(credentialsDir)) {
        fs.mkdirSync(credentialsDir);
      }

      const targetPath = path.join(
        credentialsDir,
        "credentials.json"
      );

      fs.copyFileSync(
        req.file.path,
        targetPath
      );

      fs.unlinkSync(req.file.path);

      res.json({ success: true });

    } catch (err) {

      console.error(err);
      addLog("ERROR", `Credential upload failed: ${err.message}`, user);

      res.json({
        success: false,
        message: err.message
      });
    }
  }
);

app.get("/api/credential-status", requirePermission("upload_credentials"), (req, res) => {

  const credentialPath = path.join(
    __dirname,
    "credentials",
    "credentials.json"
  );

  res.json({
    exists: fs.existsSync(credentialPath)
  });

});

app.post(
  "/api/permissions/save",
  requirePermission("change_roles"),
  (req, res) => {

    const { role, permissions } = req.body;

    if (!role || !permissions) {
      return res.json({
        success: false
      });
    }

    db.serialize(() => {

      // 🔥 remove old permissions
      db.run(
        "DELETE FROM role_permissions WHERE role=?",
        [role]
      );

      // 🔥 insert new permissions
      const stmt = db.prepare(`
        INSERT INTO role_permissions (
          role,
          permission,
          allowed
        )
        VALUES (?, ?, ?)
      `);

      Object.entries(permissions).forEach(([key, value]) => {

        stmt.run(
          role,
          key,
          value ? 1 : 0
        );

      });

      stmt.finalize();

      res.json({
        success: true
      });

    });

  }
);

app.get(
  "/api/permissions/:role",
  requirePermission("change_roles"),
  (req, res) => {

    const role = req.params.role;

    db.all(`
      SELECT permission, allowed
      FROM role_permissions
      WHERE role=?
    `, [role], (err, rows) => {

      if (err) {
        return res.json({
          success: false
        });
      }

      const permissions = {};

      rows.forEach(r => {
        permissions[r.permission] = r.allowed === 1;
      });

      res.json({
        success: true,
        permissions
      });

    });

  }
);
/////////////////////////////////////////Dashboard/////////////////////////////////////////////////////////
app.get("/api/agent-performance", requirePermission("view_page_dashboard"), (req, res) => {
  const { filter } = req.query;

  let where = `WHERE actionStatus IN ('APPROVED','REJECTED')`;

  if (filter === "today") {
    where += ` AND DATE(datetime(syncedAt, '+8 hours')) = DATE('now', '+8 hours')`;
  }

  if (filter === "session") {
    where += ` AND confirmedAt >= datetime('now', '-2 hours')`;
  }

  if (filter === "lastSync") {
    where += ` AND confirmedAt >= (SELECT lastSync FROM settings LIMIT 1)`;
  }

  db.all(`
    SELECT agentName,

      SUM(CASE WHEN actionStatus = 'APPROVED' THEN 1 ELSE 0 END) as approved,
      SUM(CASE WHEN actionStatus = 'REJECTED' THEN 1 ELSE 0 END) as rejected,

      COUNT(*) as total

    FROM transactions
    ${where}
    GROUP BY agentName
    ORDER BY total DESC
  `, (err, rows) => {
    res.json(rows);
  });
});

app.get("/api/agent-performance-today", requirePermission("view_page_dashboard"), (req, res) => {

  db.all(`
    SELECT 
      agentName,

      SUM(CASE WHEN actionStatus = 'APPROVED' THEN 1 ELSE 0 END) as approved,
      SUM(CASE WHEN actionStatus = 'REJECTED' THEN 1 ELSE 0 END) as rejected,

      SUM(CASE 
        WHEN actionStatus = 'PENDING' OR actionStatus IS NULL 
        THEN 1 ELSE 0 
      END) as pending,

      COUNT(*) as total

    FROM transactions

    WHERE DATE(datetime(syncedAt, '+8 hours')) = DATE('now', '+8 hours')

    GROUP BY agentName

    HAVING total > 3   -- 🔥 ONLY agents with more than 3

    ORDER BY total DESC

    LIMIT 10           -- 🔥 TOP 10 ONLY

  `, (err, rows) => {

    if (err) {
      console.error(err);
      return res.status(500).json({ error: err.message });
    }

    res.json(rows);
  });

});

app.get("/api/dashboard/settled-stats", requirePermission("view_page_dashboard"), (req, res) => {
  const userQuery = `
    SELECT 
    u.username,
    
    COALESCE(SUM(CASE WHEN t.actionStatus = 'APPROVED' THEN 1 ELSE 0 END), 0) as approved,
    COALESCE(SUM(CASE WHEN t.actionStatus = 'REJECTED' THEN 1 ELSE 0 END), 0) as rejected,

    COALESCE(SUM(CASE 
    WHEN t.id IS NOT NULL AND (t.actionStatus = 'PENDING' OR t.actionStatus IS NULL)
    THEN 1 ELSE 0 
    END), 0) as pending

    FROM users u
    LEFT JOIN transactions t 
    ON t.settledBy = u.username

    GROUP BY u.username
  `;

  const agentQuery = `
  SELECT
    agentName,

    SUM(CASE WHEN actionStatus = 'APPROVED' THEN 1 ELSE 0 END) as approved,
    SUM(CASE WHEN actionStatus = 'REJECTED' THEN 1 ELSE 0 END) as rejected,

    SUM(CASE
      WHEN actionStatus = 'PENDING' OR actionStatus IS NULL
      THEN 1 ELSE 0
    END) as pending,

    COUNT(*) as total

  FROM transactions

  GROUP BY agentName

  ORDER BY total DESC
  LIMIT 10
`;

  db.all(userQuery, (err, userStats) => {
    db.all(agentQuery, (err, agentStats) => {
      res.json({ userStats, agentStats });
    });
  });
});

app.get("/api/logs", requirePermission("view_logs"), (req, res) => {
  const limit = 50;
  const offset = parseInt(req.query.offset) || 0;

  db.all(`
    SELECT * FROM system_logs
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `, [limit, offset], (err, rows) => {
    res.json(rows);
  });
});

app.delete("/api/logs", requirePermission("clear_logs"), (req, res) => {
  const user = req.session?.user?.username || "unknown";

  db.run("DELETE FROM system_logs", function (err) {
    if (err) {
      addLog("ERROR", `Failed to clear logs: ${err.message}`, user);
      return res.status(500).json({ success: false });
    }

    // this.changes = number of deleted rows 🔥
    const deleted = this.changes;

    addLog("WARN", `System logs cleared by ${user} (${deleted} logs removed)`);

    res.json({ success: true });
  });
});

function autoCleanLogs() {
  db.run(`
    DELETE FROM system_logs
    WHERE createdAt < datetime('now', '-3 days')
  `, function () {
    if (this.changes > 0) {
      addLog("INFO", `Auto-clean removed ${this.changes} old logs`);
    }
  });
}
function getLogUser(req) {
  return req?.session?.user?.username || req?.session?.user?.role || "system";
}

function addLog(level, message, user = null) {
  const cleanLevel = String(level || "INFO").toUpperCase();
  const cleanMessage = String(message || "").replace(/\s+/g, " ").trim().slice(0, 1200);
  const fullMessage = user ? `${cleanMessage} by ${user}` : cleanMessage;

  db.run(`
    INSERT INTO system_logs (level, message)
    VALUES (?, ?)
  `, [cleanLevel, fullMessage], (err) => {
    if (err) console.error("SYSTEM LOG INSERT ERROR:", err.message);
  });

  try {
    const io = getIO();
    io?.emit("log", {
      level: cleanLevel,
      message: fullMessage,
      time: new Date().toISOString()
    });
  } catch {}
}

process.on("uncaughtException", (err) => {
  addLog("CRITICAL", `Uncaught exception: ${err.stack || err.message}`);
});

process.on("unhandledRejection", (reason) => {
  const message = reason?.stack || reason?.message || String(reason);
  addLog("CRITICAL", `Unhandled rejection: ${message}`);
});

// run every hour
setInterval(autoCleanLogs, 60 * 60 * 1000);

app.post("/api/log-settings", requirePermission("view_logs"), (req, res) => {
  const { chatId, password } = req.body;
  const user = getLogUser(req);

  db.run(`
    INSERT OR REPLACE INTO log_settings (id, chatId, password)
    VALUES (1, ?, ?)
  `, [chatId, password]);

  addLog("WARN", `Legacy log Telegram settings changed (chatId ${chatId || "-"})`, user);
  res.json({ success: true, message: "Log settings saved" });
});

app.post("/api/send-logs", requirePermission("send_logs"), async (req, res) => {
  const { password } = req.body;
  const user = req.session.user;
  const userId = user.id;

  db.get(`SELECT * FROM log_settings WHERE id = 1`, async (err, settings) => {

    if (!settings) {
      return res.json({ success: false, message: "No settings" });
    }

    if (settings.ownerId !== userId) {
      return res.json({ success: false, message: "Not owner" });
    }

    const match = await bcrypt.compare(password, settings.passwordHash);

    if (!match) {
      return res.json({ success: false, message: "Invalid password" });
    }

    // 🔔 🔥 START NOTIFICATION
    createNotification({
      type: "SYSTEM",
      title: "Log Export Started",
      message: `${user.username} is exporting system logs`,
      target: "ALL"
    });

    db.all(`SELECT * FROM system_logs ORDER BY id DESC LIMIT 100`, async (err, logs) => {

      const text = logs.map(l =>
        `[${l.createdAt}] (${l.level}) ${l.message}`
      ).join("\n");

      try {
        const chunks = text.match(/[\s\S]{1,3500}/g) || [];

        let sent = 0;

        for (const chunk of chunks) {
          await bot.sendMessage(settings.chatId, chunk);
          sent++;
        }

        // 🔔 🔥 SUCCESS NOTIFICATION
        createNotification({
          type: "TG",
          title: "Logs Sent to Telegram",
          message: `${user.username} sent ${logs.length} logs (${sent} chunks)`,
          meta: { totalLogs: logs.length, chunks: sent },
          target: "ALL"
        });

        addLog("INFO", `System logs sent to Telegram (${logs.length} logs, ${sent} chunks)`, user.username);
        res.json({ success: true });

      } catch (err) {
        console.error(err);

        // 🔔 🔥 ERROR NOTIFICATION
        createNotification({
          type: "SYSTEM",
          title: "Log Export Failed",
          message: `${user.username} failed to send logs`,
          meta: { error: err.message },
          target: "ALL"
        });

        addLog("ERROR", `Sending system logs to Telegram failed: ${err.message}`, user.username);
        res.json({ success: false, message: "Telegram failed" });
      }
    });
  });
});

app.post("/api/log-access", requirePermission("view_logs"), async (req, res) => {
  const { password } = req.body;
  const userId = req.session.user.id;

  db.get(`SELECT * FROM log_settings WHERE id = 1`, async (err, row) => {

    // 🆕 First time setup
    if (!row) {
      return res.json({ firstTime: true });
    }

    // ❌ Not owner
    if (row.ownerId !== userId) {
      return res.json({ success: false, message: "Access denied" });
    }

    const match = await bcrypt.compare(password, row.passwordHash);

    if (!match) {
      return res.json({ success: false, message: "Wrong password" });
    }

    res.json({ success: true });
  });
});

app.post("/api/log-settings-secure", requirePermission("view_logs"), async (req, res) => {
  const { chatId, password } = req.body;
  const userId = req.session.user.id;
  const user = getLogUser(req);

  db.get(`SELECT * FROM log_settings WHERE id = 1`, async (err, row) => {

    // 🆕 FIRST TIME → set owner
    if (!row) {
      const hash = await bcrypt.hash(password, 10);

      db.run(`
        INSERT INTO log_settings (id, chatId, passwordHash, ownerId, locked)
        VALUES (1, ?, ?, ?, 1)
      `, [chatId, hash, userId]);

      addLog("WARN", `Secure log settings initialized (chatId ${chatId || "-"})`, user);
      return res.json({ success: true, message: "Locked as OWNER" });
    }

    // 🔒 NOT OWNER → BLOCK
    if (row.ownerId !== userId) {
      return res.json({ success: false, message: "Not owner" });
    }

    // 🔐 OWNER → allow update
    const hash = await bcrypt.hash(password, 10);

    db.run(`
      UPDATE log_settings
      SET chatId = ?, passwordHash = ?
      WHERE id = 1
    `, [chatId, hash]);

    addLog("WARN", `Secure log settings updated (chatId ${chatId || "-"})`, user);
    res.json({ success: true, message: "Updated by owner" });
  });
});

////////////Log in//////////
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;

  db.get(
    `SELECT * FROM users WHERE username = ?`,
    [username],
    async (err, user) => {

      if (!user) {
        addLog("WARN", `Login failed for unknown user ${username || "-"}`);
        return res.json({ success: false });
      }

      const match = await bcrypt.compare(password, user.password);

      if (!match) {
        addLog("WARN", `Login failed for ${username}: wrong password`);
        return res.json({ success: false });
      }

      req.session.user = {
        id: user.id,
        username: user.username,
        role: user.role
      };
      addLog("INFO", `Login success (${user.username}, role ${user.role})`);
      res.json({ success: true });
    }
  );
});

app.use((req, res, next) => {
  if (req.session?.user?.id) {
    db.run(`
      UPDATE users 
      SET lastActive = datetime('now') 
      WHERE id = ?
    `, [req.session.user.id]);
  }
  next();
});

app.get("/api/me", (req, res) => {
  if (!req.session.user) {
    return res.status(401).json(null);
  }

  res.json(req.session.user);
});

app.get("/api/my-permissions", requireAuth, (req, res) => {
  const role = req.session.user.role;

  db.all(`
    SELECT permission, allowed
    FROM role_permissions
    WHERE role=?
  `, [role], (err, rows = []) => {

    if (err) {
      return res.status(500).json({
        success: false,
        permissions: {}
      });
    }

    const permissions = {};

    rows.forEach(row => {
      permissions[row.permission] = row.allowed === 1;
    });

    res.json({
      success: true,
      permissions
    });

  });
});

async function safeFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    credentials: "include" // ✅ THIS is the fix
  });

  if (res.status === 401) {
    return null;
  }

  return res;
}


app.post("/api/logout", (req, res) => {
  if (!req.session) {
    return res.json({ success: true });
  }

  req.session.destroy(() => {
    res.json({ success: true });
  });
});

//////////////////////Pending Assing Chat id//////////////////////
app.post("/api/assign-group", requirePermission("edit_transaction"), (req, res) => {
  const { id, chatId } = req.body;

  db.get(`SELECT * FROM transactions WHERE id = ?`, [id], async (err, row) => {
    if (!row) return res.json({ success: false });

    try {
      const result = await processSend(row, chatId);

      if (!result.success) {
        return res.json(result);
      }

      db.run(`
        UPDATE transactions
        SET
          sent = 1,
          agentStatus = ?,
          followUpCount = ?
        WHERE id = ?
      `, [result.agentStatus || "1st FF", result.followUpCount || 1, id]);

      res.json({ success: true });

    } catch (err) {
      console.log("❌ Manual send error:", err.message);
      res.json({ success: false });
    }
  });
});

app.post("/api/send/:id", requirePermission("send_telegram"), async (req, res) => {
  const id = req.params.id;
  const user = req.session.user;
  const { messageOptions } = req.body || {};

  db.get(`SELECT * FROM transactions WHERE id = ?`, [id], async (err, row) => {

    if (err) {
      console.error("❌ DB ERROR:", err);
      return res.json({ success: false, message: "DB error" });
    }

    if (!row) {
      return res.json({ success: false, message: "Row not found" });
    }

    if (row.sent === 1) {
      return res.json({ success: false, message: "Already sent" });
    }

    try {
      const result = await processSend(row, null, messageOptions);

      if (!result.success) {
        return res.json(result);
      }

      db.run(`
        UPDATE transactions
        SET
          sent = 1,
          agentStatus = ?,
          followUpCount = ?,
          confirmedAt = COALESCE(confirmedAt, datetime('now', '+8 hours')),
          reason = NULL
        WHERE id = ?
      `, [result.agentStatus || "1st FF", result.followUpCount || 1, id]);

      addLog("INFO", `Transaction sent (ID ${id}, Agent: ${row.agentName})`);

      // 🔔🔥 THIS IS WHAT YOU WERE MISSING
      createNotification({
        type: "TG",
        title: "Sent to Telegram",
        message: `${user.username} sent deposit ${row.depositId}`,
        meta: {
          depositIds: [row.depositId]
        },
        target: "ALL"
      });

      res.json({ success: true });

    } catch (err) {
      console.error("❌ SEND ERROR:", err);

      // 🔔 ERROR NOTIFICATION (VERY IMPORTANT)
      createNotification({
        type: "SYSTEM",
        title: "Send Failed",
        message: `${user.username} failed to send ${row.depositId}`,
        meta: { error: err.message },
        target: "ALL"
      });

      res.json({ success: false, message: err.message });
    }
  });
});

function processSend(row, overrideChatId = null, messageOptions = null) {
  return (async () => {
    const chatId = overrideChatId || await getChat(row.agentName);

    if (!chatId) {
      return { success: false, message: "No chatId found" };
    }

    const resolvedMessageOptions = messageOptions === null || messageOptions === undefined
      ? await getSavedPendingMessageOptions()
      : messageOptions;
    const currentFollowUpCount = Number(row.followUpCount || 0);
    const sendFollowUpCount = currentFollowUpCount > 0 ? currentFollowUpCount : 1;

    const result = await sendTelegram({
      chatId,
      id: row.id,
      transactionReference: row.transactionReference,
      amount: row.amount,
      agentName: row.agentName,
      customerNumber: row.customerNumber,
      imageLink: row.imageLink,
      followUpCount: sendFollowUpCount,
      messageOptions: resolvedMessageOptions
    });

    if (!result) {
      return { success: false, message: "Telegram send failed" };
    }

    return {
      success: true,
      followUpCount: sendFollowUpCount,
      agentStatus: sendFollowUpCount === 1 ? "1st FF" : (row.agentStatus || "1st FF"),
      chatId: String(chatId),
      messageId: String(result.message_id)
    };
  })();
}

function getSavedPendingMessageOptions() {
  return new Promise((resolve) => {
    db.get(`
      SELECT
        followUpMessageText,
        followUpMessageFields,
        followUpImagePreview,
        followUpImageFormat
      FROM settings
      WHERE id = 1
      LIMIT 1
    `, (err, row) => {
      if (err || !row) {
        return resolve(null);
      }

      let fields = ["agent", "ref", "amount", "customer", "image"];

      if (row.followUpMessageFields) {
        try {
          fields = JSON.parse(row.followUpMessageFields);
        } catch (parseErr) {
          fields = String(row.followUpMessageFields).split(",");
        }
      }

      resolve({
        messageText: row.followUpMessageText || "",
        fields,
        imagePreview: Number(row.followUpImagePreview || 0) === 1,
        imageFormat: row.followUpImageFormat === "url" ? "url" : "link"
      });
    });
  });
}

if (chatIdPaused) {
  console.log("⏸ Chat ID detection paused");
  return res.sendStatus(200);
}

app.post("/api/chatid/toggle", requirePermission("manage_chat_ids"), (req, res) => {
  chatIdPaused = !chatIdPaused;

  res.json({ paused: chatIdPaused });
});

app.get("/api/chatid/status", requirePermission("view_page_chat_id"), (req, res) => {
  res.json({ paused: chatIdPaused });
});


////////////////////Pending Delete,Edit,//////////////////
app.post("/api/delete", requirePermission("delete_transaction"), (req, res) => {
  const { id } = req.body;
  const user = req.session.user.username;

  // 🔥 STEP 1: get depositId before delete
  db.get(`SELECT depositId FROM transactions WHERE id = ?`, [id], (err, row) => {

    if (err || !row) {
      return res.json({ success: false });
    }

    const depositId = row.depositId;

    // 🔥 STEP 2: delete
    db.run(`DELETE FROM transactions WHERE id = ?`, [id], function(err) {

      if (err) return res.json({ success: false });

      if (this.changes === 0) {
        return res.json({ success: true });
      }

      addLog("WARN", `Deleted transaction ${depositId}`, user);

      // 🔔 NOTIFICATION
      createNotification({
        type: "SYSTEM",
        title: "Row Deleted",
        message: `${user} deleted deposit ${depositId}`,
        meta: { depositIds: [depositId] },
        target: "ALL"
      });

      res.json({ success: true });
    });
  });
});

app.post("/api/edit-full", requirePermission("edit_transaction"), (req, res) => {
  const {
    id,
    ref,
    amount,
    agent,
    depositId,
    customer,
    date,
    agentNo,
    image
  } = req.body;

  const user = req.session.user.username;

  db.run(`
    UPDATE transactions SET
      transactionReference = ?,
      depositId = ?,
      agentName = ?,
      customerNumber = ?,
      amount = ?,
      depositDate = ?,
      agentNumber = ?,
      imageLink = ?
    WHERE id = ?
  `, [
    ref,
    depositId,
    agent,
    customer,
    amount,
    date,
    agentNo,
    image,
    id
  ], function (err) {

    if (err) return res.json({ success: false });

    if (this.changes === 0) {
      return res.json({ success: true });
    }

    addLog("INFO", `Edited transaction ${depositId}`, user);

    // 🔔 NOTIFICATION
    createNotification({
      type: "SYSTEM",
      title: "Deposit Updated",
      message: `${user} edited deposit ${depositId}`,
      meta: { depositIds: [depositId] },
      target: "ALL"
    });

    res.json({ success: true });
  });
});

app.post("/api/clean-empty", requirePermission("delete_transaction"), (req, res) => {
  const { confirm } = req.body;
  const user = req.session.user.username;

  if (confirm !== "YES") {
    return res.status(400).json({ error: "Confirmation required" });
  }

  // 🔥 GET affected rows first (optional but useful)
  db.all(`
    SELECT depositId FROM transactions
    WHERE 
      (transactionReference IS NULL OR TRIM(transactionReference) = '' OR LOWER(transactionReference) = 'null')
      AND
      (amount IS NULL OR TRIM(amount) = '' OR amount = 0)
  `, (err, rows) => {

    if (err) return res.json({ success: false });

    const depositIds = rows.map(r => r.depositId).filter(Boolean);

    // 🔥 DELETE
    db.run(`
      DELETE FROM transactions
      WHERE 
        (transactionReference IS NULL OR TRIM(transactionReference) = '' OR LOWER(transactionReference) = 'null')
        AND
        (amount IS NULL OR TRIM(amount) = '' OR amount = 0)
    `, function(err) {

      if (err) {
        console.error("❌ CLEAN ERROR:", err);
        return res.json({ success: false });
      }

      if (this.changes === 0) {
        return res.json({ success: true, deleted: 0 });
      }

      addLog("WARN", `Cleaned ${this.changes} empty transactions`, user);

      // 🔔 NOTIFICATION
      createNotification({
        type: "SYSTEM",
        title: "Clean Empty Data",
        message: `${user} deleted ${this.changes} empty transactions`,
        meta: { depositIds },
        target: "ALL"
      });

      res.json({
        success: true,
        deleted: this.changes
      });
    });
  });
});

app.post("/api/transactions/bulk-reject", requirePermission("reject_transactions"), (req, res) => {
  const { ids, reason } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "No valid IDs provided" });
  }

  if (!reason || !reason.trim()) {
    return res.status(400).json({ error: "Reason is required" });
  }

  const cleanIds = ids.map(id => parseInt(id)).filter(id => !isNaN(id));

  if (cleanIds.length === 0) {
    return res.status(400).json({ error: "Invalid IDs" });
  }

  const placeholders = cleanIds.map(() => "?").join(",");
  const user = req.session?.user?.username || "unknown";

  db.all(
    `SELECT id, depositId FROM transactions WHERE id IN (${placeholders})`,
    cleanIds,
    (err, rows) => {

      if (err) {
        console.error("❌ FETCH ERROR:", err);
        return res.json({ success: false });
      }

      const depositIds = rows.map(r => r.depositId);

      db.run(
        `UPDATE transactions 
         SET 
            agentStatus = 'NOT RECEIVED',
            actionStatus = 'REJECTED',
            reason = ?,
            settledBy = ?,
            settledAt = datetime('now', '+8 hours')
         WHERE id IN (${placeholders})
         AND actionStatus != 'REJECTED'`,
        [reason.trim(), user, ...cleanIds],
        function (err) {

          if (err) {
            console.error("❌ BULK REJECT ERROR:", err);
            addLog("ERROR", `Bulk reject failed: ${err.message}`, user);
            return res.json({ success: false });
          }

          if (this.changes === 0) {
            return res.json({ success: true, updated: 0 });
          }

          addLog("WARN", `Bulk rejected ${this.changes} transactions`, user);

          createNotification({
            type: "BULK",
            title: "Bulk Rejected",
            message: `${user} rejected ${this.changes} deposits`,
            meta: { depositIds },
            target: "ALL"
          });

          res.json({ success: true, updated: this.changes });
        }
      );
    }
  );
});

app.post("/api/transactions/bulk-delete", requirePermission("bulk_delete_transactions"), (req, res) => {
  const { ids } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "No valid IDs provided" });
  }

  const cleanIds = ids.map(id => parseInt(id)).filter(id => !isNaN(id));

  if (cleanIds.length === 0) {
    return res.status(400).json({ error: "Invalid IDs" });
  }

  const placeholders = cleanIds.map(() => "?").join(",");
  const user = req.session?.user?.username || "unknown";

  // 🔥 STEP 1: GET DEPOSIT IDS BEFORE DELETE
  db.all(
    `SELECT depositId FROM transactions WHERE id IN (${placeholders})`,
    cleanIds,
    (err, rows) => {

      if (err) {
        console.error("❌ FETCH ERROR:", err);
        return res.json({ success: false });
      }

      const depositIds = rows.map(r => r.depositId);

      // 🔥 STEP 2: DELETE
      db.run(
        `DELETE FROM transactions WHERE id IN (${placeholders})`,
        cleanIds,
        function (err) {

          if (err) {
            console.error("❌ BULK DELETE ERROR:", err);
            addLog("ERROR", `Bulk delete failed: ${err.message}`, user);
            return res.json({ success: false });
          }

          // 🔥 NO CHANGES
          if (this.changes === 0) {
            return res.json({ success: true, deleted: 0 });
          }

          addLog("WARN", `Bulk deleted ${this.changes} transactions`, user);

          // 🔔 NOTIFICATION
          createNotification({
            type: "BULK",
            title: "Bulk Deleted",
            message: `${user} deleted ${this.changes} deposits`,
            meta: { depositIds },
            target: "ALL"
          });

          res.json({
            success: true,
            deleted: this.changes
          });
        }
      );
    }
  );
});

app.get("/api/export/pending", requirePermission("export_transactions"), (req, res) => {

  const { smsMatched } = req.query;

  let query = `
    SELECT * FROM transactions
    WHERE (actionStatus NOT IN ('APPROVED','REJECTED') OR actionStatus IS NULL)
  `;

  // 🔥 APPLY FILTER
  if (smsMatched === "1") {
    query += " AND smsMatched = 1";
  }

  if (smsMatched === "0") {
    query += " AND (smsMatched = 0 OR smsMatched IS NULL)";
  }

  query += " ORDER BY id DESC";

  db.all(query, (err, rows) => {

    if (!rows || rows.length === 0) {
      return res.send("No data");
    }

    let csv = [
      "Brand,Agent,Deposit ID,Ref,Customer,Amount,Date,Agent No,Agent Answer,Reason,Confirmed By,Confirmed At,Sent,API"
    ];

    rows.forEach(r => {
      csv.push([
        r.brand,
        r.agentName,
        r.depositId,
        r.transactionReference,
        r.customerNumber,
        r.amount,
        r.depositDate,
        r.agentNumber,
        r.agentStatus,
        r.reason,
        r.confirmedBy,
        r.confirmedAt,
        r.sent ? "YES" : "NO",
        r.smsMatched ? "MATCHED" : "NONE" // 🔥 NEW COLUMN
      ].map(v => `"${v ?? ''}"`).join(","));
    });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=pending.csv");
    res.send(csv.join("\n"));
  });
});

app.get("/api/export/settled", requirePermission("export_transactions"), (req, res) => {
  const { from, to } = req.query;

  let query = `
    SELECT * FROM transactions
    WHERE actionStatus IN ('APPROVED','REJECTED')
  `;

  const params = [];

  if (from && to) {
    query += ` AND date(settledAt) BETWEEN date(?) AND date(?)`;
    params.push(from, to);
  }

  query += ` ORDER BY datetime(settledAt) DESC`;

  db.all(query, params, (err, rows) => {

    if (!rows || rows.length === 0) {
      return res.send("No data");
    }

    let csv = [
      "Brand,Agent,Deposit ID,Ref,Customer,Amount,Date,Agent No,Status,Agent Answer,Reason,Confirmed By,Confirmed At,Settled By,Settled At"
    ];

    rows.forEach(r => {
      csv.push([
        r.brand,
        r.agentName,
        r.depositId,
        r.transactionReference,
        r.customerNumber,
        r.amount,
        r.depositDate,
        r.agentNumber,
        r.actionStatus,
        r.agentStatus,
        r.reason,
        r.confirmedBy,
        r.confirmedAt,
        r.settledBy,
        r.settledAt
      ].map(v => `"${v ?? ''}"`).join(","));
    });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=settled.csv");
    res.send(csv.join("\n"));
  });
});

/////////////////Create Account//////////////////////
app.post("/api/register", requirePermission("create_users"), async (req, res) => {
  const currentUser = req.session.user;
  const { username, password, role } = req.body;

  if (!username || !password || !role) {
    return res.json({ success: false, message: "Missing fields" });
  }

  // 🔒 VALID ROLES ONLY
  const validRoles = ["user", "payment", "admin", "developer", "cs"];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ success: false, message: "Invalid role" });
  }

  if (currentUser.role !== "developer" && role === "developer") {
    return res.status(403).json({
      success: false,
      message: "Only developer can create developer accounts"
    });
  }

  try {
    const hash = await bcrypt.hash(password, 10);

    db.run(
      `INSERT INTO users (username, password, role) VALUES (?, ?, ?)`,
      [username, hash, role],
      function (err) {
        if (err) {
          addLog("ERROR", `Create user failed for ${username}: ${err.message}`, currentUser.username);
          return res.json({ success: false, message: "User exists" });
        }

        createNotification({
  type: "USER",
  title: "New User Created",
  message: `${currentUser.username} created ${username} (${role})`,
  target: "ALL"
});

        addLog("WARN", `User created (${username}, role ${role})`, currentUser.username);
        res.json({ success: true });
      }
    );

  } catch (err) {
    console.error("❌ REGISTER ERROR:", err);
    res.status(500).json({ success: false });
  }
});

function applyRoleUI(currentUser) {

  if (!currentUser || !currentUser.role) return;

  const roleSelect = document.getElementById("newRole");
  const createBtn = document.getElementById("createUserBtn");

  // 🔒 Admin cannot create developer
  if (currentUser.role === "admin" && roleSelect) {

    const devOption =
      roleSelect.querySelector('option[value="developer"]');

    if (devOption) {

      devOption.disabled = true;

      if (!devOption.dataset.modified) {
        devOption.textContent += " (restricted)";
        devOption.dataset.modified = "true";
      }

    }
  }

  // 🔒 admin cannot use dangerous actions
  if (currentUser.role === "admin") {

    const restrictedButtons = [
      "resetPendingBtn",
      "resetVideoBtn",
      "reconcileBtn"
    ];

    restrictedButtons.forEach(id => {

      const btn = document.getElementById(id);

      if (btn) {
        btn.style.display = "none";
      }

    });

  }

  // 🔒 hide create user button
  if (
    ["payment", "user", "cs"].includes(currentUser.role)
    && createBtn
  ) {
    createBtn.style.display = "none";
  }

  // 🔒 hide settings menu
  if (
    ["payment", "user", "cs"].includes(currentUser.role)
  ) {

    const settingsBtn =
      document.getElementById("settingsMenuBtn");

    if (settingsBtn) {
      settingsBtn.style.display = "none";
    }

  }

}

app.get("/api/users", requireAnyPermission([
  "view_page_users",
  "view_page_messages",
  "manage_users"
]), (req, res) => {

  db.all(`
    SELECT id, username, role, status, lastActive
    FROM users
  `, (err, rows) => {

    if (err) return res.json([]);

    res.json(rows);

  });

});

app.post("/api/user-role", requirePermission("change_roles"), (req, res) => {

  const currentUser = req.session.user;
  const { id, role } = req.body;

  // Only developer can assign developer.
  if (
    currentUser.role !== "developer" &&
    role === "developer"
  ) {
    return res.status(403).json({
      success: false,
      message: "Only developer can assign developer role"
    });
  }

  // Only developer can modify developer accounts.
  db.get(
    "SELECT role FROM users WHERE id=?",
    [id],
    (err, user) => {

      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found"
        });
      }

      if (
        currentUser.role !== "developer" &&
        user.role === "developer"
      ) {
        return res.status(403).json({
          success: false,
          message: "Only developer can modify developer account"
        });
      }

      db.run(
        "UPDATE users SET role=? WHERE id=?",
        [role, id],
        () => {
          addLog("WARN", `User role changed (ID ${id}, ${user.role} -> ${role})`, currentUser.username);
          res.json({ success: true });
        }
      );

    }
  );

});

app.post("/api/user-delete", requirePermission("delete_users"), (req, res) => {

  const currentUser = req.session.user;
  const { id } = req.body;

  // 🔍 get target user
  db.get(
    "SELECT role FROM users WHERE id=?",
    [id],
    (err, user) => {

      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found"
        });
      }

      // Only developer can delete developer accounts.
      if (
        currentUser.role !== "developer" &&
        user.role === "developer"
      ) {
        return res.status(403).json({
          success: false,
          message: "Only developer can delete developer"
        });
      }

      db.run(
        "DELETE FROM users WHERE id=?",
        [id],
        () => {
          addLog("WARN", `User deleted (ID ${id}, role ${user.role})`, currentUser.username);
          res.json({ success: true });
        }
      );

    }
  );

});

app.post("/api/change-password", async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ success: false });
  }

  const userId = req.session.user.id;
  const { currentPassword, newPassword } = req.body;

  db.get("SELECT * FROM users WHERE id=?", [userId], async (err, user) => {
    if (!user) return res.json({ success: false });

    const match = await bcrypt.compare(currentPassword, user.password);

    if (!match) {
      return res.json({ success: false, message: "Wrong password" });
    }

    const newHash = await bcrypt.hash(newPassword, 10);

    db.run(
      "UPDATE users SET password=? WHERE id=?",
      [newHash, userId],
      (err) => {
        if (err) return res.json({ success: false });

        createNotification({
  type: "USER",
  title: "Password Changed",
  message: `${req.session.user.username} changed password`,
  target: req.session.user.username
});

        addLog("WARN", "Password changed", req.session.user.username);
        res.json({ success: true });
      }
    );
  });
});

function getUserStatus(user) {
  if (!user.lastActive) return "OFFLINE";

  const diff = Date.now() - new Date(user.lastActive).getTime();

  return diff < 2 * 60 * 1000 ? "ONLINE" : "OFFLINE";
}

app.post("/api/user/status", requirePermission("manage_users"), (req, res) => {
  const { userId, status } = req.body;

  db.run(`
    UPDATE users SET status = ? WHERE id = ?
  `, [status, userId], () => {
    res.json({ success: true });
  });
});

async function updateUserStatus(id, status) {
  await fetch("/api/user/status", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ userId: id, status }),
    credentials: "include"
  });

  showToast("Status updated");
}

function updateLastActive(req, res, next) {
  console.log("SESSION:", req.session.user);

  if (req.session?.user?.id) {
    db.run(`
      UPDATE users SET lastActive = CURRENT_TIMESTAMP WHERE id = ?
    `, [req.session.user.id]);
  }

  next();
}

function checkAccountStatus(req, res, next) {
  if (!req.session?.user?.id) return next();

  db.get(
    "SELECT status FROM users WHERE id=?",
    [req.session.user.id],
    (err, user) => {
      if (user && (user.status === "LOCKED" || user.status === "DISABLED")) {
        return res.status(403).json({
          success: false,
          message: "Account disabled"
        });
      }
      next();
    }
  );
}

////////////////////////Reset DB transaction////////////////////////
app.post("/api/reset-transactions", requirePermission("reset_pending"), (req, res) => {
  const user = getLogUser(req);

  db.serialize(() => {
    db.run("DELETE FROM transactions", function (err) {
      if (err) {
        console.error("RESET PENDING ERROR:", err);
        addLog("ERROR", `Pending reset failed: ${err.message}`, user);
        return res.status(500).json({ success: false, message: err.message });
      }

      const deleted = this.changes || 0;

      db.run("DELETE FROM sqlite_sequence WHERE name='transactions'", (seqErr) => {
        if (seqErr) {
          console.error("RESET PENDING SEQUENCE ERROR:", seqErr);
          addLog("ERROR", `Pending reset sequence failed: ${seqErr.message}`, user);
          return res.status(500).json({ success: false, message: seqErr.message });
        }

        addLog("WARN", `Pending deposits reset (${deleted} rows deleted)`, user);
        res.json({ success: true, deleted });
      });
    });
  });
});

app.post("/api/reset-video-cases", requirePermission("reset_video_cases"), (req, res) => {
  const user = getLogUser(req);

  db.run(`DELETE FROM video_cases`, [], function (err) {
    if (err) {
      console.error("❌ RESET VIDEO ERROR:", err);
      addLog("ERROR", `Video reset failed: ${err.message}`, user);
      return res.status(500).json({ success: false, message: err.message });
    }

    console.log("🧹 All video cases deleted");

    createNotification({
  type: "SYSTEM",
  title: "System Reset",
  message: `${req.session.user.username} reset video cases`,
  target: "ALL"
});

    addLog("WARN", "Video cases reset", user);
    res.json({ success: true });
  });
});

app.get("/api/sync-status", requireAuth, (req, res) => {
  res.json({ syncing: isSyncing });
});
////////////////////////////Chat ID Page////////////////////////
app.post("/api/upload-chatids", requirePermission("manage_chat_ids"), upload.single("file"), (req, res) => {

  // 🔥 BLOCK IF PAUSED
  if (chatIdPaused) {
    return res.json({
      success: false,
      message: "⏸ Chat ID upload is paused"
    });
  }

  const results = [];

  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", (data) => results.push(data))
    .on("end", () => {

      const stmt = db.prepare(`
        INSERT INTO chat_ids (agentName, groupName, chatId)
        VALUES (?, ?, ?)
      `);

      results.forEach(row => {
        stmt.run([
          row["Agent"] || "",
          row["Group"] || "",
          row["Chat ID"] || ""
        ]);
      });

      stmt.finalize();
      fs.unlinkSync(req.file.path);

      console.log("✅ Chat IDs uploaded:", results.length);

      res.json({ success: true });
    });
});

app.post("/api/chatids/clean-duplicates", requirePermission("manage_chat_ids"), (req, res) => {
  db.all(`
    SELECT groupName, chatId, COUNT(*) as count
    FROM chat_ids
    GROUP BY groupName, chatId
    HAVING count > 1
  `, (err, rows) => {

    if (err) {
      console.error(err);
      return res.json({ success: false });
    }

    let totalDeleted = 0;

    const deleteNext = (index = 0) => {
      if (index >= rows.length) {
        return res.json({ success: true, deleted: totalDeleted });
      }

      const { groupName, chatId } = rows[index];

      // 🔥 get duplicates (keep 1)
      db.all(`
        SELECT id FROM chat_ids
        WHERE groupName = ? AND chatId = ?
        ORDER BY id ASC
      `, [groupName, chatId], (err, dupRows) => {

        if (!dupRows || dupRows.length <= 1) {
          return deleteNext(index + 1);
        }

        const idsToDelete = dupRows.slice(1).map(r => r.id);

        const placeholders = idsToDelete.map(() => "?").join(",");

        db.run(`
          DELETE FROM chat_ids
          WHERE id IN (${placeholders})
        `, idsToDelete, function () {

          totalDeleted += this.changes;
          deleteNext(index + 1);
        });

      });
    };

    deleteNext();
  });
});

app.post("/api/chatids", requirePermission("manage_chat_ids"), (req, res) => {

  // 🔥 BLOCK IF PAUSED
  if (chatIdPaused) {
    return res.json({
      success: false,
      message: "⏸ Chat ID saving is paused"
    });
  }

  const { agentName, groupName, chatId } = req.body;

  db.run(`
    INSERT INTO chat_ids (agentName, groupName, chatId)
    VALUES (?, ?, ?)
  `, [agentName, groupName, chatId], function(err) {

    if (err) {
      console.error(err);
      return res.json({ success: false });
    }

    res.json({ success: true });
  });
});

app.get("/api/chatids", requirePermission("view_page_chat_id"), (req, res) => {
  db.all("SELECT * FROM chat_ids ORDER BY id DESC", (err, rows) => {
    if (err) {
      console.error("❌ CHATIDS LOAD ERROR:", err);
      return res.status(500).json([]);
    }

    res.json(rows);
  });
});

////////////////////////////Dashboard Stats////////////////////////
app.get("/api/dashboard", requirePermission("view_page_dashboard"), (req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  db.serialize(() => {

    // ===== TOTAL =====
    db.get(`
      SELECT COUNT(*) as count
      FROM transactions
      WHERE actionStatus = 'PENDING'
    `, (err, pendingRow) => {

      db.get(`
        SELECT COUNT(*) as count
        FROM transactions
        WHERE actionStatus = 'PENDING'
        AND agentStatus IS NULL
      `, (err, agentPendingRow) => {

        db.get(`
          SELECT COUNT(*) as count
          FROM transactions
          WHERE actionStatus IN ('APPROVED','REJECTED')
        `, (err, settledRow) => {

          db.get(`
            SELECT COUNT(*) as count
            FROM transactions
            WHERE actionStatus = 'APPROVED'
          `, (err, approvedRow) => {

            db.get(`
              SELECT COUNT(*) as count
              FROM transactions
              WHERE actionStatus = 'REJECTED'
            `, (err, rejectedRow) => {

              // ===== TODAY =====
              db.get(`
                SELECT COUNT(*) as count
                FROM transactions
                WHERE actionStatus = 'PENDING'
                AND substr(depositDate,1,10) = ?
              `, [today], (err, pendingTodayRow) => {

                db.get(`
                  SELECT COUNT(*) as count
                  FROM transactions
                  WHERE actionStatus IN ('APPROVED','REJECTED')
                  AND substr(depositDate,1,10) = ?
                `, [today], (err, settledTodayRow) => {

                  // ===== TOTAL AMOUNT =====
                  db.get(`
                    SELECT SUM(amount) as total
                    FROM transactions
                  `, (err, amountRow) => {

                    // ===== BRAND =====
                    db.all(`
                      SELECT brand, COUNT(*) as count
                      FROM transactions
                      WHERE actionStatus = 'PENDING'
                      GROUP BY brand
                    `, (err, brandRows) => {

                      db.all(`
                        SELECT brand, COUNT(*) as count
                        FROM transactions
                        WHERE actionStatus = 'PENDING'
                        AND substr(depositDate,1,10) = ?
                        GROUP BY brand
                      `, [today], (err, brandTodayRows) => {

                        // ===== USERS =====
                        db.all(`SELECT * FROM users`, (err, users) => {

                          const activeUsers = users.filter(u => {
                            if (!u.lastActive) return false;
                            const last = new Date(new Date(u.lastActive).getTime() + (8 * 60 * 60 * 1000));
                            const diff = Date.now() - last.getTime();
                            return diff < 30 * 60 * 1000;
                          }).length;

                          // ===== AGENT ANSWERS =====
                          db.get(`
                            SELECT COUNT(*) as count
                            FROM transactions
                            WHERE agentStatus = 'RECEIVED'
                          `, (err, receivedRow) => {

                            db.get(`
                              SELECT COUNT(*) as count
                              FROM transactions
                              WHERE agentStatus = 'NOT RECEIVED'
                            `, (err, notReceivedRow) => {

                              // ✅ FINAL RESPONSE (ONLY ONCE)
                              res.json({
                                totalPending: pendingRow.count,
                                totalSettled: settledRow.count,
                                approved: approvedRow.count,
                                rejected: rejectedRow.count,
                                pendingToday: pendingTodayRow.count,
                                settledToday: settledTodayRow.count,
                                totalAmount: amountRow.total || 0,
                                agentPending: agentPendingRow.count,
                                brandStats: brandRows,
                                brandTodayStats: brandTodayRows,
                                activeUsers,
                                received: receivedRow.count,
                                notReceived: notReceivedRow.count
                              });

                            });

                          });

                        });

                      });

                    });

                  });

                });

              });

            });

          });

        });

      });

    });

  });
});

/////////////////////Balance & Wallet Monitor//////////////////////
app.get("/api/wallets/monitor", requireAnyPermission([
  "view_page_balance",
  "view_page_wallet_health",
  "wallet_health"
]), async (req, res) => {
  const {
    search = "",
    agentGroup = "",
    type = "",
    accountType = "",
    status = "",
    remarks = "",
    sortBy = "",
    order = "asc"
  } = req.query;

  const monitorSettings = await new Promise((resolve) => {
    db.get(`SELECT walletTypes, balanceTodaySource FROM settings WHERE id = 1`, (err, row) => {
      resolve(err ? {} : row || {});
    });
  });
  const todaySource = monitorSettings.balanceTodaySource === "wallet" ? "wallet" : "upload";
  const todayDepositSql = todaySource === "wallet"
    ? "COALESCE(wt.totalTodayDeposits, 0)"
    : "COALESCE(wda.totalTodayDeposits, 0)";
  const todayWithdrawalSql = todaySource === "wallet"
    ? "COALESCE(wt.totalTodayWithdrawals, 0)"
    : "COALESCE(wda.totalTodayWithdrawals, 0)";

  let query = `
    WITH wallet_totals AS (
      SELECT
        UPPER(TRIM(ownerName)) as normalizedShop,
        UPPER(TRIM(walletType)) as normalizedWalletType,
        SUM(COALESCE(todayDeposits, 0)) as totalTodayDeposits,
        SUM(COALESCE(todayWithdrawals, 0)) as totalTodayWithdrawals
      FROM wallets
      GROUP BY UPPER(TRIM(ownerName)), UPPER(TRIM(walletType))
    ),
    wallet_daily_activity_totals AS (
      SELECT
        normalizedOwnerName as normalizedShop,
        normalizedWalletType,
        SUM(CASE WHEN direction = 'deposit' THEN COALESCE(amount, 0) ELSE 0 END) as totalTodayDeposits,
        SUM(CASE WHEN direction = 'withdrawal' THEN COALESCE(amount, 0) ELSE 0 END) as totalTodayWithdrawals
      FROM wallet_daily_activity
      GROUP BY normalizedOwnerName, normalizedWalletType
    ),
    wallet_health_api AS (
      SELECT
        UPPER(TRIM(ownerName)) as normalizedShop,
        UPPER(TRIM(walletType)) as normalizedWalletType,
        SUM(COALESCE(apiBalance, 0)) as uploadedApiBalance
      FROM wallet_health
      GROUP BY UPPER(TRIM(ownerName)), UPPER(TRIM(walletType))
    )
    SELECT
      ob.shop as ownerName,
      COALESCE(NULLIF(w.walletType, ''), '-') as walletType,
      COALESCE(ob.openingBalance, 0) as openingBalance,
      ${todayDepositSql} as todayDeposits,
      ${todayWithdrawalSql} as todayWithdrawals,
      COALESCE(wha.uploadedApiBalance, 0) as apiBalance,
      COALESCE(ob.openingBalance, 0)
        + ${todayDepositSql}
        - ${todayWithdrawalSql} as balance,
      COALESCE(NULLIF(w.agentGroup, ''), '-') as agentGroup,
      COALESCE(NULLIF(w.accountType, ''), '-') as accountType,
      COALESCE(NULLIF(w.status, ''), '-') as status,
      COALESCE(w.depositPriority, 0) as depositPriority,
      COALESCE(w.withdrawalPriority, 0) as withdrawalPriority,
      COALESCE(w.depositDailyLimit, 0) as depositDailyLimit,
      COALESCE(w.withdrawalDailyLimit, 0) as withdrawalDailyLimit,
      COALESCE(NULLIF(w.remarks, ''), '-') as remarks,
      w.createdAt as createdAt
    FROM opening_balances ob
    LEFT JOIN wallets w
      ON UPPER(TRIM(w.ownerName)) = ob.normalizedShop
    LEFT JOIN wallet_totals wt
      ON wt.normalizedShop = ob.normalizedShop
      AND wt.normalizedWalletType = UPPER(TRIM(COALESCE(NULLIF(w.walletType, ''), '-')))
    LEFT JOIN wallet_daily_activity_totals wda
      ON wda.normalizedShop = ob.normalizedShop
      AND wda.normalizedWalletType = UPPER(TRIM(COALESCE(NULLIF(w.walletType, ''), '-')))
    LEFT JOIN wallet_health_api wha
      ON wha.normalizedShop = ob.normalizedShop
      AND wha.normalizedWalletType = UPPER(TRIM(COALESCE(NULLIF(w.walletType, ''), '-')))
    WHERE 1=1
  `;
  let params = [];

  // 🔍 search
  if (search.trim() !== "") {
    query += ` AND ob.shop LIKE ?`;
    params.push(`%${search.trim()}%`);
  }

  // 🎯 filters (ONLY if not empty)
  if (agentGroup) {
  query += ` AND w.agentGroup LIKE ?`;
  params.push(`%${agentGroup}%`);
}

  if (type) {
  query += ` AND w.walletType LIKE ?`;
  params.push(`%${type}%`);
}

  if (accountType) {
    query += ` AND w.accountType = ?`;
    params.push(accountType);
  }

  if (status) {
  query += ` AND w.status LIKE ?`;
  params.push(`%${status}%`);
}

  if (remarks.trim() !== "") {
    query += ` AND w.remarks LIKE ?`;
    params.push(`%${remarks.trim()}%`);
  }

  console.log("QUERY:", query);
  console.log("PARAMS:", params);

  // 🔃 sorting (SAFE whitelist)
  const allowedSort = [
    "ownerName", "agentGroup", "walletType",
    "accountType", "remarks", "status",
    "openingBalance", "todayDeposits", "todayWithdrawals", "balance"
  ];

  if (sortBy && allowedSort.includes(sortBy)) {
    query += ` ORDER BY ${sortBy} ${order === "desc" ? "DESC" : "ASC"}`;
  } else {
    query += ` ORDER BY ob.id ASC`;
  }

  const walletTypeMap = buildWalletTypeDisplayMap(monitorSettings.walletTypes);

  let settlementDeductions = new Map();
  try {
    settlementDeductions = await getSettlementSheetDeductions();
  } catch (err) {
    console.error("SETTLEMENT SHEET DEDUCTION ERROR:", err.message);
    addLog("WARN", `Settlement sheet deduction skipped: ${err.message}`);
  }

  db.all(query, params, (err, rows) => {
    if (err) {
      console.error("❌ WALLET MONITOR ERROR:", err);
      return res.json({ success: false });
    }

    const ownerBalances = new Map();

    rows.forEach(row => {
      const ownerKey = normalizeSheetKey(row.ownerName);
      const current = ownerBalances.get(ownerKey) || {
        openingBalance: Number(row.openingBalance || 0),
        todayDeposits: 0,
        todayWithdrawals: 0
      };

      current.todayDeposits += Number(row.todayDeposits || 0);
      current.todayWithdrawals += Number(row.todayWithdrawals || 0);
      current.balance = current.openingBalance + current.todayDeposits - current.todayWithdrawals;
      ownerBalances.set(ownerKey, current);
    });

    const data = rows.map(row => {
      const settlementKey = `${normalizeSheetKey(row.ownerName)}|${normalizeSheetKey(row.walletType)}`;
      const uploadedApiBalance = Number(row.apiBalance || 0);
      const sheetApiBalance = settlementDeductions.get(settlementKey) || 0;
      const apiBalance = uploadedApiBalance || sheetApiBalance;
      const displayWalletType = walletTypeMap.get(normalizeWalletTypeKey(row.walletType)) || row.walletType;
      const ownerBalance = ownerBalances.get(normalizeSheetKey(row.ownerName));

      return {
        ...row,
        walletType: displayWalletType,
        apiBalance,
        todayDeposits: Number(row.todayDeposits || 0),
        todayWithdrawals: Number(row.todayWithdrawals || 0),
        balance: Number(ownerBalance?.balance || 0)
      };
    });

    res.json({ success: true, data });
  });
});

app.post("/api/wallet/toggle", requirePermission("manage_wallets"), (req, res) => {
  const { id, action } = req.body;

  let newStatus = "";

  if (action === "OPEN_DP") newStatus = "DEPOSIT_ONLY";
  if (action === "OPEN_WD") newStatus = "WITHDRAW_ONLY";
  if (action === "FULL") newStatus = "ACTIVE";
  if (action === "CLOSE_ALL") newStatus = "INACTIVE";

  db.run(`
    UPDATE wallets
    SET status = ?
    WHERE id = ?
  `, [newStatus, id], function(err) {

    if (err) return res.json({ success: false });

    res.json({ success: true });
  });
});

///////////////////////ESS Status List//////////////////////
app.get("/api/ess-status", requirePermission("view_page_pending_deposits"), (req, res) => {
  db.all(`
    SELECT essStatus, COUNT(*) as count
    FROM transactions
    WHERE (actionStatus = 'PENDING' OR actionStatus IS NULL)
      AND essStatus IS NOT NULL
      AND essStatus != ''
    GROUP BY essStatus
    ORDER BY essStatus ASC
  `, (err, rows) => {
    if (err) {
      console.error(err);
      return res.json([]);
    }

    res.json(rows);
  });
});
//////////////////////Agent Filter List//////////////////////
app.get("/api/agent-prefix", requirePermission("view_page_pending_deposits"), (req, res) => {
  db.all(`
    SELECT
      SUBSTR(agentName, 1, INSTR(agentName, '-') - 1) as prefix,
      COUNT(*) as count
    FROM transactions
    WHERE (actionStatus = 'PENDING' OR actionStatus IS NULL)
    GROUP BY prefix
    ORDER BY count DESC
  `, (err, rows) => {
    if (err) return res.json([]);
    res.json(rows);
  });
});
///////////////////Video Case Page//////////////////////////////////////////////////////////////////////////////////////////////////////////////
app.post("/api/video-case", requirePermission("edit_transaction"), (req, res) => {
  const { ref, agent, customer, amount, date, video } = req.body;

  db.run(`
    INSERT INTO video_cases (
      transactionReference,
      agentName,
      customerNumber,
      amount,
      depositDate,
      videoLink,
      status,
      brand
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    ref,
    agent,
    customer,
    amount,
    date,
    video,
    "PENDING",
    "MANUAL"
  ], (err) => {
    if (err) {
      console.error("❌ INSERT ERROR:", err);
      return res.json({ success: false });
    }

    res.json({ success: true });
  });
});


// ===============================
// 📤 SEND SINGLE VIDEO CASE (LIKE PENDING)
// ===============================
app.post("/api/video/send", requirePermission("send_telegram"), async (req, res) => {
  const { ids } = req.body;

  if (!ids || !ids.length) {
    return res.json({ success: false, message: "No IDs provided" });
  }

  let successCount = 0;
  let failCount = 0;

  for (const id of ids) {
    try {
      const row = await new Promise((resolve) => {
        db.get(`SELECT * FROM video_cases WHERE id = ?`, [id], (err, r) => {
          resolve(r);
        });
      });

      if (!row || row.sent) {
        failCount++;
        continue;
      }

      const chatId = await getChat(row.agentName);

      // 🔥 CRITICAL CHECK
      if (!chatId) {
        console.log("❌ Missing chatId for:", row.agentName);
        failCount++;
        continue;
      }

      try {
        await sendVideoTelegram({
          chatId,
          id: row.id,
          transactionReference: row.transactionReference,
          amount: row.amount,
          agentName: row.agentName,
          imageLink: row.videoLink
        });

        // ✅ ONLY mark if success
        db.run(`UPDATE video_cases SET sent = 1 WHERE id = ?`, [id]);

        successCount++;

      } catch (err) {
        console.error("❌ TELEGRAM ERROR:", err.message);
        failCount++;
      }

    } catch (err) {
      console.error("❌ BULK SEND ERROR:", err.message);
      failCount++;
    }
  }

  res.json({
    success: true,
    successCount,
    failCount
  });
});


// ===============================
// 📊 GET VIDEO CASES
// ===============================
app.get("/api/video-case/filters", requirePermission("view_page_video_case"), (req, res) => {
  const pendingWhere = `
    WHERE (
      actionStatus IS NULL
      OR actionStatus = ''
      OR actionStatus = 'PENDING'
    )
  `;

  const response = { brands: [], agents: [] };

  db.all(`
    SELECT DISTINCT TRIM(brand) as brand
    FROM video_cases
    ${pendingWhere}
      AND brand IS NOT NULL
      AND TRIM(brand) != ''
    ORDER BY LOWER(TRIM(brand))
  `, [], (brandErr, brandRows) => {
    if (brandErr) {
      console.error("❌ VIDEO FILTER BRAND ERROR:", brandErr);
      return res.json(response);
    }

    response.brands = brandRows.map(row => row.brand);

    db.all(`
      SELECT DISTINCT TRIM(agentName) as agentName
      FROM video_cases
      ${pendingWhere}
        AND agentName IS NOT NULL
        AND TRIM(agentName) != ''
      ORDER BY LOWER(TRIM(agentName))
    `, [], (agentErr, agentRows) => {
      if (agentErr) {
        console.error("❌ VIDEO FILTER AGENT ERROR:", agentErr);
        return res.json(response);
      }

      response.agents = agentRows.map(row => row.agentName);
      res.json(response);
    });
  });
});

app.get("/api/video-case", requirePermission("view_page_video_case"), (req, res) => {
  const { search, brand, agent, status, sent } = req.query;

  let sql = `
  SELECT
      v.*,
      COALESCE(v.smsMatched,t.smsMatched,0) as smsMatched
  FROM video_cases v
  LEFT JOIN transactions t
      ON TRIM(v.transactionReference)
         = TRIM(t.transactionReference)
  WHERE (
    v.actionStatus IS NULL
    OR v.actionStatus = ''
    OR v.actionStatus = 'PENDING'
  )
`;

  const params = [];

  if (search) {

  sql += `
    AND (
      v.transactionReference LIKE ?
      OR v.agentName LIKE ?
    )
  `;

  params.push(
    `%${search}%`,
    `%${search}%`
  );
}

  if (brand) {
    sql += ` AND LOWER(TRIM(v.brand)) = LOWER(TRIM(?))`;
    params.push(brand);
  }

  if (agent) {
    sql += ` AND v.agentName = ?`;
    params.push(agent);
  }

  if (status === "PENDING") {
    sql += ` AND (v.agentStatus IS NULL OR v.agentStatus = '' OR v.agentStatus = 'PENDING')`;
  } else if (status === "ANSWERED") {
    sql += ` AND v.agentStatus IS NOT NULL AND v.agentStatus != '' AND v.agentStatus != 'PENDING'`;
  } else if (status) {
    sql += ` AND v.agentStatus = ?`;
    params.push(status);
  }

  if (sent !== undefined && sent !== "") {
    sql += ` AND v.sent = ?`;
    params.push(Number(sent));
  }

  sql += ` ORDER BY id DESC`;

  db.all(sql, params, (err, rows) => {
    if (err) return res.json([]);
    res.json(rows);
  });
});


// ===============================
// 🔄 SYNC VIDEO CASES
// ===============================
app.post("/api/sync-video", requirePermission("sync_sheets"), async (req, res) => {
  try {
    const { agentGroup, status } = req.body;

    const result = await syncSheets("video", {
      agentGroup,
      status
    });

    res.json({
      success: true,
      inserted: result?.inserted || 0
    });

  } catch (err) {
    console.error(err);
    res.json({ success: false, message: err.message });
  }
});


// ===============================
// 👥 ASSIGN + SEND
// ===============================
app.post("/api/video/assign-send", requirePermission("send_telegram"), async (req, res) => {
  const { ids, agent } = req.body;

  try {
    for (const id of ids) {

      // 🔄 assign first
      await new Promise((resolve) => {
        db.run(`UPDATE video_cases SET agentName = ? WHERE id = ?`, [agent, id], resolve);
      });

      // 📦 get updated row
      const row = await new Promise((resolve) => {
        db.get(`SELECT * FROM video_cases WHERE id = ?`, [id], (err, r) => {
          resolve(r);
        });
      });

      if (!row || row.sent) continue;

      const chatId = await getChat(agent);

      await sendTelegram({
        chatId,
        id: row.id,
        transactionReference: row.transactionReference,
        amount: row.amount,
        agentName: agent,
        customerNumber: row.customerNumber,
        imageLink: row.videoLink
      });

      db.run(`UPDATE video_cases SET sent = 1 WHERE id = ?`, [id]);
    }

    res.json({ success: true });

  } catch (err) {
    console.error("❌ ASSIGN SEND ERROR:", err);
    res.json({ success: false });
  }
});

app.post("/api/video/update", requireVideoUpdatePermission, (req, res) => {
  const { id, status, reason, username } = req.body;

  const actionStatus =
    status === "RECEIVED" ? "APPROVED" : "REJECTED";

  db.run(`
    UPDATE video_cases
    SET
      actionStatus = ?,
      reason = ?,
      settledBy = ?,
      settledAt = datetime('now', '+8 hours')
    WHERE id = ?
  `, [
    actionStatus,
    reason || "",
    username || "",
    id
  ], function (err) {

    if (err) {
      console.error(err);
      return res.status(500).json({ success: false });
    }

    res.json({ success: true });
  });
});

app.get("/api/video/settled", requirePermission("view_page_settled_video"), (req, res) => {
  const {
    search,
    confirmedFrom,
    confirmedTo,
    settledFrom,
    settledTo,
    agent,
    status
  } = req.query;

  let sql = `
    SELECT * FROM video_cases
    WHERE actionStatus IN ('APPROVED','REJECTED')
  `;

  const params = [];

  // 👤 AGENT
  if (agent) {
    sql += ` AND agentName = ?`;
    params.push(agent);
  }

  // 📊 APPROVED / REJECTED
  if (status) {
    sql += ` AND actionStatus = ?`;
    params.push(status);
  }

  if (search) {

  sql += `
    AND (
      transactionReference LIKE ?
      OR agentName LIKE ?
      OR depositId LIKE ?
      OR reason LIKE ?
    )
  `;

  params.push(
    `%${search}%`,
    `%${search}%`,
    `%${search}%`,
    `%${search}%`
  );
}

  // 📅 CONFIRMED
  if (confirmedFrom) {
    sql += ` AND date(confirmedAt) >= date(?)`;
    params.push(confirmedFrom);
  }

  if (confirmedTo) {
    sql += ` AND date(confirmedAt) <= date(?)`;
    params.push(confirmedTo);
  }

  // 📅 SETTLED
  if (settledFrom) {
    sql += ` AND date(settledAt) >= date(?)`;
    params.push(settledFrom);
  }

  if (settledTo) {
    sql += ` AND date(settledAt) <= date(?)`;
    params.push(settledTo);
  }

  sql += ` ORDER BY datetime(settledAt) DESC`;

  db.all(sql, params, (err, rows) => {
    if (err) {
      console.error(err);
      return res.json([]);
    }
    res.json(rows);
  });
});

app.get("/api/export/video", requirePermission("export_transactions"), (req, res) => {

  const { search, agent, status, brand } = req.query;

  let where = "WHERE 1=1";
  let params = [];

  // ❌ EXCLUDE SETTLED
  where += " AND (actionStatus IS NULL OR actionStatus NOT IN ('APPROVED','REJECTED'))";

  if (search) {
    where += " AND transactionReference LIKE ?";
    params.push(`%${search}%`);
  }

  if (agent) {
    where += " AND agentName = ?";
    params.push(agent);
  }

  if (status) {
    where += " AND agentStatus = ?";
    params.push(status);
  }

  if (brand) {
    where += " AND brand = ?";
    params.push(brand);
  }

  db.all(`
    SELECT *
    FROM video_cases
    ${where}
    ORDER BY id DESC
  `, params, (err, rows) => {

    if (err) {
      console.error("❌ VIDEO EXPORT ERROR:", err);
      return res.status(500).send("Error");
    }

    if (!rows || rows.length === 0) {
      return res.send("No data");
    }

    let csv = [
      "Brand,Agent,Deposit ID,Ref,Customer,Amount,Date,Agent No/Agent Answer,Reason/Confirmed By,Confirmed At"
    ];

    rows.forEach(r => {

      const agentAnswer = r.agentStatus || "";
      const reasonOrBy = r.reason
        ? r.reason
        : (r.confirmedBy || "");

      csv.push([
        r.brand || "VIDEO",
        r.agentName || "",
        r.depositId || "",
        r.transactionReference || "",
        r.customerNumber || "",
        r.amount || 0,
        r.depositDate || "",
        agentAnswer,
        reasonOrBy,
        r.confirmedAt || ""
      ].map(v => `"${v ?? ''}"`).join(","));

    });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=video_cases_pending.csv");
    res.send(csv.join("\n"));
  });

});

app.post("/api/video-cases/bulk-delete", requirePermission("bulk_delete_transactions"), (req, res) => {
  const { ids } = req.body;

  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: "No valid IDs provided" });
  }

  const cleanIds = ids.map(id => parseInt(id)).filter(id => !isNaN(id));

  if (cleanIds.length === 0) {
    return res.status(400).json({ error: "Invalid IDs" });
  }

  const placeholders = cleanIds.map(() => "?").join(",");
  const user = req.session?.user?.username || "unknown";

  db.run(
    `DELETE FROM video_cases WHERE id IN (${placeholders})`,
    cleanIds,
    function (err) {
      if (err) {
        console.error("❌ VIDEO CASE BULK DELETE ERROR:", err);
        addLog("ERROR", `Video case delete failed: ${err.message}`, user);
        return res.json({ success: false });
      }

      addLog("CRITICAL", `Deleted ${this.changes} video cases`, user);

      res.json({
        success: true,
        deleted: this.changes
      });
    }
  );
});

/////////////////////STATEMENT / API MATCHING FUNCTION///////////////////////////////////////////////////////////////////////////
app.post("/api/import-sms", requirePermission("edit_transaction"), upload.single("file"), (req, res) => {
  const user = getLogUser(req);
  const statementData = [];
  const separator = detectCsvSeparator(req.file.path);

  fs.createReadStream(req.file.path)
    .pipe(csv({ separator }))
    .on("data", (row) => {
      statementData.push({
        walletNumber: getCsvValue(row, [
          "Wallet Number",
          "Wallet No",
          "Wallet",
          "Wallet Account",
          "Wallet Account ID",
          "Wallet Account Id",
          "Sender / Recipient",
          "Sender/Recipient"
        ]),
        gatewayTransactionId: getCsvValue(row, [
          "Gateway Transaction ID",
          "Gateway Transaction Id",
          "Gateway Txn ID",
          "Gateway Txn Id",
          "Gateway txn id",
          "Gateway tx id",
          "Gateway Tx ID",
          "Gateway Tx Id",
          "Transaction ID",
          "Transaction Id"
        ]),
        amount: parseStatementAmount(getCsvValue(row, ["Amount"]))
      });
    })
    .on("end", () => {
      console.log("STATEMENT PARSED:", statementData.length);

      db.all(`
        SELECT id, transactionReference, amount, agentNumber, agentName
        FROM transactions
        WHERE actionStatus IS NULL OR actionStatus = 'PENDING'
      `, (err, pendingTransactions) => {
        if (err) {
          fs.unlink(req.file.path, () => {});
          console.error("DB ERROR:", err);
          addLog("ERROR", `Statement import DB load failed: ${err.message}`, user);
          return res.status(500).json({ success: false });
        }

        db.all(`
          SELECT id, transactionReference, amount, agentNumber, agentName
          FROM video_cases
          WHERE actionStatus IS NULL OR actionStatus = ''
        `, (videoErr, pendingVideoCases) => {
          if (videoErr) {
            fs.unlink(req.file.path, () => {});
            console.error("VIDEO DB ERROR:", videoErr);
            addLog("ERROR", `Statement import video load failed: ${videoErr.message}`, user);
            return res.status(500).json({ success: false });
          }

          const matchedIds = runStatementMatching(statementData, pendingTransactions);
          const matchedVideoIds = runStatementMatching(statementData, pendingVideoCases);

          db.serialize(() => {
            db.run(`
              UPDATE transactions
              SET smsMatched = 0
              WHERE actionStatus IS NULL OR actionStatus = 'PENDING'
            `, (err) => {
              if (err) {
                fs.unlink(req.file.path, () => {});
                console.error("STATEMENT MATCH RESET ERROR:", err);
                addLog("ERROR", `Statement match reset failed: ${err.message}`, user);
                return res.status(500).json({ success: false });
              }

              db.run(`
                UPDATE video_cases
                SET smsMatched = 0
                WHERE actionStatus IS NULL OR actionStatus = ''
              `, (videoResetErr) => {
                if (videoResetErr) {
                  fs.unlink(req.file.path, () => {});
                  console.error("VIDEO STATEMENT MATCH RESET ERROR:", videoResetErr);
                  addLog("ERROR", `Video statement match reset failed: ${videoResetErr.message}`, user);
                  return res.status(500).json({ success: false });
                }

                const stmt = db.prepare(`UPDATE transactions SET smsMatched = 1 WHERE id = ?`);
                const videoStmt = db.prepare(`UPDATE video_cases SET smsMatched = 1 WHERE id = ?`);

                matchedIds.forEach(id => stmt.run(id));
                matchedVideoIds.forEach(id => videoStmt.run(id));
                stmt.finalize((err) => {
                  videoStmt.finalize((videoFinalizeErr) => {
                    fs.unlink(req.file.path, () => {});

                    const updateErr = err || videoFinalizeErr;

                    if (updateErr) {
                      console.error("STATEMENT MATCH UPDATE ERROR:", updateErr);
                      addLog("ERROR", `Statement match update failed: ${updateErr.message}`, user);
                      return res.status(500).json({ success: false });
                    }

                    console.log("STATEMENT MATCHED:", matchedIds.length, "VIDEO:", matchedVideoIds.length);
                    addLog("INFO", `Statement import matched ${matchedIds.length} pending transactions and ${matchedVideoIds.length} video cases from ${statementData.length} rows`, user);

                    res.json({
                      success: true,
                      matched: matchedIds.length,
                      matchedVideo: matchedVideoIds.length,
                      totalSMS: statementData.length,
                      totalStatement: statementData.length,
                      savedSMS: 0
                    });
                  });
                });
              });
            });
          });
        });
      });
    })
    .on("error", (err) => {
      console.error("CSV ERROR:", err);
      addLog("ERROR", `Statement CSV import failed: ${err.message}`, user);
      fs.unlink(req.file.path, () => {});
      res.status(500).json({ success: false });
    });
});

function getCsvValue(row, names) {
  const normalized = Object.entries(row || {}).reduce((map, [key, value]) => {
    map[normalizeHeader(key)] = value;
    return map;
  }, {});

  for (const name of names) {
    const value = normalized[normalizeHeader(name)];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }

  return "";
}

function normalizeHeader(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function detectCsvSeparator(filePath) {
  try {
    const header = fs.readFileSync(filePath, "utf8").split(/\r?\n/, 1)[0] || "";
    const tabs = (header.match(/\t/g) || []).length;
    const commas = (header.match(/,/g) || []).length;
    return tabs > commas ? "\t" : ",";
  } catch (err) {
    return ",";
  }
}

function parseStatementAmount(value) {
  const amount = Number(String(value || "").replace(/[^\d.-]/g, "").trim());
  return Number.isFinite(amount) ? amount : 0;
}

app.get("/api/sms", requirePermission("view_page_sms"), (req, res) => {
  const page = Number(req.query.page) || 1;
  const search = (req.query.search || "").trim();
  const limit = 20;
  const offset = (page - 1) * limit;

  let where = "WHERE smsMatched = 1";
  let params = [];

  if (search) {
    where += `
      AND (
        agentName LIKE ?
        OR agentNumber LIKE ?
        OR transactionReference LIKE ?
      )
    `;
    const like = `%${search}%`;
    params.push(like, like, like);
  }

  db.all(`
    SELECT
      id,
      agentName,
      agentNumber as walletNumber,
      transactionReference as gatewayTransactionId,
      amount,
      depositId,
      COALESCE(actionStatus, 'PENDING') as status
    FROM transactions
    ${where}
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `, [...params, limit, offset], (err, rows) => {

    if (err) return res.json({ data: [], totalPages: 1 });

    db.get(`
      SELECT COUNT(*) as total FROM transactions
      ${where}
    `, params, (err2, countRow) => {

      const total = countRow?.total || 0;
      const totalPages = Math.ceil(total / limit);

      res.json({
        data: rows,
        totalPages
      });
    });

  });
});

app.post("/api/rematch-sms", requirePermission("edit_transaction"), (req, res) => {

  const io = getIO();

  // 🔄 loading start
  io.emit("rematch-status", { loading: true });

  db.all(`SELECT * FROM sms_logs`, (err, smsData) => {

    if (err) {
      io.emit("rematch-status", { loading: false });
      return res.json({ success: false });
    }
    if (!smsData.length) {
      io.emit("rematch-status", {
        loading: false,
        done: true,
        matched: 0
      });

      return res.json({
        success: true,
        matched: 0,
        message: "No saved statement rows to re-match. Upload a statement CSV to match pending transactions."
      });
    }

    // 🔥 GET ALL TRANSACTIONS (NOT JUST PENDING)
    db.all(`
      SELECT id, transactionReference, amount, agentNumber, agentName
      FROM transactions
      WHERE actionStatus IS NULL OR actionStatus = 'PENDING'
    `, (err, allTransactions) => {

      if (err) {
        io.emit("rematch-status", { loading: false });
        return res.json({ success: false });
      }

      // 🔥 MATCH
      const matchedIds = runStatementMatching(smsData, allTransactions);

      const stmt = db.prepare(`
        UPDATE transactions SET smsMatched = 1 WHERE id = ?
      `);

      matchedIds.forEach(id => stmt.run(id));
      stmt.finalize();

      io.emit("rematch-status", {
        loading: false,
        done: true,
        matched: matchedIds.length
      });

      res.json({
        success: true,
        matched: matchedIds.length
      });

    });

  });

});

// 🔥 MATCHING FUNCTION (REUSABLE)
function runStatementMatching(statementData, pending) {
  const cleanText = (v) => String(v || "").trim().toUpperCase();
  const cleanRef = (v) => cleanText(v).replace(/^="?|"?$/g, "").replace(/[^A-Z0-9]/g, "");
  const cleanWallet = (v) => cleanText(v).replace(/^="?|"?$/g, "").replace(/\D/g, "");

  const walletVariants = (value) => {
    const wallet = cleanWallet(value);
    if (!wallet) return [];

    const variants = new Set([wallet]);
    const withoutLeadingZeroes = wallet.replace(/^0+/, "");

    if (withoutLeadingZeroes) variants.add(withoutLeadingZeroes);
    if (wallet.length > 10) variants.add(wallet.slice(-10));

    return [...variants];
  };

  const statementIndex = new Set();

  statementData.forEach(s => {
    const amount = Number(s.amount);
    const wallets = walletVariants(s.walletNumber);

    if (!amount || !wallets.length) return;

    const ref = cleanRef(s.gatewayTransactionId);
    if (!ref) return;

    wallets.forEach(walletNumber => {
      statementIndex.add(`${ref}|${amount}|${walletNumber}`);
    });
  });

  const matchedIds = new Set();

  pending.forEach(p => {
    const amount = Number(p.amount);
    const wallets = walletVariants(p.agentNumber);

    if (!amount || !wallets.length) return;

    const ref = cleanRef(p.transactionReference);
    if (!ref) return;

    const isMatched = wallets.some(walletNumber =>
      statementIndex.has(`${ref}|${amount}|${walletNumber}`)
    );

    if (isMatched) matchedIds.add(p.id);
  });

  return [...matchedIds];
}
app.delete("/api/sms/reset", requirePermission("reset_pending"), (req, res) => {
  const user = getLogUser(req);

  db.serialize(() => {

    // Clear legacy statement/SMS logs if the old table exists.
    db.run(`DELETE FROM sms_logs`, function (err) {
      if (err) {
        console.log("Legacy statement log clear skipped:", err.message);
        return;
      }

      console.log("Statement data cleared:", this.changes);
    });

    // 🔥 RESET EVERYTHING (NO WHERE)
    db.run(`UPDATE transactions SET smsMatched = 0`, function (err) {
      if (err) {
        console.error("❌ RESET MATCH ERROR:", err);
        addLog("ERROR", `API match reset failed: ${err.message}`, user);
        return res.status(500).json({ success: false });
      }

      console.log("🔄 ALL smsMatched reset:", this.changes);
    });

    db.run(`UPDATE video_cases SET smsMatched = 0`, function (err) {
      if (err) {
        console.error("VIDEO RESET MATCH ERROR:", err);
        addLog("ERROR", `Video API match reset failed: ${err.message}`, user);
        return res.status(500).json({ success: false });
      }

      console.log("ALL video smsMatched reset:", this.changes);
    });

  });

  addLog("WARN", "Statement reset cleared logs and all transaction/video API matches", user);
  res.json({
    success: true,
    message: "Statement cleared + ALL API matches reset"
  });

});

//////////////////////////////////////////////////////////////message webhook//////////////////////////////////////
app.post("/api/message", requirePermission("view_page_messages"), (req, res) => {
  const { message, target } = req.body;
  const sender = req.session.user.username;
  const cleanMessage = String(message || "").trim();

  if (!cleanMessage) {
    return res.status(400).json({ success: false, message: "Message is required" });
  }

  const receiver = target === "ALL" ? "ALL" : target;

  db.run(
    `
    INSERT INTO messages (sender, receiver, message)
    VALUES (?, ?, ?)
  `,
    [sender, receiver, cleanMessage],
    function (err) {
      if (err) {
        console.error("MESSAGE INSERT ERROR:", err.message);
        return res.status(500).json({ success: false, message: "Message save failed" });
      }

      const payload = {
        sender,
        receiver,
        message: cleanMessage,
        createdAt: new Date()
      };

      const io = getIO();

      // 📡 SOCKET MESSAGE
      if (receiver === "ALL") {
        io.emit("receive-message", payload);
      } else {
        io.to(receiver).emit("receive-message", payload);
        io.to(sender).emit("receive-message", payload);
      }

      // 🔔 NOTIFICATION (🔥 NEW)
      createNotification({
        type: "MESSAGE",
        title: "New Message",
        message:
          receiver === "ALL"
            ? `${sender} sent a message to ALL`
            : `${sender} → ${receiver}`,
        meta: { text: cleanMessage },
        target: receiver === "ALL" ? "ALL" : receiver
      });

      res.json({ success: true });
    }
  );
});

app.get("/api/messages", requirePermission("view_page_messages"), (req, res) => {
  const user = req.session.user.username;

  db.all(`
    SELECT * FROM messages
    WHERE receiver = 'ALL'
       OR receiver = ?
       OR sender = ?
    ORDER BY datetime(createdAt) ASC, id ASC
    LIMIT 100
  `, [user, user], (err, rows) => {

    if (err) {
      return res.status(500).json([]);
    }

    res.json(rows);
  });
});

////////////////////////////////////////////////NOTIFICATION FUNCTION//////////////////////////
function createNotification({ type, title, message, meta = {}, target = "ALL" }) {
  const io = getIO();

  db.run(
    `
    INSERT INTO notifications (type, title, message, meta)
    VALUES (?, ?, ?, ?)
  `,
    [type, title, message, JSON.stringify(meta)],
    function (err) {
      if (err) {
        console.error("❌ Notification insert failed:", err);
        addLog("ERROR", `Notification insert failed (${type || "unknown"}): ${err.message}`);
        return;
      }

      const payload = {
        id: this.lastID,
        type,
        title,
        message,
        meta,
        target,
        createdAt: new Date()
      };

      // 🎯 TARGETING
      if (target === "ALL") {
        io.emit("new-notification", payload);
      } else {
        io.to(target).emit("new-notification", payload);
      }
    }
  );
}

//////////////////////////////////////////////////////////////////GSHEET UPDATE SELECTED///////////////////////////////////////////////////////////////////////////////

const { updateStatusBulk } = require("./gsheet");

app.post("/api/gsheet/update-selected", requirePermission("sync_sheets"), async (req, res) => {

  const { ids } = req.body;
  const user = req.session.user.username;

  if (!ids || !ids.length) {
    return res.json({ success: false });
  }

  const placeholders = ids.map(() => "?").join(",");

  db.all(
    `SELECT 
      id,
      transactionReference as ref, 
      actionStatus as status, 
      reason, 
      brand,
      gsheetStatus
     FROM transactions 
     WHERE id IN (${placeholders})
       AND (gsheetStatus IS NULL OR gsheetStatus != 'SUCCESS')`,
    ids,
    async (err, rows) => {

      if (err) {
        console.error(err);
        return res.json({ success: false });
      }

      const selectedIds = ids.map(id => Number(id));
      const selectedIdSet = new Set(selectedIds);
      const rowsById = new Set((rows || []).map(row => Number(row.id)));
      const alreadyUpdatedIds = selectedIds.filter(id => !rowsById.has(id));

      let updateResult;
      const successIds = [];
      const failedIds = [];
      const skippedIds = [...alreadyUpdatedIds];

      // ✅ process one by one
      if (false) {

        try {

          await Promise.resolve();

          successIds.push(row.id);

          console.log(`✅ Success: ${row.id}`);

        } catch (e) {

          failedIds.push(row.id);

          console.error(`❌ Failed: ${row.id}`, e.message);
        }
      }

      // ✅ UPDATE SUCCESS ROWS
      try {
        updateResult = await updateStatusBulk(rows, user);
        successIds.push(...(updateResult.successIds || []));
        failedIds.push(...(updateResult.failedIds || []));
        skippedIds.push(...(updateResult.skippedIds || []));
      } catch (e) {
        console.error("Bulk GSheet update failed:", e.message);
        failedIds.push(...(rows || []).map(row => row.id));
      }

      const uniqueSkippedIds = [...new Set(skippedIds.map(id => Number(id)))]
        .filter(id => selectedIdSet.has(id));

      if (successIds.length) {

        const successPlaceholders = successIds.map(() => "?").join(",");

        db.run(
          `UPDATE transactions
           SET 
             gsheetUpdated = 1,
             gsheetStatus = 'SUCCESS'
           WHERE id IN (${successPlaceholders})`,
          successIds
        );
      }

      // ✅ UPDATE FAILED ROWS
      if (failedIds.length) {

        const failedPlaceholders = failedIds.map(() => "?").join(",");

        db.run(
          `UPDATE transactions
           SET 
             gsheetUpdated = 0,
             gsheetStatus = 'FAILED'
           WHERE id IN (${failedPlaceholders})`,
          failedIds
        );
      }

      res.json({
        success: true,
        successIds,
        failedIds,
        skippedIds: uniqueSkippedIds
      });

    }
  );

});
//////////////////////////////////////////////////////////////////SETTLEMENT REPORTS//////////////////////////
app.get("/api/settlement", requirePermission("view_page_settlement"), (req, res) => {

  db.all(`
    SELECT *
    FROM settlement_reports
    ORDER BY date DESC
  `, [], (err, rows) => {

    if (err) {
      console.error(err);
      return res.json([]);
    }

    res.json(rows);

  });

});
