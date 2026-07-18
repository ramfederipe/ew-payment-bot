require("dotenv").config();
const path = require("path");

const dbPath = path.join(__dirname, "database.db");
const requestedClient = String(process.env.DB_CLIENT || "").toLowerCase();
const usePostgres = requestedClient === "postgres"
  || (requestedClient !== "sqlite" && Boolean(process.env.DATABASE_URL));

let db;

if (usePostgres) {
  const { createPostgresDatabase } = require("./lib/postgresDatabase");
  db = createPostgresDatabase();
} else {
  const sqlite3 = require("sqlite3").verbose();

  db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      console.error("DB Connection Failed:", err.message);
    } else {
      console.log("Connected to SQLite");
    }
  });

  db.client = "sqlite";
}
db.serialize(() => {


  // =========================
  // TRANSACTIONS
  // =========================

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
    videoLink TEXT,

    date TEXT,

    essStatus TEXT,
    status TEXT,
    agentStatus TEXT,

    confirmedBy TEXT,
    confirmedAt DATETIME,

    settledAt TEXT,
    settledBy TEXT,

    chatId TEXT,
    brand TEXT,

    sent INTEGER DEFAULT 0,

    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,

    reason TEXT,

    actionStatus TEXT DEFAULT 'PENDING',

    smsMatched INTEGER DEFAULT 0,

    telegramMessageId TEXT,
    followUpCount INTEGER DEFAULT 0,
    lastFollowUpAt DATETIME,

    syncedAt TEXT,

    gsheetUpdated INTEGER DEFAULT 0,
    gsheetStatus TEXT DEFAULT 'PENDING'
  )
`);

    db.run(`
  CREATE TABLE IF NOT EXISTS video_cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    transactionReference TEXT,
    depositId TEXT,

    agentName TEXT,
    customerNumber TEXT,

    amount REAL,

    depositDate TEXT,
    agentNumber TEXT,

    videoLink TEXT,

    date TEXT,

    status TEXT DEFAULT 'PENDING',

    brand TEXT,

    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,

    sent INTEGER DEFAULT 0,

    agentStatus TEXT,

    confirmedBy TEXT,
    chatId TEXT,

    reason TEXT,

    confirmedAt TEXT,

    caseStatus TEXT,

    voicemailProvided INTEGER DEFAULT 0,
    voicemailDeadline TEXT,
    voicemailLink TEXT,

    telegramMessageId INTEGER,

    transcript TEXT,
    translation TEXT,

    actionStatus TEXT,

    smsMatched INTEGER DEFAULT 0,

    settledBy TEXT,
    settledAt TEXT
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

    openingBalance REAL DEFAULT 0,

    balance REAL DEFAULT 0,

    status TEXT,

    agentGroup TEXT,

    depositDailyLimit REAL DEFAULT 0,
    withdrawalDailyLimit REAL DEFAULT 0,

    todayDeposits REAL DEFAULT 0,
    todayWithdrawals REAL DEFAULT 0,

    depositPriority INTEGER DEFAULT 0,
    withdrawalPriority INTEGER DEFAULT 0,

    remarks TEXT,

    createdAt TEXT DEFAULT CURRENT_TIMESTAMP,

    uploadedAt TEXT

  )
`);

db.run(`
  CREATE INDEX IF NOT EXISTS idx_wallet_status
  ON wallets(status)
`);

db.run(`
  CREATE INDEX IF NOT EXISTS idx_wallet_type
  ON wallets(walletType)
`);

db.run(`
  CREATE INDEX IF NOT EXISTS idx_wallet_group
  ON wallets(agentGroup)
`);

db.run(`
  CREATE INDEX IF NOT EXISTS idx_wallet_account
  ON wallets(accountType)
`);

db.run(`
  CREATE INDEX IF NOT EXISTS idx_transactions_deposit_ref
  ON transactions(depositId, transactionReference)
`);

db.run(`
  CREATE INDEX IF NOT EXISTS idx_transactions_action_id
  ON transactions(actionStatus, id DESC)
`);

db.run(`
  CREATE INDEX IF NOT EXISTS idx_transactions_pending_filters
  ON transactions(actionStatus, brand, essStatus, agentStatus, sent, smsMatched, id DESC)
