const { google } = require("googleapis");
const path = require("path");
require("dotenv").config();

const { getSettings } = require("./config");
const {
  DEFAULT_UPDATE_COLUMN_MAP,
  columnIndexToLetter,
  getColumnIndex,
  parseColumnMap
} = require("./sheetColumns");

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, "credentials", "credentials.json"),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

function extractSheetId(url) {
  if (!url) return "";
  const match = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : url;
}

function hexToRgb(hex) {
  const bigint = parseInt(hex.replace("#", ""), 16);
  return {
    red: ((bigint >> 16) & 255) / 255,
    green: ((bigint >> 8) & 255) / 255,
    blue: (bigint & 255) / 255,
  };
}

function getStatusText(status) {
  if (status === "APPROVED") return "Success";
  if (status === "REJECTED") return "Not Received";
  return "";
}

function canOverwriteStatus(value) {
  const currentStatus = String(value || "").trim().toLowerCase();
  return currentStatus === "" || currentStatus === "checking" || currentStatus === "all";
}

function getUpdateColumns(headers, settings) {
  const updateColumnMap = parseColumnMap(
    settings.sheetUpdateColumnMap,
    DEFAULT_UPDATE_COLUMN_MAP
  );

  return {
    ref: getColumnIndex(headers, updateColumnMap.lookupRef),
    status: getColumnIndex(headers, updateColumnMap.essStatus),
    successId: getColumnIndex(headers, updateColumnMap.essSuccessId),
    trxId: getColumnIndex(headers, updateColumnMap.trxId)
  };
}

function buildValueUpdates(sheetName, rowIndex, columns, statusText, reason) {
  const updates = [
    {
      range: `${sheetName}!${columnIndexToLetter(columns.status)}${rowIndex}`,
      values: [[statusText]]
    },
    {
      range: `${sheetName}!${columnIndexToLetter(columns.trxId)}${rowIndex}`,
      values: [[reason || ""]]
    }
  ];

  if (columns.successId !== -1 && columns.successId !== columns.trxId) {
    updates.push({
      range: `${sheetName}!${columnIndexToLetter(columns.successId)}${rowIndex}`,
      values: [[""]]
    });
  }

  return updates;
}

function buildStatusFormat(sheetId, rowIndex, statusColumnIndex, isApproved) {
  const bg = hexToRgb(isApproved ? "#C6EFCE" : "#FFC7CE");
  const fg = hexToRgb(isApproved ? "#006100" : "#9C0006");

  return {
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: rowIndex - 1,
        endRowIndex: rowIndex,
        startColumnIndex: statusColumnIndex,
        endColumnIndex: statusColumnIndex + 1
      },
      cell: {
        userEnteredFormat: {
          backgroundColor: bg,
          textFormat: {
            foregroundColor: fg,
            bold: true
          }
        }
      },
      fields: "userEnteredFormat(backgroundColor,textFormat)"
    }
  };
}

