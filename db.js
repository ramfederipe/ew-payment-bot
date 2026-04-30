const sqlite3 = require("sqlite3").verbose();

const path = require("path");

const db = new sqlite3.Database(
  path.join(__dirname, "database.db")
);

// CREATE TABLES
db.serialize(() => {

  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      transactionReference TEXT,
      depositId TEXT,
      agentName TEXT,
      customerNumber TEXT,
      amount REAL,
      depositDate TEXT,
      agentNumber TEXT,
      imageLink TEXT,
      date TEXT,
      essStatus TEXT,
      status TEXT,
      agentStatus TEXT,
      confirmedBy TEXT,
      chatId TEXT,
      brand TEXT,
      sent INTEGER DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
      reason TEXT
    )
  `);

  db.all(`PRAGMA table_info(transactions)`, (err, rows) => {
  if (err) return console.error(err);

  const hasReason = rows.some(col => col.name === "reason");
  const hasActionStatus = rows.some(col => col.name === "actionStatus");

  if (!hasReason) {
    db.run(`ALTER TABLE transactions ADD COLUMN reason TEXT`);
  }
  if (!hasActionStatus) {
    db.run(`ALTER TABLE transactions ADD COLUMN actionStatus TEXT DEFAULT 'PENDING'`);
  }
});

  db.run(`
CREATE TABLE IF NOT EXISTS chat_ids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agentName TEXT,
  groupName TEXT,
  chatId TEXT,
  type TEXT
)
`);

  db.run(`
CREATE TABLE IF NOT EXISTS wallets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  walletAccountId TEXT,
  walletId TEXT,
  walletType TEXT,
  ownerName TEXT,
  accountType TEXT,
  network TEXT,
  currency TEXT,
  balance REAL,
  status TEXT,
  agentGroup TEXT,
  depositDailyLimit REAL,
  withdrawalDailyLimit REAL,
  todayDeposits REAL,
  todayWithdrawals REAL,
  depositPriority INTEGER,
  withdrawalPriority INTEGER,
  remarks TEXT,
  createdAt TEXT
)
`);

db.run(`
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY,
  botToken TEXT,
  googleApi TEXT,
  gsheetLink TEXT,
  sheetNames TEXT
)
`);

db.run(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  password TEXT,
  role TEXT
)
`);

db.run(`
INSERT OR IGNORE INTO users (username, password, role)
VALUES 
('rey', '123456c', 'developer'),
('admin', 'admin123', 'admin'),
('user', 'user123', 'user')
`);

});

module.exports = db;

