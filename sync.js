const { google } = require("googleapis");
require("dotenv").config();
const db = require("./db");

// Config
const { getSettings } = require("./config");

const auth = new google.auth.GoogleAuth({
keyFile: "credentials.json",
scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

function extractSheetId(url) {
  if (!url) return "";
  const match = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : url;
}

async function syncSheets(mode = "all", filters = {}) {
const syncTime = new Date().toISOString();
const settings = await getSettings();

let SHEET_ID, SHEETS;

if (mode === "video") {
SHEET_ID = extractSheetId(settings.videoGsheetLink);
SHEETS = settings.videoSheetNames
? settings.videoSheetNames.split(",")
: [];
} else {
SHEET_ID = extractSheetId(settings.gsheetLink);
SHEETS = settings.sheetNames
? settings.sheetNames.split(",")
: [];
}

console.log("MODE:", mode);
console.log("SHEET_ID:", SHEET_ID);
console.log("SHEETS:", SHEETS);

if (!SHEET_ID || SHEETS.length === 0) {
console.log("❌ Missing GSheet config");
return;
}

const sheets = google.sheets({
version: "v4",
auth: await auth.getClient(),
});

for (const sheetName of SHEETS) {
try {
const res = await sheets.spreadsheets.values.get({
spreadsheetId: SHEET_ID,
range: `${sheetName}!A:Z`,
});

  const rows = res.data.values || [];
  if (rows.length === 0) {
    console.log(`[WARN] ${sheetName}: No data`);
    continue;
  }

  const headers = rows[0];
  console.log("HEADERS:", headers);

  const normalize = (str) =>
    str.toLowerCase().replace(/[^a-z0-9]/g, "");

  const safeGet = (row, keywords) => {
    const i = headers.findIndex(h => {
      const normalizedHeader = normalize(h);
      return keywords.some(k => normalize(k) === normalizedHeader);
    });
    return i !== -1 ? row[i] : "";
  };

  console.log("📄 Processing:", sheetName);

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];

    const trxIdColIndex = 13;
    const trxIdRaw = (row[trxIdColIndex] || "").trim();

    if (mode === "checking") {
      if (trxIdRaw !== "") {
        console.log("⏭️ SKIP (COLUMN N NOT EMPTY):", trxIdRaw);
        continue;
      }
    }

    const agentNumber = safeGet(row, ["agent number"]);
    const depositId = safeGet(row, ["deposit id"]);
    const ref = safeGet(row, ["reference no"]);
    const customerNumber = safeGet(row, ["customer number"]);

    const agentName =
      safeGet(row, ["agent name"]) ||
      safeGet(row, ["username"]) ||
      safeGet(row, ["agent number"]) ||
      "UNKNOWN";

    const agentGroupFromName = (agentName || "")
    .substring(0, 3)
    .toUpperCase();

    const videoLink = safeGet(row, ["vdo link","video","video link"]);
    const videoStatus = (safeGet(row, ["status"]) || "").trim();
    const brand = sheetName;

    if (mode === "video") {
        if (!videoLink) continue;

    if (filters.status && videoStatus !== filters.status) {
    continue;
    }

    if (filters.agentGroup && agentGroupFromName !== filters.agentGroup) {
    continue;
    }
   }

    // 🔥 MODE FILTER
    if (mode !== "video" && videoLink) continue;

    const rawAmount = safeGet(row, ["amount"]);
    const cleanAmount = String(rawAmount).replace(/,/g, "");
    const amount = parseFloat(cleanAmount) || 0;

    const depositDate = safeGet(row, ["deposit date"]);

    const imageLink = safeGet(row, ["imagelink", "image link"]);
    const date = safeGet(row, ["date posted", "date"]);
    const essStatus = safeGet(row, ["ess status"]);

    const finalEssStatus =
      essStatus && essStatus.trim() !== ""
        ? essStatus.trim()
        : "Checking";

    if (mode === "checking") {
        const ess = (essStatus || "").trim().toLowerCase();
        const isChecking =
        ess === "" || ess === "checking";
        if (!isChecking) continue;
        }

    // 🚫 Skip invalid
    if (!ref || !amount) continue;
    if (essStatus?.toLowerCase() === "success") continue;

    const cleanRef = ref.trim();
    const cleanDepositId = (depositId || "").trim();

    // 🔥 ONLY CHECK EXISTING FOR MAIN MODE
    let existing = null;
    if (mode !== "video") {
      existing = await new Promise(resolve => {
        db.get(
          `SELECT * FROM transactions WHERE transactionReference = ?`,
          [cleanRef],
          (err, row) => resolve(row)
        );
      });
    }

    // =========================
    // 🔁 EXISTING HANDLING (MAIN ONLY)
    // =========================
    if (existing) {
      if (existing.actionStatus === "APPROVED") {
        console.log("⏭️ SKIP (APPROVED):", cleanRef);
        continue;
      }

      if (existing.actionStatus === "REJECTED") {
        const isSame =
          Number(existing.amount) === amount &&
          (existing.depositId || "") === cleanDepositId &&
          (existing.customerNumber || "") === customerNumber &&
          (existing.agentNumber || "") === agentNumber &&
          (existing.agentName || "") === agentName;

        if (isSame) {
          console.log("⏭️ SKIP (REJECTED SAME):", cleanRef);
          continue;
        }

        if (mode === "video") {
          // 🎥 VIDEO INSERT (REJECTED)
          await new Promise(resolve => {
            db.run(`
              INSERT INTO video_cases (
                transactionReference, depositId, agentName, customerNumber,
                amount, depositDate, agentNumber, videoLink, date, brand
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
              cleanRef,
              cleanDepositId,
              agentName,
              customerNumber,
              amount,
              depositDate,
              agentNumber,
              videoLink,
              date,
              sheetName
            ], resolve);
          });

          console.log("🎥 VIDEO INSERT (REJECTED):", cleanRef);
        } else {
          // NORMAL INSERT
          await new Promise(resolve => {
            db.run(`
              INSERT INTO transactions (
                transactionReference, depositId, agentName, customerNumber,
                amount, depositDate, agentNumber, imageLink, videoLink, date,
                essStatus, status, actionStatus, brand, sent, syncedAt
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
              cleanRef,
              cleanDepositId,
              agentName,
              customerNumber,
              amount,
              depositDate,
              agentNumber,
              imageLink,
              videoLink,
              date,
              finalEssStatus,
              "PENDING",
              "PENDING",
              sheetName,
              0,
              syncTime
            ], resolve);
          });

          console.log("➕ INSERT (REJECTED CHANGE):", cleanRef);
        }

        continue;
      }

      if ((existing.depositId || "") === cleanDepositId) {
        if (!existing.essStatus || existing.essStatus === "Checking") {
          await new Promise(resolve => {
            db.run(`
              UPDATE transactions
              SET essStatus = ?
              WHERE transactionReference = ?
            `, [finalEssStatus, syncTime, cleanRef], resolve);
          });
        }

        if (Number(existing.amount) !== amount) {
          await new Promise(resolve => {
            db.run(`
              UPDATE transactions
              SET amount = ?
              WHERE transactionReference = ?
            `, [amount, syncTime, cleanRef], resolve);
          });
        }

        console.log("⏭️ SKIP (UNCHANGED):", cleanRef);
        continue;
      }
    }

    // =========================
    // ➕ NEW INSERT
    // =========================
    if (mode === "video") {
      await new Promise(resolve => {
        db.run(`
          INSERT INTO video_cases (
            transactionReference, depositId, agentName, customerNumber,
            amount, depositDate, agentNumber, videoLink, date, brand
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          cleanRef,
          cleanDepositId,
          agentName,
          customerNumber,
          amount,
          depositDate,
          agentNumber,
          videoLink,
          date,
          sheetName
        ], resolve);
      });

      console.log("🎥 VIDEO INSERT:", cleanRef);
    } else {
      await new Promise(resolve => {
        db.run(`
          INSERT INTO transactions (
            transactionReference, depositId, agentName, customerNumber,
            amount, depositDate, agentNumber, imageLink, videoLink, date,
            essStatus, status, actionStatus, brand, sent, syncedAt
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          cleanRef,
          cleanDepositId,
          agentName,
          customerNumber,
          amount,
          depositDate,
          agentNumber,
          imageLink,
          videoLink,
          date,
          finalEssStatus,
          "PENDING",
          "PENDING",
          sheetName,
          0,
          syncTime
        ], resolve);
      });

      console.log("➕ INSERT NEW:", cleanRef);
    }
  }

  console.log(`✅ Finished ${sheetName}`);
} catch (err) {
  console.error(`❌ Error syncing ${sheetName}:`, err.message);
}


}

console.log("🎯 Sync complete");
}

module.exports = { syncSheets };
