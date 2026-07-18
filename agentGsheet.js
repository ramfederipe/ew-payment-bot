const path = require("path");
const { google } = require("googleapis");
const db = require("./db");

const HEADERS = ["Agent", "Ref", "Amount", "Customer", "Image", "Status", "Reason"];
const FINAL_PENDING_STATUSES = new Set(["RECEIVED", "NOT RECEIVED", "FOR REVIEW"]);
const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, "credentials", "credentials.json"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});

let syncPromise = null;

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) return reject(err);
      resolve({ changes: Number(this?.changes || 0), lastID: this?.lastID });
    });
  });
}

function normalize(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
}

function clean(value, limit = 500) {
  return String(value ?? "").trim().slice(0, limit);
}

function extractSpreadsheetId(value) {
  const text = clean(value, 1000);
  const match = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  const id = match ? match[1] : text;
  return /^[a-zA-Z0-9-_]{20,}$/.test(id) ? id : "";
}

function quoteSheetTitle(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function normalizeAgentAnswer(value) {
  const status = normalize(value);
  if (!status || ["PENDING", "CHECKING", "ALL", "-"] .includes(status)) return "";
  if (["YES", "Y", "RECEIVED", "SUCCESS", "APPROVED"].includes(status)) return "RECEIVED";
  if (["NO", "N", "NOT RECEIVED", "NOTRECEIVED", "FAILED", "REJECTED"].includes(status)) return "NOT RECEIVED";
  if (["REVIEW", "FOR REVIEW", "FORREVIEW"].includes(status)) return "For Review";
  return clean(value, 120);
}

function isFinalDatabaseAnswer(value) {
  return FINAL_PENDING_STATUSES.has(normalize(value));
}

async function ensureWorksheet(sheets, spreadsheetId, title) {
  const metadata = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties(sheetId,title)"
  });
  let worksheet = (metadata.data.sheets || []).find(sheet => normalize(sheet.properties?.title) === normalize(title));

  if (!worksheet) {
    const created = await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] }
    });
    worksheet = created.data.replies?.[0]?.addSheet;
  }

  const range = `${quoteSheetTitle(title)}!A:G`;
  const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const values = response.data.values || [];
  const currentHeaders = values[0] || [];
  const headersMatch = HEADERS.every((header, index) => normalize(currentHeaders[index]) === normalize(header));

  if (!headersMatch) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${quoteSheetTitle(title)}!A1:G1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADERS] }
    });
    if (values.length) values[0] = HEADERS;
    else values.push(HEADERS);
  }

  return { values, sheetId: worksheet?.properties?.sheetId };
}

function makeKey(agentName, reference) {
  return `${normalize(agentName)}|${normalize(reference)}`;
}

async function applySheetAnswers(type, sheetRows, databaseRows, sheets, spreadsheetId, title) {
  const rowsByKey = new Map(databaseRows.map(row => [makeKey(row.agentName, row.transactionReference), row]));
  const existingKeys = new Set();
  const valueUpdates = [];
  let answersImported = 0;

  for (let index = 1; index < sheetRows.length; index += 1) {
    const sheetRow = sheetRows[index] || [];
    const key = makeKey(sheetRow[0], sheetRow[1]);
    if (!normalize(sheetRow[1])) continue;
    existingKeys.add(key);

    const row = rowsByKey.get(key);
    if (!row) continue;

    const sheetAnswer = normalizeAgentAnswer(sheetRow[5]);
    const sheetReason = clean(sheetRow[6], 1000);
    if (sheetAnswer) {
      if (normalize(row.agentStatus) !== normalize(sheetAnswer) || (sheetReason && clean(row.reason) !== sheetReason)) {
        const table = type === "VDO" ? "video_cases" : "transactions";
        await dbRun(`
          UPDATE ${table}
          SET agentStatus = ?,
              reason = CASE WHEN ? = '' THEN reason ELSE ? END,
              confirmedBy = 'GSHEET',
              confirmedAt = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [sheetAnswer, sheetReason, sheetReason, row.id]);
        answersImported += 1;
      }
      continue;
    }

    if (isFinalDatabaseAnswer(row.agentStatus)) {
      const rowNumber = index + 1;
      valueUpdates.push(
        { range: `${quoteSheetTitle(title)}!F${rowNumber}`, values: [[clean(row.agentStatus, 120)]] },
        { range: `${quoteSheetTitle(title)}!G${rowNumber}`, values: [[clean(row.reason, 1000)]] }
      );
    }
  }

  if (valueUpdates.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: "RAW", data: valueUpdates }
    });
  }

  return { existingKeys, answersImported, answersExported: valueUpdates.length / 2 };
}

async function syncWorksheet(sheets, spreadsheetId, title, type, rows) {
  const worksheet = await ensureWorksheet(sheets, spreadsheetId, title);
  const answerResult = await applySheetAnswers(type, worksheet.values, rows, sheets, spreadsheetId, title);
  const missingByKey = new Map();
  rows.forEach(row => {
    const reference = normalize(row.transactionReference);
    const key = makeKey(row.agentName, reference);
    if (reference && !answerResult.existingKeys.has(key) && !missingByKey.has(key)) {
      missingByKey.set(key, row);
    }
  });
  const missingRows = [...missingByKey.values()];

  if (missingRows.length) {
    const values = missingRows.map(row => [
      clean(row.agentName, 160),
      clean(row.transactionReference, 160),
      Number(row.amount || 0),
      clean(row.customerNumber, 160),
      clean(type === "VDO" ? row.videoLink : row.imageLink, 1000),
      isFinalDatabaseAnswer(row.agentStatus) ? clean(row.agentStatus, 120) : "",
      isFinalDatabaseAnswer(row.agentStatus) ? clean(row.reason, 1000) : ""
    ]);
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${quoteSheetTitle(title)}!A:G`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values }
    });
  }

  return {
    appended: missingRows.length,
    answersImported: answerResult.answersImported,
    answersExported: answerResult.answersExported
  };
}