async function updateStatusByRef(ref, status, user, chatId, reason, brand) {
  try {
    if (!brand) {
      console.log("Missing brand");
      return;
    }

    const settings = await getSettings();
    const spreadsheetId = extractSheetId(settings.gsheetLink);
    const sheetName = String(brand || "").trim();
    const sheets = google.sheets({
      version: "v4",
      auth: await auth.getClient()
    });

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!A:Z`,
    });

    const rows = res.data.values || [];
    const headers = rows[0] || [];
    const columns = getUpdateColumns(headers, settings);

    if (columns.ref === -1 || columns.status === -1 || columns.trxId === -1) {
      console.log("Missing GSheet update column mapping");
      return;
    }

    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const sheet = (meta.data.sheets || []).find(
      item => item.properties.title === sheetName
    );

    if (!sheet) {
      console.log("Sheet not found in metadata");
      return;
    }

    const cleanRef = String(ref || "").trim().toUpperCase();

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const sheetRef = String(row[columns.ref] || "").trim().toUpperCase();

      if (sheetRef !== cleanRef) continue;

      const rowIndex = i + 1;
      if (!canOverwriteStatus(row[columns.status])) {
        console.log("Skip update (already final):", ref, row[columns.status]);
        return;
      }

      const isApproved = status === "APPROVED";
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: "USER_ENTERED",
          data: buildValueUpdates(
            sheetName,
            rowIndex,
            columns,
            getStatusText(status),
            reason
          )
        }
      });

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            buildStatusFormat(
              sheet.properties.sheetId,
              rowIndex,
              columns.status,
              isApproved
            )
          ]
        }
      });

      console.log("Updated mapped GSheet columns:", ref);
      return;
    }

    console.log("Ref not found:", ref);
  } catch (err) {
    console.error("GSHEET ERROR:", err.message);
  }
}

async function updateStatusBulk(rows, user) {
  const results = {
    successIds: [],
    failedIds: [],
    skippedIds: []
  };

  if (!Array.isArray(rows) || rows.length === 0) {
    return results;
  }

  const settings = await getSettings();
  const spreadsheetId = extractSheetId(settings.gsheetLink);
  const sheets = google.sheets({
    version: "v4",
    auth: await auth.getClient()
  });

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheetIdByName = new Map(
    (meta.data.sheets || []).map(sheet => [
      sheet.properties.title,
      sheet.properties.sheetId
    ])
  );

  const rowsByBrand = rows.reduce((map, row) => {
    const brand = String(row.brand || "").trim();
    if (!brand) {
      results.failedIds.push(row.id);
      return map;
    }

    if (!map.has(brand)) map.set(brand, []);
    map.get(brand).push(row);
    return map;
  }, new Map());

  for (const [sheetName, brandRows] of rowsByBrand.entries()) {
    const sheetId = sheetIdByName.get(sheetName);
    if (sheetId === undefined) {
      brandRows.forEach(row => results.failedIds.push(row.id));
      continue;
    }

    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!A:Z`
      });

      const sheetRows = res.data.values || [];
      const headers = sheetRows[0] || [];
      const columns = getUpdateColumns(headers, settings);

      if (columns.ref === -1 || columns.status === -1 || columns.trxId === -1) {
        brandRows.forEach(row => results.failedIds.push(row.id));
        continue;
      }

      const refToRow = new Map();
      for (let i = 1; i < sheetRows.length; i++) {
        const ref = String(sheetRows[i][columns.ref] || "").trim().toUpperCase();
        if (ref && !refToRow.has(ref)) {
          refToRow.set(ref, { rowIndex: i + 1, row: sheetRows[i] });
        }
      }

      const valueUpdates = [];
      const formatRequests = [];
      const brandSuccessIds = [];

      brandRows.forEach(row => {
        const ref = String(row.ref || "").trim().toUpperCase();
        const match = refToRow.get(ref);

        if (!match) {
          results.failedIds.push(row.id);
          return;
        }

        if (!canOverwriteStatus(match.row[columns.status])) {
          results.skippedIds.push(row.id);
          return;
        }

        const isApproved = row.status === "APPROVED";
        valueUpdates.push(
          ...buildValueUpdates(
            sheetName,
            match.rowIndex,
            columns,
            getStatusText(row.status),
            row.reason
          )
        );
        formatRequests.push(
          buildStatusFormat(sheetId, match.rowIndex, columns.status, isApproved)
        );
        brandSuccessIds.push(row.id);
      });

      if (valueUpdates.length) {
        await sheets.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: {
            valueInputOption: "USER_ENTERED",
            data: valueUpdates
          }
        });
      }

      if (formatRequests.length) {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: formatRequests
          }
        });
      }

      results.successIds.push(...brandSuccessIds);
    } catch (err) {
      console.error(`GSHEET BULK ERROR (${sheetName}):`, err.message);
      brandRows.forEach(row => results.failedIds.push(row.id));
    }
  }

  return results;
}

module.exports = { updateStatusByRef, updateStatusBulk };
