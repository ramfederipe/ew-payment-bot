const { google } = require("googleapis");
require("dotenv").config();
const db = require("./db");

// Config
const { getSettings } = require("./config");
const {
  DEFAULT_SYNC_COLUMN_MAP,
  getByColumnMap,
  getColumnIndex,
  parseColumnMap
} = require("./sheetColumns");

const path = require("path");

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(
    __dirname,
    "credentials",
    "credentials.json"
  ),
  scopes: [
    "https://www.googleapis.com/auth/spreadsheets"
  ],
});

function extractSheetId(url) {
  if (!url) return "";
  const match = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : url;
}

async function syncSheets(mode = "all", filters = {}) {
const syncTime = new Date().toISOString();
const settings = await getSettings();
const stats = {
inserted: 0,
errors: []
};
const syncColumnMap = parseColumnMap(
settings.sheetColumnMap,
DEFAULT_SYNC_COLUMN_MAP
);

let SHEET_ID, SHEETS;

if (mode === "video") {
SHEET_ID = extractSheetId(settings.videoGsheetLink);
SHEETS = settings.videoSheetNames
? settings.videoSheetNames.split(",").map(name => name.trim()).filter(Boolean)
: [];
} else {
SHEET_ID = extractSheetId(settings.gsheetLink);
SHEETS = settings.sheetNames
? settings.sheetNames.split(",").map(name => name.trim()).filter(Boolean)
: [];
}

console.log("MODE:", mode);
console.log("SHEET_ID:", SHEET_ID);
console.log("SHEETS:", SHEETS);

if (!SHEET_ID || SHEETS.length === 0) {
console.log("❌ Missing GSheet config");
stats.errors.push("Missing GSheet config");
return stats;
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

  const safeGet = (row, key) => getByColumnMap(row, headers, syncColumnMap, key);

  console.log("📄 Processing:", sheetName);

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];

    const trxIdColIndex = getColumnIndex(headers, syncColumnMap.trxId);
    const trxIdRaw = (row[trxIdColIndex] || "").trim();

    if (mode === "checking") {

  const normalizedTrx =
    trxIdRaw.trim();

  if (
    normalizedTrx !== "" &&
    normalizedTrx !== "-"
  ) {

    console.log(
      "⏭️ SKIP (COLUMN N HAS TRX ID):",
      trxIdRaw
    );

    continue;
  }

}

    const agentNumber = safeGet(row, "agentNumber");
    const depositId = safeGet(row, "depositId");
    const ref = safeGet(row, "referenceNo");
    const customerNumber = safeGet(row, "customerNumber");

    const agentName =
      safeGet(row, "agentName") ||
      safeGet(row, "username") ||
      safeGet(row, "agentNumber") ||
      "UNKNOWN";

    const agentGroupFromName = (agentName || "")
    .substring(0, 3)
    .toUpperCase();

    const videoLink = safeGet(row, "videoLink");
    const videoStatus = (safeGet(row, "videoStatus") || "").trim();
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

    const rawAmount = safeGet(row, "amount");
    const cleanAmount = String(rawAmount).replace(/,/g, "");
    const amount = parseFloat(cleanAmount) || 0;

    const depositDate = safeGet(row, "depositDate");

    const imageLink = safeGet(row, "imageLink");
    const date = safeGet(row, "datePosted") || safeGet(row, "date");
    const essStatus = safeGet(row, "essStatus");

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

if (mode === "video") {

  existing = await new Promise(resolve => {

    db.get(`
      SELECT *
      FROM video_cases
      WHERE TRIM(COALESCE(depositId, '')) = ?
      AND TRIM(COALESCE(transactionReference, '')) = ?
    `,
    [cleanDepositId, cleanRef],
    (err, row) => resolve(row));

  });

  // 🔥 SKIP VIDEO DUPLICATE
  if (existing) {
    console.log("⏭️ SKIP VIDEO DUPLICATE:", cleanRef);
    continue;
  }

} else {

  existing = await new Promise(resolve => {

    db.get(`
      SELECT *
      FROM transactions
      WHERE TRIM(COALESCE(depositId, '')) = ?
      AND TRIM(COALESCE(transactionReference, '')) = ?
    `,
    [cleanDepositId, cleanRef],
    (err, row) => resolve(row));

  });

}

    // =========================
    // 🔁 EXISTING HANDLING (MAIN ONLY)
    // =========================
    if (existing) {
      console.log("SKIP (ALREADY SYNCED PAIR):", cleanDepositId, cleanRef);
      continue;

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

          stats.inserted++;
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

          stats.inserted++;
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

      stats.inserted++;
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

      stats.inserted++;
      console.log("➕ INSERT NEW:", cleanRef);
    }
  }

  console.log(`✅ Finished ${sheetName}`);
} catch (err) {
  console.error(`❌ Error syncing ${sheetName}:`, err.message);
  stats.errors.push(`${sheetName}: ${err.message}`);
}


}

console.log("🎯 Sync complete");
return stats;
}

module.exports = { syncSheets };