`);

db.run(`
  CREATE INDEX IF NOT EXISTS idx_transactions_agent_name
  ON transactions(agentName)
`);

db.run(`
  CREATE INDEX IF NOT EXISTS idx_video_cases_deposit_ref
  ON video_cases(depositId, transactionReference)
`);

db.all(`PRAGMA table_info(wallets)`, (err, rows) => {
  if (err) {
    console.error("Wallet migration error:", err);
    return;
  }

  const columns = rows.map(col => col.name);

  if (!columns.includes("openingBalance")) {
    db.run(`ALTER TABLE wallets ADD COLUMN openingBalance REAL DEFAULT 0`, (err) => {
      if (err) {
        console.error("Failed to add openingBalance:", err);
        return;
      }

      db.run(`
        UPDATE wallets
        SET openingBalance = COALESCE(balance, 0)
        WHERE openingBalance IS NULL OR openingBalance = 0
      `);
    });
  }

  if (!columns.includes("uploadedAt")) {
    db.run(`ALTER TABLE wallets ADD COLUMN uploadedAt TEXT`, (err) => {
      if (err) {
        console.error("Failed to add wallet uploadedAt:", err);
      }
    });
  }
});

db.run(`
  CREATE TABLE IF NOT EXISTS opening_balances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop TEXT NOT NULL,
    normalizedShop TEXT NOT NULL UNIQUE,
    openingBalance REAL DEFAULT 0,
    uploadedAt TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS wallet_daily_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direction TEXT NOT NULL,
    ownerName TEXT NOT NULL,
    normalizedOwnerName TEXT NOT NULL,
    walletType TEXT NOT NULL,
    normalizedWalletType TEXT NOT NULL,
    amount REAL DEFAULT 0,
    status TEXT,
    uploadedAt TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

db.run(`
  CREATE INDEX IF NOT EXISTS idx_wallet_daily_activity_lookup
  ON wallet_daily_activity(direction, normalizedOwnerName, normalizedWalletType)
`);

db.run(`
  CREATE INDEX IF NOT EXISTS idx_opening_balances_shop
  ON opening_balances(normalizedShop)
`);

