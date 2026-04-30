const { google } = require("googleapis");
require("dotenv").config();

const auth = new google.auth.GoogleAuth({
  keyFile: "credentials.json",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const { getSettings } = require("./config");

// Extract Sheet ID
function extractSheetId(url) {
  if (!url) return "";
  const match = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : url;
}

// Convert HEX → RGB
function hexToRgb(hex) {
  const bigint = parseInt(hex.replace("#", ""), 16);
  return {
    red: ((bigint >> 16) & 255) / 255,
    green: ((bigint >> 8) & 255) / 255,
    blue: (bigint & 255) / 255,
  };
}

async function updateStatusByRef(ref, status, user, chatId, reason, brand) {
  try {
    if (!brand) {
      console.log("❌ Missing brand");
      return;
    }

    const settings = await getSettings();
    const spreadsheetId = extractSheetId(settings.gsheetLink);

    const sheets = google.sheets({
      version: "v4",
      auth: await auth.getClient()
    });

    const sheetName = (brand || "").trim();

    console.log("📄 Sheet:", sheetName);

    // 👉 NO TEMPLATE STRING HERE
    const rangeAll = sheetName + "!A:N";

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: spreadsheetId,
      range: rangeAll,
    });

    const rows = res.data.values || [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const sheetRef = (row[2] || "").toString().trim();

      if (sheetRef === ref) {
        const rowIndex = i + 1;

        console.log("✅ Found at row", rowIndex);

        const isApproved = status === "APPROVED";
        const statusText = isApproved ? "Success" : "Failed";

        // 👉 Column L
        await sheets.spreadsheets.values.update({
          spreadsheetId: spreadsheetId,
          range: sheetName + "!L" + rowIndex,
          valueInputOption: "USER_ENTERED",
          requestBody: {
            values: [[statusText]],
          },
        });

        // 👉 Column N
        await sheets.spreadsheets.values.update({
          spreadsheetId: spreadsheetId,
          range: sheetName + "!N" + rowIndex,
          valueInputOption: "USER_ENTERED",
          requestBody: {
            values: [[reason || ""]],
          },
        });

        // 🎨 COLOR
        const bgColor = isApproved ? "#C6EFCE" : "#FFC7CE";
        const textColor = isApproved ? "#006100" : "#9C0006";

        const bg = hexToRgb(bgColor);
        const fg = hexToRgb(textColor);

        // Get sheet ID
        const meta = await sheets.spreadsheets.get({
          spreadsheetId: spreadsheetId
        });

        const sheet = meta.data.sheets.find(
          s => s.properties.title === sheetName
        );

        if (!sheet) {
          console.log("❌ Sheet not found in metadata");
          return;
        }

        const sheetId = sheet.properties.sheetId;

        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: spreadsheetId,
          requestBody: {
            requests: [
              {
                repeatCell: {
                  range: {
                    sheetId: sheetId,
                    startRowIndex: rowIndex - 1,
                    endRowIndex: rowIndex,
                    startColumnIndex: 11, // L
                    endColumnIndex: 12
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
              }
            ]
          }
        });

        console.log("🎯 Updated L & N →", ref);
        return;
      }
    }

    console.log("❌ Ref not found:", ref);

  } catch (err) {
    console.error("❌ GSHEET ERROR:", err.message);
  }
}

module.exports = { updateStatusByRef };

