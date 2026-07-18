const { Pool } = require("pg");

const COLUMN_NAMES = [
  "id",
  "transactionReference",
  "depositId",
  "agentName",
  "customerNumber",
  "amount",
  "depositDate",
  "agentNumber",
  "imageLink",
  "videoLink",
  "date",
  "essStatus",
  "status",
  "agentStatus",
  "confirmedBy",
  "confirmedAt",
  "settledAt",
  "settledBy",
  "chatId",
  "brand",
  "sent",
  "createdAt",
  "reason",
  "actionStatus",
  "smsMatched",
  "telegramMessageId",
  "followUpCount",
  "lastFollowUpAt",
  "syncedAt",
  "gsheetUpdated",
  "gsheetStatus",
  "voicemailProvided",
  "voicemailDeadline",
  "voicemailLink",
  "transcript",
  "translation",
  "caseStatus",
  "walletAccountId",
  "walletId",
  "walletType",
  "ownerName",
  "accountType",
  "network",
  "currency",
  "openingBalance",
  "balance",
  "agentGroup",
  "depositDailyLimit",
  "withdrawalDailyLimit",
  "todayDeposits",
  "todayWithdrawals",
  "depositPriority",
  "withdrawalPriority",
  "remarks",
  "uploadedAt",
  "shop",
  "normalizedShop",
  "direction",
  "normalizedOwnerName",
  "normalizedWalletType",
  "walletActive",
  "personalAccountId",
  "teamLeader",
  "appCondition",
  "walletCondition",
  "depositStatus",
  "withdrawalStatus",
  "deviceName",
  "deviceId",
  "appVersion",
  "smsPermission",
  "notificationListener",
  "appNotifications",
  "fullScreenAlert",
  "batteryOptimizationDisabled",
  "lastActive",
  "lastApiSync",
  "apiBalance",
  "apiFailures",
  "lastApiFailReason",
  "lastApiFailAt",
  "sender",
  "receiver",
  "message",
  "passwordHash",
  "ownerId",
  "locked",
  "type",
  "title",
  "meta",
  "isRead",
  "groupName",
  "accountName",
  "enabled",
  "username",
  "password",
  "role",
  "level",
  "botToken",
  "gsheetLink",
  "sheetNames",
  "videoGsheetLink",
  "videoSheetNames",
  "followUpIntervalMinutes",
  "followUpEnabled",
  "followUpStartTime",
  "followUpEndTime",
  "followUpMessageText",
  "followUpMessageFields",
  "followUpDeletePrevious",
  "followUpImagePreview",
  "followUpImageFormat",
  "followUpExcludedAgents",
  "sheetColumnMap",
  "sheetUpdateColumnMap",
  "manualReplyParser",
  "openingBalanceShopColumn",
  "openingBalanceAmountColumn",
  "settlementSheetLink",
  "settlementWorksheetName",
  "settlementAgentColumn",
  "settlementWalletColumn",
  "settlementAmountColumn",
  "settlementDateColumn",
  "balanceCalculationSettings",
  "balanceWatchlistSections",
  "walletTypes",
  "balanceTodaySource",
  "formatTransactionAmounts",
  "permission",
  "allowed"
];

const COLUMN_MAP = COLUMN_NAMES.reduce((map, name) => {
  map[name.toLowerCase()] = name;
  return map;
}, {});

function normalizeArgs(params, callback) {
  if (typeof params === "function") {
    return { params: [], callback: params };
  }

  return {
    params: Array.isArray(params) ? params : (params === undefined ? [] : [params]),
    callback: typeof callback === "function" ? callback : undefined
  };
}

function mapRow(row) {
  if (!row) return row;

  return Object.entries(row).reduce((mapped, [key, value]) => {
    mapped[COLUMN_MAP[key.toLowerCase()] || key] = value;
    return mapped;
  }, {});
}