db.run(`
  CREATE TABLE IF NOT EXISTS wallet_health (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    walletAccountId TEXT,
    walletId TEXT,
    walletType TEXT,
    accountType TEXT,
    walletActive TEXT,
    personalAccountId TEXT,
    ownerName TEXT,
    teamLeader TEXT,
    agentGroup TEXT,
    appCondition TEXT,
    depositStatus TEXT,
    withdrawalStatus TEXT,
    deviceName TEXT,
    deviceId TEXT,
    appVersion TEXT,
    smsPermission TEXT,
    notificationListener TEXT,
    appNotifications TEXT,
    fullScreenAlert TEXT,
    batteryOptimizationDisabled TEXT,
    lastActive TEXT,
    lastApiSync TEXT,
    apiBalance REAL DEFAULT 0,
    apiFailures INTEGER DEFAULT 0,
    lastApiFailReason TEXT,
    lastApiFailAt TEXT,
    uploadedAt TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

db.all(`PRAGMA table_info(wallet_health)`, (err, rows) => {
  if (err) {
    console.error("Wallet health migration error:", err);
    return;
  }

  const columns = rows.map(col => col.name);
  if (!columns.includes("apiBalance")) {
    db.run(`ALTER TABLE wallet_health ADD COLUMN apiBalance REAL DEFAULT 0`, (err) => {
      if (err) console.error("Failed to add wallet_health.apiBalance:", err);
    });
  }
});

db.run(`
  CREATE INDEX IF NOT EXISTS idx_wallet_health_group
  ON wallet_health(agentGroup)
`);

db.run(`
  CREATE INDEX IF NOT EXISTS idx_wallet_health_condition
  ON wallet_health(appCondition)
`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT,
    receiver TEXT,
    message TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.run(`
  CREATE INDEX IF NOT EXISTS idx_messages_receiver_created
  ON messages(receiver, createdAt)
`);

db.run(`
  CREATE TABLE IF NOT EXISTS log_settings (
    id INTEGER PRIMARY KEY,

    chatId TEXT,

    passwordHash TEXT,

    ownerId INTEGER,

    locked INTEGER DEFAULT 0
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    type TEXT,

    title TEXT,

    message TEXT,

    meta TEXT,

    isRead INTEGER DEFAULT 0,

    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

  // =========================
  // AUTO MIGRATION
  // =========================

  db.all(`PRAGMA table_info(transactions)`, (err, rows) => {

    if (err) {
      console.error(err);
      return;
    }

    const columns = rows.map(col => col.name);

    const migrations = [

      {
        name: "reason",
        sql: `ALTER TABLE transactions ADD COLUMN reason TEXT`
      },

      {
        name: "actionStatus",
        sql: `
          ALTER TABLE transactions
          ADD COLUMN actionStatus TEXT DEFAULT 'PENDING'
        `
      },

      {
        name: "videoLink",
        sql: `
          ALTER TABLE transactions
          ADD COLUMN videoLink TEXT
        `
      },

      {
        name: "confirmedAt",
        sql: `
          ALTER TABLE transactions
          ADD COLUMN confirmedAt DATETIME
        `
      },

      {
        name: "smsMatched",
        sql: `
          ALTER TABLE transactions
          ADD COLUMN smsMatched INTEGER DEFAULT 0
        `
      },

      {
        name: "telegramMessageId",
        sql: `
          ALTER TABLE transactions
          ADD COLUMN telegramMessageId TEXT
        `
      },

      {
        name: "followUpCount",
        sql: `
          ALTER TABLE transactions
          ADD COLUMN followUpCount INTEGER DEFAULT 0
        `
      },

      {
        name: "lastFollowUpAt",
        sql: `
          ALTER TABLE transactions
          ADD COLUMN lastFollowUpAt DATETIME
        `
      },

      {
        name: "gsheetUpdated",
        sql: `
          ALTER TABLE transactions
          ADD COLUMN gsheetUpdated INTEGER DEFAULT 0
        `
      },

      {
        name: "gsheetStatus",
        sql: `
          ALTER TABLE transactions
          ADD COLUMN gsheetStatus TEXT DEFAULT 'PENDING'
        `
      }

    ];

    migrations.forEach(migration => {

      if (!columns.includes(migration.name)) {

        db.run(migration.sql, (err) => {

          if (err) {
            console.error(`❌ Failed to add ${migration.name}:`, err);

          } else {
            console.log(`✅ Added column: ${migration.name}`);
          }

        });

      }

    });

  });

  db.all(`PRAGMA table_info(video_cases)`, (err, rows) => {

    if (err) {
      console.error(err);
      return;
    }

    const columns = rows.map(col => col.name);

    const migrations = [
      {
        name: "smsMatched",
        sql: `
          ALTER TABLE video_cases
          ADD COLUMN smsMatched INTEGER DEFAULT 0
        `
      }
    ];

    migrations.forEach(migration => {

      if (!columns.includes(migration.name)) {

        db.run(migration.sql, (err) => {

          if (err) {
            console.error(`Failed to add video_cases.${migration.name}:`, err);

          } else {
            console.log(`Added video_cases column: ${migration.name}`);
          }

        });

      }

    });

  });

  // =========================
  // CHAT IDS
  // =========================

  db.run(`
    CREATE TABLE IF NOT EXISTS chat_ids (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agentName TEXT,
      groupName TEXT,
      chatId TEXT,
      type TEXT,
      gsheetLink TEXT
    )
  `);

  db.all(`PRAGMA table_info(chat_ids)`, (err, rows) => {
    if (err) {
      console.error("Failed to inspect chat_ids columns:", err);
      return;
    }

    if (!(rows || []).some(row => String(row.name || "").toLowerCase() === "gsheetlink")) {
      db.run(`ALTER TABLE chat_ids ADD COLUMN gsheetLink TEXT`, alterErr => {
        if (alterErr) console.error("Failed to add chat_ids.gsheetLink:", alterErr);
        else console.log("Added chat_ids column: gsheetLink");
      });
    }
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS gsheet_allowed_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      accountName TEXT UNIQUE,
      enabled INTEGER DEFAULT 1,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_gsheet_allowed_accounts_name
    ON gsheet_allowed_accounts(accountName)
  `);

  // =========================
  // USERS
  // =========================

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT,
      role TEXT,
      lastActive DATETIME,
      status TEXT DEFAULT 'ACTIVE'
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS system_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT,
      message TEXT,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY,
    botToken TEXT,
    gsheetLink TEXT,
    sheetNames TEXT,
    videoGsheetLink TEXT,
    videoSheetNames TEXT,
    followUpIntervalMinutes INTEGER DEFAULT 30,
    followUpEnabled INTEGER DEFAULT 1,
    followUpStartTime TEXT,
    followUpEndTime TEXT,
    followUpMessageText TEXT,
    followUpMessageFields TEXT,
    followUpDeletePrevious INTEGER DEFAULT 0,
    followUpImagePreview INTEGER DEFAULT 0,
    followUpImageFormat TEXT DEFAULT 'link',
    followUpExcludedAgents TEXT,
    sheetColumnMap TEXT,
    sheetUpdateColumnMap TEXT,
    manualReplyParser TEXT,
    openingBalanceShopColumn TEXT DEFAULT 'SHOP',
    openingBalanceAmountColumn TEXT DEFAULT 'BALANCE',
    settlementSheetLink TEXT,
    settlementWorksheetName TEXT,
    settlementAgentColumn TEXT DEFAULT 'Agent Name',
    settlementWalletColumn TEXT DEFAULT 'Wallet',
    settlementAmountColumn TEXT DEFAULT 'Amount',
    settlementDateColumn TEXT DEFAULT 'Date',
    balanceCalculationSettings TEXT,
    balanceWatchlistSections TEXT,
    walletTypes TEXT,
    balanceTodaySource TEXT DEFAULT 'upload',
    formatTransactionAmounts INTEGER DEFAULT 1
  )
`);

db.all(`PRAGMA table_info(settings)`, (err, rows) => {
  if (err) {
    console.error("❌ SETTINGS MIGRATION ERROR:", err);
    return;
  }

  const columns = rows.map(col => col.name);

  const settingsMigrations = [
    {
      name: "followUpIntervalMinutes",
      sql: `
        ALTER TABLE settings
        ADD COLUMN followUpIntervalMinutes INTEGER DEFAULT 30
      `
    },
    {
      name: "followUpEnabled",
      sql: `
        ALTER TABLE settings
        ADD COLUMN followUpEnabled INTEGER DEFAULT 1
      `
    },
    {
      name: "followUpStartTime",
      sql: `
        ALTER TABLE settings
        ADD COLUMN followUpStartTime TEXT
      `
    },
    {
      name: "followUpEndTime",
      sql: `
        ALTER TABLE settings
        ADD COLUMN followUpEndTime TEXT
      `
    },
    {
      name: "followUpMessageText",
      sql: `
        ALTER TABLE settings
        ADD COLUMN followUpMessageText TEXT
      `
    },
    {
      name: "followUpMessageFields",
      sql: `
        ALTER TABLE settings
        ADD COLUMN followUpMessageFields TEXT
      `
    },
    {
      name: "followUpDeletePrevious",
      sql: `
        ALTER TABLE settings
        ADD COLUMN followUpDeletePrevious INTEGER DEFAULT 0
      `
    },
    {
      name: "followUpImagePreview",
      sql: `
        ALTER TABLE settings
        ADD COLUMN followUpImagePreview INTEGER DEFAULT 0
      `
    },
    {
      name: "followUpImageFormat",
      sql: `
        ALTER TABLE settings
        ADD COLUMN followUpImageFormat TEXT DEFAULT 'link'
      `
    },
    {
      name: "followUpExcludedAgents",
      sql: `
        ALTER TABLE settings
        ADD COLUMN followUpExcludedAgents TEXT
      `
    },
    {
      name: "sheetColumnMap",
      sql: `
        ALTER TABLE settings
        ADD COLUMN sheetColumnMap TEXT
      `
    },
    {
      name: "sheetUpdateColumnMap",
      sql: `
        ALTER TABLE settings
        ADD COLUMN sheetUpdateColumnMap TEXT
      `
    },
    {
      name: "manualReplyParser",
      sql: `
        ALTER TABLE settings
        ADD COLUMN manualReplyParser TEXT
      `
    },
    {
      name: "openingBalanceShopColumn",
      sql: `
        ALTER TABLE settings
        ADD COLUMN openingBalanceShopColumn TEXT DEFAULT 'SHOP'
      `
    },
    {
      name: "openingBalanceAmountColumn",
      sql: `
        ALTER TABLE settings
        ADD COLUMN openingBalanceAmountColumn TEXT DEFAULT 'BALANCE'
      `
    },
    {
      name: "settlementSheetLink",
      sql: `
        ALTER TABLE settings
        ADD COLUMN settlementSheetLink TEXT
      `
    },
    {
      name: "settlementWorksheetName",
      sql: `
        ALTER TABLE settings
        ADD COLUMN settlementWorksheetName TEXT
      `
    },
    {
      name: "settlementAgentColumn",
      sql: `
        ALTER TABLE settings
        ADD COLUMN settlementAgentColumn TEXT DEFAULT 'Agent Name'
      `
    },
    {
      name: "settlementWalletColumn",
      sql: `
        ALTER TABLE settings
        ADD COLUMN settlementWalletColumn TEXT DEFAULT 'Wallet'
      `
    },
    {
      name: "settlementAmountColumn",
      sql: `
        ALTER TABLE settings
        ADD COLUMN settlementAmountColumn TEXT DEFAULT 'Amount'
      `
    },
    {
      name: "settlementDateColumn",
      sql: `
        ALTER TABLE settings
        ADD COLUMN settlementDateColumn TEXT DEFAULT 'Date'
      `
    },
    {
      name: "balanceCalculationSettings",
      sql: `
        ALTER TABLE settings
        ADD COLUMN balanceCalculationSettings TEXT
      `
    },
    {
      name: "balanceWatchlistSections",
      sql: `
        ALTER TABLE settings
        ADD COLUMN balanceWatchlistSections TEXT
      `
    },
    {
      name: "walletTypes",
      sql: `
        ALTER TABLE settings
        ADD COLUMN walletTypes TEXT
      `
    },
    {
      name: "balanceTodaySource",
      sql: `
        ALTER TABLE settings
        ADD COLUMN balanceTodaySource TEXT DEFAULT 'upload'
      `
    },
    {
      name: "formatTransactionAmounts",
      sql: `
        ALTER TABLE settings
        ADD COLUMN formatTransactionAmounts INTEGER DEFAULT 1
      `
    }
  ];

  settingsMigrations.forEach(migration => {
    if (!columns.includes(migration.name)) {
      db.run(migration.sql, (err) => {
      if (err) {
        console.error(`❌ Failed to add ${migration.name}:`, err);
      } else {
        console.log(`✅ Added column: ${migration.name}`);
      }
    });
    }
  });
});

db.run(`
  CREATE TABLE IF NOT EXISTS role_permissions (
    role TEXT,
    permission TEXT,
    allowed INTEGER
  )
`);

  db.run(`
INSERT OR IGNORE INTO users (username, password, role, status)
VALUES
('rey', '$2b$12$8GMpCtbYXkMCSBNyuCRD/Oc2oqPqjxVxSdLofSeXM/.lSPs3qeaee', 'developer', 'ACTIVE'),
('admin', '$2b$12$.cS0JbP4FGDEX7r5MtlagO6EuqMNTc.O1uhFSCQGpVluFYrTS0.ku', 'admin', 'ACTIVE'),
('user', '$2b$12$Ko.a7bns56AVp3DiEu5y5uIbAiirtA1Iq.2amHg1y0m57JfO9xBdm', 'user', 'ACTIVE')
`);

});

module.exports = db;

console.log("DB CLIENT:", db.client || (usePostgres ? "postgres" : "sqlite"));
if (!usePostgres) {
  console.log("DB PATH:", dbPath);
}