async function runAgentGsheetSync() {
  if (syncPromise) return syncPromise;

  syncPromise = (async () => {
    const allowedRows = await dbAll(`
      SELECT accountName
      FROM gsheet_allowed_accounts
      WHERE enabled = 1
      ORDER BY accountName ASC
    `);
    const allowed = new Set(allowedRows.map(row => normalize(row.accountName)).filter(Boolean));
    const result = {
      allowedAccounts: allowed.size,
      linkedAccounts: 0,
      skippedWithoutLink: [],
      pendingAppended: 0,
      videoAppended: 0,
      answersImported: 0,
      answersExported: 0
    };
    if (!allowed.size) return result;

    const chatRows = await dbAll(`
      SELECT id, agentName, gsheetLink
      FROM chat_ids
      WHERE gsheetLink IS NOT NULL AND TRIM(gsheetLink) != ''
      ORDER BY id DESC
    `);
    const linkByAccount = new Map();
    chatRows.forEach(row => {
      const account = normalize(row.agentName);
      const spreadsheetId = extractSpreadsheetId(row.gsheetLink);
      if (allowed.has(account) && spreadsheetId && !linkByAccount.has(account)) {
        linkByAccount.set(account, spreadsheetId);
      }
    });
    result.linkedAccounts = linkByAccount.size;
    result.skippedWithoutLink = [...allowed].filter(account => !linkByAccount.has(account));

    const [pendingRows, videoRows] = await Promise.all([
      dbAll(`
        SELECT id, agentName, transactionReference, amount, customerNumber, imageLink, agentStatus, reason
        FROM transactions
        WHERE actionStatus IS NULL OR actionStatus = 'PENDING'
        ORDER BY id ASC
      `),
      dbAll(`
        SELECT id, agentName, transactionReference, amount, customerNumber, videoLink, agentStatus, reason
        FROM video_cases
        WHERE actionStatus IS NULL OR actionStatus = 'PENDING'
        ORDER BY id ASC
      `)
    ]);

    const workBySheet = new Map();
    const addRows = (type, rows) => {
      rows.forEach(row => {
        const account = normalize(row.agentName);
        const spreadsheetId = linkByAccount.get(account);
        if (!spreadsheetId) return;
        if (!workBySheet.has(spreadsheetId)) workBySheet.set(spreadsheetId, { Pending: [], VDO: [] });
        workBySheet.get(spreadsheetId)[type].push(row);
      });
    };
    addRows("Pending", pendingRows);
    addRows("VDO", videoRows);

    const sheets = google.sheets({ version: "v4", auth });
    for (const [spreadsheetId, work] of workBySheet.entries()) {
      for (const type of ["Pending", "VDO"]) {
        const syncResult = await syncWorksheet(sheets, spreadsheetId, type, type, work[type]);
        if (type === "Pending") result.pendingAppended += syncResult.appended;
        else result.videoAppended += syncResult.appended;
        result.answersImported += syncResult.answersImported;
        result.answersExported += syncResult.answersExported;
      }
    }

    return result;
  })().finally(() => {
    syncPromise = null;
  });

  return syncPromise;
}

module.exports = {
  extractSpreadsheetId,
  normalizeAccountName: normalize,
  runAgentGsheetSync
};