function convertPlaceholders(sql) {
  let index = 0;
  let quote = null;
  let escaped = false;
  let converted = "";

  for (const char of sql) {
    if (quote) {
      converted += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      converted += char;
      continue;
    }

    if (char === "?") {
      index += 1;
      converted += `$${index}`;
      continue;
    }

    converted += char;
  }

  return converted;
}

function convertSql(sql) {
  let converted = convertPlaceholders(String(sql || ""));
  const hadInsertOrIgnore = /\bINSERT\s+OR\s+IGNORE\s+INTO\b/i.test(converted);

  converted = converted
    .replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, "SERIAL PRIMARY KEY")
    .replace(/\bDATETIME\b(?!\s*\()/gi, "TIMESTAMPTZ")
    .replace(/\bREAL\b/gi, "DOUBLE PRECISION")
    .replace(/\s+COLLATE\s+NOCASE\b/gi, "")
    .replace(/\bLIKE\b/g, "ILIKE")
    .replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, "INSERT INTO");

  converted = converted.replace(/datetime\(\s*'now'\s*,\s*'([^']+)'\s*\)/gi, "(CURRENT_TIMESTAMP + INTERVAL '$1')");
  converted = converted.replace(/datetime\(\s*'now'\s*,\s*(\$\d+)\s*\)/gi, "(CURRENT_TIMESTAMP + ($1)::interval)");
  converted = converted.replace(/datetime\(\s*'now'\s*\)/gi, "CURRENT_TIMESTAMP");
  converted = converted.replace(/datetime\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*'([^']+)'\s*\)/gi, "(CAST($1 AS TIMESTAMPTZ) + INTERVAL '$2')");
  converted = converted.replace(/datetime\(\s*(COALESCE\([^)]+\)|[A-Za-z_][A-Za-z0-9_]*)\s*\)/gi, "CAST($1 AS TIMESTAMPTZ)");
  converted = converted.replace(/date\(\s*'now'\s*,\s*'([^']+)'\s*\)/gi, "(CURRENT_TIMESTAMP + INTERVAL '$1')::date");
  converted = converted.replace(/date\(\s*(\$\d+|[A-Za-z_][A-Za-z0-9_]*)\s*\)/gi, "CAST($1 AS DATE)");

  if (hadInsertOrIgnore && !/\bON\s+CONFLICT\b/i.test(converted)) {
    converted = converted.replace(/;\s*$/, "") + " ON CONFLICT DO NOTHING";
  }

  converted = converted.replace(/\bexcluded\.([A-Za-z_][A-Za-z0-9_]*)/g, (match, column) => {
    return `excluded.${column.toLowerCase()}`;
  });

  return converted;
}

function getPragmaTableName(sql) {
  const match = String(sql || "").match(/^\s*PRAGMA\s+table_info\(([^)]+)\)/i);
  return match ? match[1].replace(/["'`]/g, "").trim() : null;
}

function getSqliteSequenceTableName(sql, params) {
  if (!/DELETE\s+FROM\s+sqlite_sequence/i.test(String(sql || ""))) return null;
  if (params?.[0]) return String(params[0]);

  const match = String(sql || "").match(/DELETE\s+FROM\s+sqlite_sequence\s+WHERE\s+name\s*=\s*'([^']+)'/i);
  return match ? match[1] : null;
}

function quoteIdentifier(identifier) {
  const clean = String(identifier || "").replace(/[^A-Za-z0-9_]/g, "").toLowerCase();
  if (!clean) return null;
  return `"${clean.replace(/"/g, "\"\"")}"`;
}

class PgStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
  }

  run(...args) {
    const callback = typeof args[args.length - 1] === "function" ? args.pop() : undefined;
    const params = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
    return this.db.run(this.sql, params, callback);
  }

  finalize(callback) {
    if (typeof callback === "function") {
      this.db._enqueue(async () => callback(null));
    }
  }
}

function isIgnorableMigrationError(sql, err) {
  const text = String(sql || "");

  return Boolean(
    err
    && err.code === "42701"
    && /\bALTER\s+TABLE\b/i.test(text)
    && /\bADD\s+COLUMN\b/i.test(text)
  );
}

