require("dotenv").config();

const path = require("path");
const sqlite3 = require("sqlite3").verbose();

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required for PostgreSQL migration.");
  process.exit(1);
}

process.env.DB_CLIENT = "postgres";

const pgDb = require("../db");

const sqlitePath = process.env.SQLITE_DB_PATH
  ? path.resolve(process.env.SQLITE_DB_PATH)
  : path.join(__dirname, "..", "database.db");

const sqlite = new sqlite3.Database(sqlitePath);

const NUMERIC_COLUMNS = {
  opening_balances: new Set(["openingBalance"]),
  transactions: new Set(["amount", "sent", "smsMatched", "followUpCount", "gsheetUpdated"]),
  video_cases: new Set(["amount", "sent", "voicemailProvided", "telegramMessageId", "smsMatched"]),
  wallet_daily_activity: new Set(["amount"]),
  wallet_health: new Set(["apiBalance", "apiFailures"]),
  wallets: new Set([
    "openingBalance",
    "balance",
    "depositDailyLimit",
    "withdrawalDailyLimit",
    "todayDeposits",
    "todayWithdrawals",
    "depositPriority",
    "withdrawalPriority"
  ])
};

function sqliteAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    sqlite.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

function pgRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    pgDb.run(sql, params, function onRun(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function normalizeValue(table, column, value) {
  if (!NUMERIC_COLUMNS[table]?.has(column)) return value;
  if (value === null || value === undefined) return null;

  const cleaned = String(value).replace(/,/g, "").trim();
  if (!cleaned || cleaned === "-" || cleaned.toUpperCase() === "N/A") return 0;

  const number = Number(cleaned);
  return Number.isFinite(number) ? number : 0;
}

async function copyTable(table) {
  const rows = await sqliteAll(`SELECT * FROM ${table}`);
  await pgRun(`DELETE FROM ${table}`);

  if (!rows.length) {
    console.log(`${table}: no rows`);
    return;
  }

  const columns = Object.keys(rows[0]);
  const placeholders = columns.map(() => "?").join(", ");
  const columnList = columns.join(", ");
  const insertSql = `INSERT INTO ${table} (${columnList}) VALUES (${placeholders})`;

  for (const row of rows) {
    await pgRun(insertSql, columns.map((column) => normalizeValue(table, column, row[column])));
  }

  if (columns.includes("id") && typeof pgDb.resetSerial === "function") {
    await pgDb.resetSerial(table);
  }

  console.log(`${table}: copied ${rows.length} rows`);
}

async function main() {
  await pgDb.ready;
  await pgDb.waitForIdle?.();

  const tables = await sqliteAll(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `);

  for (const row of tables) {
    await copyTable(row.name);
  }

  await pgDb.waitForIdle?.();
  sqlite.close();
  await pgDb.close?.();
  console.log("SQLite to PostgreSQL migration complete.");
}

main().catch(async (err) => {
  console.error("Migration failed:", err);
  sqlite.close();
  await pgDb.close?.();
  process.exit(1);
});
