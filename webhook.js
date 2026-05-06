require("dotenv").config();
const express = require("express");
const path = require("path");
const session = require("express-session");
const { requireAuth, requireAdmin, requireDeveloper, requireAdminOrDev } = require("./middleware/auth");
const bcrypt = require("bcrypt");
const { decryptAES, generateMark } = require("./crypto");
const { sendTelegram, sendVideoTelegram, bot } = require("./bot");
const db = require("./db");
const now = new Date().toISOString();
const { updateStatusByRef } = require("./gsheet");
const activeRefs = {}; 

const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");

const upload = multer({ dest: "uploads/" });

const app = express();
app.use(express.json());

const { syncSheets } = require("./sync");
const { getIO } = require("./socket");
let isSyncing = false;
let chatIdPaused = false;


let appSettings = {};

function loadSettings() {
  db.get(`SELECT * FROM settings WHERE id = 1`, (err, row) => {
    if (row) {
      appSettings = row;
      console.log("⚙️ Settings loaded");
    }
  });
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

app.post("/api/resend-telegram", requireAuth, (req, res) => {
  const { id } = req.body;

  if (activeRefs[id]) {
    return res.json({ success: false, message: "Already sending" });
  }

  activeRefs[id] = true;

  db.get(`SELECT * FROM transactions WHERE id = ?`, [id], (err, row) => {
    if (err || !row) {
      delete activeRefs[id];
      return res.status(404).json({ success: false });
    }

    try {
      sendToTelegram(
        row.agentName,
        {
          transactionReference: row.transactionReference,
          customerNumber: row.customerNumber,
          image: row.imageLink
        },
        row.amount,
        row.id
      );

      db.run(`UPDATE transactions SET sent = 1 WHERE id = ?`, [id]);

      res.json({ success: true });

    } catch (err) {
      console.error("❌ RESEND ERROR:", err.message);
      res.status(500).json({ success: false });
    } finally {
      setTimeout(() => delete activeRefs[id], 5000);
    }
  });
});

// 🧪 TEST ROUTE
app.get("/test", async (req, res) => {
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
app.get("/api/transactions", requireAuth, (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;

  const brand = req.query.brand;
  const essStatus = req.query.essStatus;
  const search = req.query.search;
  const status = req.query.status;
  const agentPrefix = req.query.agentPrefix;
  const sent = req.query.sent;
  const smsMatched = req.query.smsMatched;

  let where = `WHERE 1=1`;
  const params = [];

  if (brand) {
    where += ` AND brand = ?`;
    params.push(brand);
  }

  if (essStatus) {
    where += ` AND essStatus = ?`;
    params.push(essStatus);
  }

  if (search) {
    where += ` AND transactionReference LIKE ?`;
    params.push(`%${search}%`);
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

    db.all(`
      SELECT * FROM transactions
      ${where}
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset], (err, rows) => {

      res.json({
        data: rows,
        total: countRow.total,
        totalPages: Math.ceil(countRow.total / limit)
      });

    });
  });
});

// 🔄 Sync
app.post("/api/sync", requireAuth, async (req, res) => {
  const { mode = "all" } = req.body;
  const user = req.session.user;

  // 🔒 role restriction
  if (!["admin", "developer"].includes(user.role)) {
    return res.status(403).json({
      success: false,
      error: "Access denied"
    });
  }

  // 🔥 admin cannot run FULL sync
  if (user.role === "admin" && mode === "all") {
    return res.status(403).json({
      success: false,
      error: "Admin cannot run full sync"
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

    res.json({ success: true });

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

app.get("/api/brands", (req, res) => {
  db.all(`
    SELECT DISTINCT brand 
    FROM transactions
    WHERE brand IS NOT NULL AND brand != ''
  `, (err, rows) => {
    if (err) return res.json([]);

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
  console.log(`🚀 Server running on port ${process.env.PORT}`);
});

app.post("/api/update", requireAdmin, async (req, res) => {
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

    res.json({ success: true });

  } catch (err) {
    console.log("❌ UPDATE ERROR:", err.message);

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

app.post("/api/upload-wallet", upload.single("file"), (req, res) => {
  const results = [];

  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", (data) => results.push(data))
    .on("end", () => {

        

      const stmt = db.prepare(`
INSERT INTO wallets (
  walletAccountId, walletId, walletType, ownerName,
  accountType, network, currency, balance, status,
  agentGroup, depositDailyLimit, withdrawalDailyLimit,
  todayDeposits, todayWithdrawals,
  depositPriority, withdrawalPriority,
  remarks, createdAt
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  row["Balance"] || 0,
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

      

      stmt.finalize();
      fs.unlinkSync(req.file.path);

      console.log("✅ Wallets uploaded:", results.length);

      res.json({ success: true });

      
    });
});


app.get("/api/wallets", requireAuth, (req, res) => {
  db.all(`
    SELECT * FROM wallets ORDER BY id DESC
  `, (err, rows) => {
    if (err) return res.status(500).json([]);
    res.json(rows);
  });
});

app.delete("/api/wallet/reset", requireAuth, (req, res) => {
  db.run(`DELETE FROM wallets`, function (err) {
    if (err) {
      console.error("❌ WALLET RESET ERROR:", err);
      return res.status(500).json({ success: false });
    }

    res.json({
      success: true,
      deleted: this.changes
    });
  });
});

app.delete("/api/chatids/:id", requireAdminOrDev, (req, res) => {
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

      res.json({ success: true });
    });
  });
});