class PostgresDatabase {
  constructor() {
    this.client = "postgres";
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined
    });
    this.ready = this.pool.query("SELECT 1")
      .then(() => console.log("Connected to PostgreSQL"))
      .catch((err) => {
        console.error("PostgreSQL connection failed:", err.message);
        throw err;
      });
    this._queue = this.ready.catch(() => {});
  }

  _enqueue(task) {
    this._queue = this._queue.then(task);
    return this._queue;
  }

  serialize(fn) {
    if (typeof fn === "function") fn();
  }

  all(sql, params, callback) {
    const args = normalizeArgs(params, callback);
    const pragmaTable = getPragmaTableName(sql);

    this._enqueue(async () => {
      try {
        if (pragmaTable) {
          const result = await this.pool.query(
            `
              SELECT column_name AS name
              FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = $1
              ORDER BY ordinal_position
            `,
            [pragmaTable.toLowerCase()]
          );
          args.callback?.(null, result.rows.map(mapRow));
          return;
        }

        const result = await this.pool.query(convertSql(sql), args.params);
        args.callback?.(null, result.rows.map(mapRow));
      } catch (err) {
        args.callback?.(err);
      }
    });

    return this;
  }

  get(sql, params, callback) {
    const args = normalizeArgs(params, callback);

    this._enqueue(async () => {
      try {
        const result = await this.pool.query(convertSql(sql), args.params);
        args.callback?.(null, mapRow(result.rows[0]));
      } catch (err) {
        args.callback?.(err);
      }
    });

    return this;
  }

  run(sql, params, callback) {
    const args = normalizeArgs(params, callback);

    this._enqueue(async () => {
      const meta = { changes: 0, lastID: undefined };

      try {
        const sequenceTable = getSqliteSequenceTableName(sql, args.params);
        if (sequenceTable) {
          await this.resetSerial(sequenceTable, true);
          args.callback?.call(meta, null);
          return;
        }

        const result = await this.pool.query(convertSql(sql), args.params);
        meta.changes = result.rowCount || 0;
        meta.lastID = result.rows?.[0]?.id;
        args.callback?.call(meta, null);
      } catch (err) {
        if (isIgnorableMigrationError(sql, err)) {
          args.callback?.call(meta, null);
          return;
        }

        args.callback?.call(meta, err);
      }
    });

    return this;
  }

  prepare(sql) {
    return new PgStatement(this, sql);
  }

  async query(sql, params = []) {
    await this.ready;
    const result = await this.pool.query(convertSql(sql), params);
    return {
      ...result,
      rows: result.rows.map(mapRow)
    };
  }

  async resetSerial(table, restartAtOne = false) {
    const tableName = String(table || "").replace(/[^A-Za-z0-9_]/g, "").toLowerCase();
    const quotedTableName = quoteIdentifier(tableName);
    if (!tableName || !quotedTableName) return;

    const sequenceResult = await this.pool.query(
      "SELECT pg_get_serial_sequence($1, 'id') AS sequence_name",
      [tableName]
    );

    const sequenceName = sequenceResult.rows?.[0]?.sequence_name;
    if (!sequenceName) return;

    if (restartAtOne) {
      await this.pool.query(`ALTER SEQUENCE ${sequenceName} RESTART WITH 1`);
      return;
    }

    await this.pool.query(`
      SELECT setval(
        $1,
        GREATEST(COALESCE((SELECT MAX(id) FROM ${quotedTableName}), 0), 1),
        COALESCE((SELECT MAX(id) FROM ${quotedTableName}), 0) > 0
      )
    `, [sequenceName]);
  }

  async waitForIdle() {
    await this._queue;
  }

  async close() {
    await this.pool.end();
  }
}

function createPostgresDatabase() {
  return new PostgresDatabase();
}

module.exports = { createPostgresDatabase, convertSql, mapRow };