//////////////////Settled & Revert API////////////////////
app.get("/api/settled", requireAuth, (req, res) => {

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
    query += ` AND (transactionReference LIKE ? OR agentName LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`);
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

  // 📅 DATE (default = TODAY)
  if (startDate && endDate) {
    query += ` AND date(settledAt) BETWEEN date(?) AND date(?)`;
    params.push(startDate, endDate);
  } else {
    query += ` AND date(settledAt) = date('now', '+8 hours')`;
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

app.post("/api/revert", requireAdmin, (req, res) => {
  const { id } = req.body;

  db.run(`
    UPDATE transactions
    SET 
      actionStatus = 'PENDING',
      agentStatus = NULL,
      reason = NULL,
      confirmedBy = NULL
    WHERE id = ?
  `, [id]);

  res.json({ success: true });
});

app.post("/api/manual-add", requireAuth, (req, res) => {
  const {
    ref,
    amount,
    agent,
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
    "MANUAL"
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

app.post("/api/edit", requireAuth, (req, res) => {
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

  const parts = groupName.split("-");

  if (parts.length < 3) return null;

  const agent = parts[2].replace(/[0-9]/g, "");

  return `${parts[0]}-${parts[1]}-${agent}`;
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
      `SELECT chatId FROM chat_ids WHERE groupName = ? LIMIT 1`,
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
app.post("/api/settings", requireDeveloper, (req, res) => {
  const { 
    botToken, 
    googleApi, 
    gsheetLink, 
    sheetNames,
    videoGsheetLink,
    videoSheetNames
  } = req.body;

  if (!botToken || !gsheetLink) {
    return res.json({ success: false, message: "Invalid settings" });
  }

  db.run(`
    INSERT INTO settings (
      id, botToken, googleApi, gsheetLink, sheetNames,
      videoGsheetLink, videoSheetNames
    )
    VALUES (1, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      botToken = excluded.botToken,
      googleApi = excluded.googleApi,
      gsheetLink = excluded.gsheetLink,
      sheetNames = excluded.sheetNames,
      videoGsheetLink = excluded.videoGsheetLink,
      videoSheetNames = excluded.videoSheetNames
  `, [
    botToken,
    googleApi,
    gsheetLink,
    sheetNames,
    videoGsheetLink,
    videoSheetNames
  ]);

  loadSettings();
  res.json({ success: true });
});

app.get("/api/settings", (req, res) => {
  db.get(`SELECT * FROM settings WHERE id = 1`, (err, row) => {
    res.json(row || {});
  });
});

app.post("/api/reconcile", requireDeveloper, async (req, res) => {
  try {
    console.log("🧠 Manual reconcile started...");

    const result = await syncSheets(true); // let sync return stats

    res.json({
      success: true,
      fixed: result?.fixed || 0,
      inserted: result?.inserted || 0
    });

  } catch (err) {
    console.error("❌ RECONCILE ERROR:", err);
    res.status(500).json({ success: false });
  }
});

app.get("/api/agent-performance", requireAuth, (req, res) => {
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

app.get("/api/agent-performance-today", requireAuth, (req, res) => {

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

app.get("/api/dashboard/settled-stats", requireAuth, (req, res) => {
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

app.get("/api/logs", requireAuth, (req, res) => {
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

app.delete("/api/logs", requireDeveloper, (req, res) => {
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
function addLog(level, message) {
  db.run(`
    INSERT INTO system_logs (level, message)
    VALUES (?, ?)
  `, [level, message]);

  try {
    const io = getIO();
    io?.emit("log", {
      level,
      message,
      time: new Date().toISOString()
    });
  } catch {}
}

// run every hour
setInterval(autoCleanLogs, 60 * 60 * 1000);

app.post("/api/log-settings", requireAuth, (req, res) => {
  const { chatId, password } = req.body;

  db.run(`
    INSERT OR REPLACE INTO log_settings (id, chatId, password)
    VALUES (1, ?, ?)
  `, [chatId, password]);

  res.json({ success: true, message: "Log settings saved" });
});

app.post("/api/send-logs", requireAuth, async (req, res) => {
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

        res.json({ success: false, message: "Telegram failed" });
      }
    });
  });
});

app.post("/api/log-access", requireAuth, async (req, res) => {
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
      return res.json({ success: false });
    }

    res.json({ success: true });
  });
});

app.post("/api/log-settings-secure", requireAuth, async (req, res) => {
  const { chatId, password } = req.body;
  const userId = req.session.user.id;

  db.get(`SELECT * FROM log_settings WHERE id = 1`, async (err, row) => {

    // 🆕 FIRST TIME → set owner
    if (!row) {
      const hash = await bcrypt.hash(password, 10);

      db.run(`
        INSERT INTO log_settings (id, chatId, passwordHash, ownerId, locked)
        VALUES (1, ?, ?, ?, 1)
      `, [chatId, hash, userId]);

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
        return res.json({ success: false });
      }

      const match = await bcrypt.compare(password, user.password);

      if (!match) {
        return res.json({ success: false });
      }

      req.session.user = {
        id: user.id,
        username: user.username,
        role: user.role
      };
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
app.post("/api/assign-group", requireAdmin, (req, res) => {
  const { id, chatId } = req.body;

  db.get(`SELECT * FROM transactions WHERE id = ?`, [id], async (err, row) => {
    if (!row) return res.json({ success: false });

    try {
      const result = await processSend(row, chatId);

      if (!result.success) {
        return res.json(result);
      }

      db.run(`UPDATE transactions SET sent = 1 WHERE id = ?`, [id]);

      res.json({ success: true });

    } catch (err) {
      console.log("❌ Manual send error:", err.message);
      res.json({ success: false });
    }
  });
});

app.post("/api/send/:id", requireAuth, async (req, res) => {
  const id = req.params.id;
  const user = req.session.user;

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
      const result = await processSend(row);

      if (!result.success) {
        return res.json(result);
      }

      db.run(`
        UPDATE transactions
        SET
          sent = 1,
          confirmedAt = COALESCE(confirmedAt, datetime('now', '+8 hours')),
          reason = NULL
        WHERE id = ?
      `, [id]);

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

function processSend(row, overrideChatId = null) {
  return (async () => {
    const chatId = overrideChatId || await getChat(row.agentName);

    if (!chatId) {
      return { success: false, message: "No chatId found" };
    }

    const result = await sendTelegram({
      chatId,
      id: row.id,
      transactionReference: row.transactionReference,
      amount: row.amount,
      agentName: row.agentName,
      customerNumber: row.customerNumber,
      imageLink: row.imageLink
    });

    if (!result) {
      return { success: false, message: "Telegram send failed" };
    }

    return { success: true };
  })();
}

if (chatIdPaused) {
  console.log("⏸ Chat ID detection paused");
  return res.sendStatus(200);
}

app.post("/api/chatid/toggle", (req, res) => {
  chatIdPaused = !chatIdPaused;

  res.json({ paused: chatIdPaused });
});

app.get("/api/chatid/status", (req, res) => {
  res.json({ paused: chatIdPaused });
});


////////////////////Pending Delete,Edit,//////////////////
app.post("/api/delete", requireAdminOrDev, (req, res) => {
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

app.post("/api/edit-full", requireAdmin, (req, res) => {
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

app.post("/api/clean-empty", requireAdminOrDev, (req, res) => {
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

app.post("/api/transactions/bulk-reject", requireAdminOrDev, (req, res) => {
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

  // 🔥 STEP 1: GET REAL DEPOSIT IDS
  db.all(
    `SELECT id, depositId FROM transactions WHERE id IN (${placeholders})`,
    cleanIds,
    (err, rows) => {

      if (err) {
        console.error("❌ FETCH ERROR:", err);
        return res.json({ success: false });
      }

      const depositIds = rows.map(r => r.depositId);

      // 🔥 STEP 2: UPDATE
      db.run(
        `UPDATE transactions 
         SET 
            agentStatus = 'NOT RECEIVED',
            actionStatus = 'REJECTED',
            reason = 'Bulk rejected',
            settledBy = ?,
            settledAt = datetime('now', '+8 hours')
         WHERE id IN (${placeholders})
         AND actionStatus != 'REJECTED'`,
        [user, ...cleanIds],
        function (err) {

          if (err) {
            console.error("❌ BULK REJECT ERROR:", err);
            addLog("ERROR", `Bulk reject failed: ${err.message}`, user);
            return res.json({ success: false });
          }

          // 🔥 NO CHANGES (avoid useless notif)
          if (this.changes === 0) {
            return res.json({ success: true, updated: 0 });
          }

          addLog("WARN", `Bulk rejected ${this.changes} transactions`, user);

          // 🔔 NOTIFICATION
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

app.post("/api/transactions/bulk-delete", requireAdminOrDev, (req, res) => {
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

app.get("/api/export/pending", requireAuth, (req, res) => {

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
      "Brand,Agent,Deposit ID,Ref,Customer,Amount,Date,Agent No,Agent Answer,Reason,Confirmed By,Confirmed At,Sent,SMS"
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

app.get("/api/export/settled", requireAuth, (req, res) => {
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
app.post("/api/register", requireAuth, async (req, res) => {
  const currentUser = req.session.user;
  const { username, password, role } = req.body;

  if (!username || !password || !role) {
    return res.json({ success: false, message: "Missing fields" });
  }

  // 🔒 VALID ROLES ONLY
  const validRoles = ["user", "admin", "developer"];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ success: false, message: "Invalid role" });
  }

  // 🔒 ROLE PERMISSION LOGIC
  if (currentUser.role === "developer") {
    // ✅ full access
  } else if (currentUser.role === "admin") {
    if (role === "developer") {
      return res.status(403).json({
        success: false,
        message: "Admin cannot create developer"
      });
    }
  } else {
    // ❌ user cannot create anything
    return res.status(403).json({
      success: false,
      message: "User not allowed to create accounts"
    });
  }

  try {
    const hash = await bcrypt.hash(password, 10);

    db.run(
      `INSERT INTO users (username, password, role) VALUES (?, ?, ?)`,
      [username, hash, role],
      function (err) {
        if (err) {
          return res.json({ success: false, message: "User exists" });
        }

        createNotification({
  type: "USER",
  title: "New User Created",
  message: `${currentUser.username} created ${username} (${role})`,
  target: "ALL"
});

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
    const devOption = roleSelect.querySelector('option[value="developer"]');

    if (devOption) {
      devOption.disabled = true;

      if (!devOption.dataset.modified) {
        devOption.textContent += " (restricted)";
        devOption.dataset.modified = "true";
      }
    }
  }

  // 🔒 User cannot create accounts
  if (currentUser.role === "user" && createBtn) {
    createBtn.style.display = "none";
  }
}

app.get("/api/users", (req, res) => {
  db.all(`
    SELECT id, username, role, status, lastActive 
    FROM users
  `, (err, rows) => {
    if (err) return res.json([]);
    res.json(rows);
  });
});

app.post("/api/user-role", requireDeveloper, (req, res) => {
  const { id, role } = req.body;

  db.run("UPDATE users SET role=? WHERE id=?", [role, id], () => {
    res.json({ success: true });
  });
});

app.post("/api/user-delete", requireAdmin, (req, res) => {
  const { id } = req.body;

  db.run("DELETE FROM users WHERE id=?", [id], () => {
    res.json({ success: true });
  });
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

app.post("/api/user/status", requireAdmin, (req, res) => {
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
app.post("/api/reset-transactions", (req, res) => {
  if (!req.session.user || req.session.user.role !== "developer") {
    return res.status(403).json({ success: false });
  }

  db.run("DELETE FROM transactions");
  db.run("DELETE FROM sqlite_sequence WHERE name='transactions'");

  res.json({ success: true });
});

app.post("/api/reset-video-cases", requireAuth, (req, res) => {
  db.run(`DELETE FROM video_cases`, [], function (err) {
    if (err) {
      console.error("❌ RESET VIDEO ERROR:", err);
      return res.json({ success: false });
    }

    console.log("🧹 All video cases deleted");

    createNotification({
  type: "SYSTEM",
  title: "System Reset",
  message: `${req.session.user.username} reset transactions`,
  target: "ALL"
});

    res.json({ success: true });
  });
});

app.get("/api/sync-status", (req, res) => {
  res.json({ syncing: isSyncing });
});
////////////////////////////Chat ID Page////////////////////////
app.post("/api/upload-chatids", upload.single("file"), (req, res) => {

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

app.post("/api/chatids/clean-duplicates", requireAdminOrDev, (req, res) => {
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

app.post("/api/chatids", requireAdminOrDev, (req, res) => {

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

app.get("/api/chatids", (req, res) => {
  db.all("SELECT * FROM chat_ids ORDER BY id DESC", (err, rows) => {
    if (err) {
      console.error("❌ CHATIDS LOAD ERROR:", err);
      return res.status(500).json([]);
    }

    res.json(rows);
  });
});

////////////////////////////Dashboard Stats////////////////////////
app.get("/api/dashboard", requireAuth, (req, res) => {
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
app.get("/api/wallets/monitor", requireAuth, (req, res) => {
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

  let query = `SELECT * FROM wallets WHERE 1=1`;
  let params = [];

  // 🔍 search
  if (search.trim() !== "") {
    query += ` AND ownerName LIKE ?`;
    params.push(`%${search.trim()}%`);
  }

  // 🎯 filters (ONLY if not empty)
  if (agentGroup) {
  query += ` AND agentGroup LIKE ?`;
  params.push(`%${agentGroup}%`);
}

  if (type) {
  query += ` AND walletType LIKE ?`;
  params.push(`%${type}%`);
}

  if (accountType) {
    query += ` AND accountType = ?`;
    params.push(accountType);
  }

  if (status) {
  query += ` AND status LIKE ?`;
  params.push(`%${status}%`);
}

  if (remarks.trim() !== "") {
    query += ` AND remarks LIKE ?`;
    params.push(`%${remarks.trim()}%`);
  }

  console.log("QUERY:", query);
  console.log("PARAMS:", params);

  // 🔃 sorting (SAFE whitelist)
  const allowedSort = [
    "ownerName", "agentGroup", "walletType",
    "accountType", "remarks", "status",
    "todayDeposits", "todayWithdrawals", "balance"
  ];

  if (sortBy && allowedSort.includes(sortBy)) {
    query += ` ORDER BY ${sortBy} ${order === "desc" ? "DESC" : "ASC"}`;
  } else {
    query += ` ORDER BY createdAt DESC`;
  }

  db.all(query, params, (err, rows) => {
    if (err) {
      console.error("❌ WALLET MONITOR ERROR:", err);
      return res.json({ success: false });
    }

    res.json({ success: true, data: rows });
  });
});

app.post("/api/wallet/toggle", requireAuth, (req, res) => {
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
app.get("/api/ess-status", requireAuth, (req, res) => {
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
app.get("/api/agent-prefix", requireAuth, (req, res) => {
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
///////////////////Video Case Page/////////////////////////////////
app.post("/api/video-case", requireAuth, (req, res) => {
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
app.post("/api/video/send", requireAuth, async (req, res) => {
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
app.get("/api/video-case", requireAuth, (req, res) => {
  const { search, brand, agent, status, sent } = req.query;

  let sql = `
    SELECT * FROM video_cases
    WHERE (actionStatus IS NULL OR actionStatus = '')
  `;

  const params = [];

  if (search) {
    sql += ` AND transactionReference LIKE ?`;
    params.push(`%${search}%`);
  }

  if (brand) {
    sql += ` AND LOWER(TRIM(brand)) = LOWER(TRIM(?))`;
    params.push(brand);
  }

  if (agent) {
    sql += ` AND agentName = ?`;
    params.push(agent);
  }

  if (status) {
    sql += ` AND agentStatus = ?`;
    params.push(status);
  }

  if (sent !== undefined && sent !== "") {
    sql += ` AND sent = ?`;
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
app.post("/api/sync-video", requireAuth, async (req, res) => {
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
app.post("/api/video/assign-send", requireAuth, async (req, res) => {
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

app.post("/api/video/update", requireAuth, (req, res) => {
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

app.get("/api/video/settled", requireAuth, (req, res) => {
  const {
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

app.get("/api/export/video", requireAuth, (req, res) => {

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

app.post("/api/video-cases/bulk-delete", requireAdminOrDev, (req, res) => {
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

/////////////////////SMS FUNCTION//////////////////////////
app.post("/api/import-sms", upload.single("file"), (req, res) => {
  const smsData = [];

  const insertSMS = db.prepare(`
    INSERT OR IGNORE INTO sms_logs
    (shop, walletType, direction, amount, phone, transactionId, paymentRequestId, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  fs.createReadStream(req.file.path)
    .pipe(csv())
    .on("data", (row) => {

      const values = Object.values(row);

      const smsRow = {
        shop: values[1] || "",
        walletType: values[2] || "",
        direction: values[3] || "",
        amount: Number(values[4]) || 0,
        phone: String(values[5] || "").trim(),
        transactionId: String(values[6] || "").trim(),
        paymentRequestId: values[7] || "",
        status: values[8] || ""
      };

      smsData.push(smsRow);

      insertSMS.run(
        smsRow.shop,
        smsRow.walletType,
        smsRow.direction,
        smsRow.amount,
        smsRow.phone,
        smsRow.transactionId,
        smsRow.paymentRequestId,
        smsRow.status
      );
    })
    .on("end", () => {

      insertSMS.finalize();

      console.log("📩 SMS PARSED:", smsData.length);

      // 🔥 RESET ALL MATCHES (FIXED)
      db.run(`UPDATE transactions SET smsMatched = 0`, (err) => {

        if (err) {
          console.error("❌ RESET ERROR:", err);
          return res.status(500).json({ success: false });
        }

        // 🔥 GET ALL TRANSACTIONS (FIXED)
        db.all(`
          SELECT id, transactionReference, amount, customerNumber, agentName
          FROM transactions
        `, (err, allTransactions) => {

          if (err) {
            console.error("DB ERROR:", err);
            return res.status(500).json({ success: false });
          }

          // 🔥 MATCHING
          const matchedIds = runMatching(smsData, allTransactions);

          const stmt = db.prepare(`
            UPDATE transactions SET smsMatched = 1 WHERE id = ?
          `);

          matchedIds.forEach(id => stmt.run(id));
          stmt.finalize();

          fs.unlink(req.file.path, () => {});

          console.log("✅ MATCHED:", matchedIds.length);

          res.json({
            success: true,
            matched: matchedIds.length,
            totalSMS: smsData.length
          });

        });

      });

    })
    .on("error", (err) => {
      console.error("CSV ERROR:", err);
      res.status(500).json({ success: false });
    });
});

app.get("/api/sms", (req, res) => {
  const page = Number(req.query.page) || 1;
  const search = (req.query.search || "").trim();
  const limit = 20;
  const offset = (page - 1) * limit;

  let where = "";
  let params = [];

  if (search) {
    where = `
      WHERE shop LIKE ?
      OR phone LIKE ?
      OR transactionId LIKE ?
    `;
    const like = `%${search}%`;
    params.push(like, like, like);
  }

  db.all(`
    SELECT * FROM sms_logs
    ${where}
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `, [...params, limit, offset], (err, rows) => {

    if (err) return res.json({ data: [], totalPages: 1 });

    db.get(`
      SELECT COUNT(*) as total FROM sms_logs
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

app.post("/api/rematch-sms", (req, res) => {

  const io = getIO();

  // 🔄 loading start
  io.emit("rematch-status", { loading: true });

  db.all(`SELECT * FROM sms_logs`, (err, smsData) => {

    if (err) {
      io.emit("rematch-status", { loading: false });
      return res.json({ success: false });
    }

    // 🔥 RESET ALL (IMPORTANT FIX)
    db.run(`UPDATE transactions SET smsMatched = 0`);

    // 🔥 GET ALL TRANSACTIONS (NOT JUST PENDING)
    db.all(`
      SELECT id, transactionReference, amount, customerNumber, agentName
      FROM transactions
    `, (err, allTransactions) => {

      if (err) {
        io.emit("rematch-status", { loading: false });
        return res.json({ success: false });
      }

      // 🔥 MATCH
      const matchedIds = runMatching(smsData, allTransactions);

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
function runMatching(smsData, pending) {
  const clean = (v) => String(v || "").trim().toUpperCase();

  const getLast3 = (v) => {
    const str = String(v || "").replace(/\D/g, "");
    return str.slice(-3);
  };

  let matchedIds = [];

  pending.forEach(p => {
    const dbRef = clean(p.transactionReference);
    const agent = clean(p.agentName);     // ✅ FIX
    const customerLast3 = getLast3(p.customerNumber);

    const match = smsData.find(s => {
      const smsRef = clean(s.transactionId);
      const smsLast3 = getLast3(s.phone);
      const smsShop = clean(s.shop);      // ✅ FIX

      return (
        // 🔥 REF MATCH
        (
          smsRef === dbRef ||
          smsRef.replace(/O/g, "0") === dbRef.replace(/O/g, "0")
        )
        &&
        // 🔥 AMOUNT MATCH
        Number(s.amount) === Number(p.amount)
        &&
        // 🔥 LAST 3 DIGIT MATCH
        smsLast3 &&
        customerLast3 &&
        smsLast3 === customerLast3
        &&
        // 🔥 SHOP MATCH (NEW)
        agent.includes(smsShop)
      );
    });

    if (match) matchedIds.push(p.id);
  });

  return matchedIds;
}

app.delete("/api/sms/reset", requireAuth, (req, res) => {

  db.serialize(() => {

    // 🧹 Delete all SMS logs
    db.run(`DELETE FROM sms_logs`, function (err) {
      if (err) {
        console.error("❌ SMS RESET ERROR:", err);
        return res.status(500).json({ success: false });
      }

      console.log("🧹 SMS data cleared:", this.changes);
    });

    // 🔥 RESET EVERYTHING (NO WHERE)
    db.run(`UPDATE transactions SET smsMatched = 0`, function (err) {
      if (err) {
        console.error("❌ RESET MATCH ERROR:", err);
        return res.status(500).json({ success: false });
      }

      console.log("🔄 ALL smsMatched reset:", this.changes);
    });

  });

  res.json({
    success: true,
    message: "SMS cleared + ALL matches reset"
  });

});

//////////////////////////////////////////////////////////////message webhook//////////////////////////////////////
app.post("/api/message", requireAuth, (req, res) => {
  const { message, target } = req.body;
  const sender = req.session.user.username;

  const receiver = target === "ALL" ? "ALL" : target;

  db.run(
    `
    INSERT INTO messages (sender, receiver, message)
    VALUES (?, ?, ?)
  `,
    [sender, receiver, message],
    function (err) {
      if (err) {
        return res.status(500).json({ success: false });
      }

      const payload = {
        sender,
        receiver,
        message,
        createdAt: new Date()
      };

      const io = getIO();

      // 📡 SOCKET MESSAGE
      if (receiver === "ALL") {
        io.emit("receive-message", payload);
      } else {
        io.to(receiver).emit("receive-message", payload);
      }

      // 🔔 NOTIFICATION (🔥 NEW)
      createNotification({
        type: "MESSAGE",
        title: "New Message",
        message:
          receiver === "ALL"
            ? `${sender} sent a message to ALL`
            : `${sender} → ${receiver}`,
        meta: { text: message },
        target: receiver === "ALL" ? "ALL" : receiver
      });

      res.json({ success: true });
    }
  );
});

app.get("/api/messages", requireAuth, (req, res) => {
  const user = req.session.user.username;

  db.all(`
    SELECT * FROM messages
    WHERE receiver = 'ALL' OR receiver = ?
    ORDER BY createdAt DESC
    LIMIT 100
  `, [user], (err, rows) => {

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