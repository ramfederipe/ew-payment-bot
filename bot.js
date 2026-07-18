require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const db = require("./db");
const { getIO } = require("./socket");

let bot;
let activeTelegramToken = "";
let followUpTimeout;
let followUpInterval;
const FOLLOW_UP_CHECK_INTERVAL_MS = 60 * 1000;
const DEFAULT_FOLLOW_UP_INTERVAL_MINUTES = 30;
const MAX_FOLLOW_UPS = 3;
const DEFAULT_PENDING_MESSAGE_FIELDS = ["agent", "ref", "amount", "customer", "image"];
const DEFAULT_MANUAL_REPLY_PARSER = {
  shopLabels: ["Shop Name", "Agent", "Agent Name"],
  agentNumberLabels: ["Agent Number", "Wallet Number", "Agent No"],
  amountLabels: ["Amount"],
  referenceLabels: ["Reference", "Ref"],
  statusLabels: ["Status"],
  receivedKeywords: ["YES", "Y", "RECEIVED"],
  notReceivedKeywords: ["NO", "N", "NOT RECEIVED"]
};
let followUpRunning = false;

const followUpLabels = {
  1: "1st FF",
  2: "2nd FF",
  3: "Final FF"
};

const followUpMessageLabels = {
  1: "1st",
  2: "2nd",
  3: "Final"
};

function addSystemLog(level, message) {
  const cleanLevel = String(level || "INFO").toUpperCase();
  const cleanMessage = String(message || "").replace(/\s+/g, " ").trim().slice(0, 1200);

  db.run(`
    INSERT INTO system_logs (level, message)
    VALUES (?, ?)
  `, [cleanLevel, cleanMessage], (err) => {
    if (err) console.error("BOT SYSTEM LOG ERROR:", err.message);
  });
}

process.on("uncaughtException", (err) => {
  addSystemLog("CRITICAL", `Bot uncaught exception: ${err.stack || err.message}`);
});

process.on("unhandledRejection", (reason) => {
  const message = reason?.stack || reason?.message || String(reason);
  addSystemLog("CRITICAL", `Bot unhandled rejection: ${message}`);
});

function getBot() {
  return bot;
}

function scheduleFollowUps() {
  if (!followUpTimeout) {
    followUpTimeout = setTimeout(runPendingFollowUps, 5 * 1000);
  }

  if (!followUpInterval) {
    followUpInterval = setInterval(runPendingFollowUps, FOLLOW_UP_CHECK_INTERVAL_MS);
  }
}

function initializeBotFromSettings() {
db.get(`SELECT * FROM settings WHERE id = 1`, (err, row) => {

  if (err) {
    console.error("❌ Failed to load bot settings:", err);
    addSystemLog("ERROR", `Bot settings load failed: ${err.message}`);
    return;
  }

  // 🔥 use DB token if available
  if (row?.botToken && row.botToken !== process.env.TELEGRAM_TOKEN) {

    console.log("✅ Using Telegram token from settings");
    addSystemLog("INFO", "Bot initialized with Telegram token from settings");

    process.env.TELEGRAM_TOKEN = row.botToken;

  } else {

    console.log("ℹ️ Using .env Telegram token");
    addSystemLog("INFO", "Bot initialized with Telegram token from .env");

  }
  const telegramToken = String(process.env.TELEGRAM_TOKEN || "").trim();

  if (!telegramToken) {
    console.error("Telegram bot token is not set. Save it in Settings or TELEGRAM_TOKEN before starting polling.");
    addSystemLog("ERROR", "Telegram bot token is not set. Save it in Settings or TELEGRAM_TOKEN before starting polling.");
    return;
  }

  if (bot && activeTelegramToken === telegramToken) {
    console.log("Telegram bot already initialized with the current token");
    return;
  }

  if (bot) {
    bot.removeAllListeners();
    bot.stopPolling().catch((stopErr) => {
      console.error("Telegram polling stop failed:", stopErr.message);
    });
  }

  activeTelegramToken = telegramToken;

  bot = new TelegramBot(
    telegramToken,
    { polling: true }
  );
  bot.on("polling_error", (pollingErr) => {
    console.error("TELEGRAM POLLING ERROR:", pollingErr.message);
    addSystemLog("ERROR", `Telegram polling error: ${pollingErr.message}`);
  });

  scheduleFollowUps();

  /* ===============================
   📥 CALLBACK HANDLER
================================ */
bot.on("callback_query", (query) => {

  console.log("📥 CLICK:", query.data);

  const parts = query.data.split("_");

  let type = "pending";
  let action, id, reason;

  if (parts[0] === "video") {
    type = "video";
    action = parts[1];
    id = parseInt(parts[2]);
  } else {
    action = parts[0];
    id = parseInt(parts[1]);
    reason = parts[2];
  }

  const username = query.from.username || query.from.first_name;
  const chatId = query.from.id;

  console.log("👉 ACTION:", action);
  console.log("👉 ID:", id);
  console.log("👉 REASON:", reason);

  /* ===============================
     🎥 VIDEO CASE
  ============================== */
  if (type === "video") {

    db.get(`SELECT * FROM video_cases WHERE id=?`, [id], (err, row) => {
      if (!row) return;

      const status = action === "yes" ? "RECEIVED" : "NOT RECEIVED";

      let caseStatus = "";
      let reasonText = "";

      if (action === "yes") {
        caseStatus = "FOR APPROVAL";
      }

      if (action === "no") {
        caseStatus = "WAITING VOICEMAIL";
        reasonText = "Waiting for voicemail";

        db.run(`
          UPDATE video_cases
          SET voicemailDeadline = datetime('now', '+3 days')
          WHERE id = ?
        `, [id]);

        bot.sendMessage(query.message.chat.id, `
⚠️ NOT RECEIVED

Please provide voicemail within 3 days.

📌 Reply directly to the VIDEO message
📌 Call network CS
📌 Record call
📌 Send audio here

Failure = auto approval.
`);
      }

      db.run(`
        UPDATE video_cases
        SET agentStatus=?, caseStatus=?, confirmedBy=?, reason=?, confirmedAt=datetime('now')
        WHERE id=?
      `, [status, caseStatus, username, reasonText, id]);

      getIO()?.emit("update", {
  id,
  status,
  username,
  reason: reasonText || "",
  confirmedAt: new Date().toISOString(),
  sent: 1,
  type: type
});

      bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id
      }).catch(() => {});

      const updatedCaption =
`${status === "RECEIVED" ? "✅ RECEIVED" : "❌ NOT RECEIVED"}
${reasonText ? "\nReason: " + reasonText : ""}

Agent: ${row.agentName}
Ref: ${row.transactionReference}
Amount: ${row.amount}
Customer: ${row.customerNumber}

Confirmed By: ${username}`;

if (row.imageLink) {

  // 🔥 delete original photo message
  bot.deleteMessage(
    query.message.chat.id,
    query.message.message_id
  ).catch(() => {});

  // 🔥 send clean confirmation message
  bot.sendMessage(
    query.message.chat.id,
    updatedCaption
  ).catch(() => {});

} else {

  bot.editMessageText(
    updatedCaption,
    {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id
    }
  ).catch(() => {});

}
    });

    return;
  }

  /* ===============================
     🔥 SHOW REASON OPTIONS
  ============================== */
  if (action === "no" && reason === "select") {

    return bot.editMessageReplyMarkup({
      inline_keyboard: [
        [
          { text: "Wrong Amount", callback_data: `no_${id}_amount` },
          { text: "Wrong Ref", callback_data: `no_${id}_ref` }
        ],
        [
          { text: "Wrong Number", callback_data: `no_${id}_number` },
          { text: "Not Received", callback_data: `no_${id}_not` }
        ]
      ]
    }, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id
    });
  }

  /* ===============================
     💰 FINAL PENDING UPDATE
  ============================== */
  if (action === "back") {
    bot.answerCallbackQuery(query.id).catch(() => {});

    return bot.editMessageReplyMarkup(getDepositAnswerKeyboard(id), {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id
    });
  }

  if (action === "yes" && reason !== "confirm") {
    db.get(`SELECT * FROM transactions WHERE id=?`, [id], (err, row) => {
      if (err || !row) {
        return bot.answerCallbackQuery(query.id, {
          text: "Data not found",
          show_alert: true
        });
      }

      if (["RECEIVED", "NOT RECEIVED", "For Review"].includes(row.agentStatus)) {
        return bot.answerCallbackQuery(query.id, {
          text: "This transaction is already closed for agent answer.",
          show_alert: true
        });
      }

      if (
        row.telegramMessageId &&
        String(row.telegramMessageId) !== String(query.message.message_id)
      ) {
        return bot.answerCallbackQuery(query.id, {
          text: "This follow-up is already expired. Please answer the latest follow-up message.",
          show_alert: true
        });
      }

      bot.answerCallbackQuery(query.id, {
        text: "Tap Confirm to mark this as received."
      }).catch(() => {});

      bot.editMessageReplyMarkup({
        inline_keyboard: [[
          { text: "Back", callback_data: `back_${id}` },
          { text: "Confirm", callback_data: `yes_${id}_confirm` }
        ]]
      }, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id
      }).catch(() => {});
    });

    return;
  }

  if (type === "pending") {

    db.get(`SELECT * FROM transactions WHERE id=?`, [id], (err, row) => {

      if (err) {
  console.log("❌ DB ERROR:", err);
  return;
}

if (!row) {
  console.log("❌ VIDEO NOT FOUND:", id);

  return bot.answerCallbackQuery(query.id, {
    text: "❌ Data not found",
    show_alert: true
  });
}

      if (
        ["RECEIVED", "NOT RECEIVED", "For Review"].includes(row.agentStatus)
      ) {
        return bot.answerCallbackQuery(query.id, {
          text: "This transaction is already closed for agent answer.",
          show_alert: true
        });
      }

      if (
        row.telegramMessageId &&
        String(row.telegramMessageId) !== String(query.message.message_id)
      ) {
        return bot.answerCallbackQuery(query.id, {
          text: "This follow-up is already expired. Please answer the latest follow-up message.",
          show_alert: true
        });
      }

      const map = {
        amount: "Wrong Amount",
        number: "Wrong Number",
        ref: "Wrong Ref",
        not: "Not Received"
      };

      const reasonText = map[reason] || "";
      const status = action === "yes" ? "RECEIVED" : "NOT RECEIVED";

      db.run(`
        UPDATE transactions
        SET agentStatus=?, confirmedBy=?, reason=?, confirmedAt=datetime('now')
        WHERE id=?
      `, [status, username, reasonText, id]);

      // ✅ remove buttons
      bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id
      }).catch(() => {});

      // ✅ update message
const updatedCaption =
`${status === "RECEIVED" ? "✅ RECEIVED" : "❌ NOT RECEIVED"}
${reasonText ? "\nReason: " + reasonText : ""}

Agent: ${row.agentName}
Ref: ${row.transactionReference}
Amount: ${row.amount}
Customer: ${row.customerNumber}

Confirmed By: ${username}`;

if (row.imageLink) {

  // 🔥 delete original photo message
  bot.deleteMessage(
    query.message.chat.id,
    query.message.message_id
  ).catch(() => {});

  // 🔥 send clean confirmation message
  bot.sendMessage(
    query.message.chat.id,
    updatedCaption
  ).catch(() => {});

} else {

  bot.editMessageText(
    updatedCaption,
    {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id
    }
  ).catch(() => {});

}
    });

    return;
  }

});

// 🎤 voice (recorded in Telegram)
bot.on("voice", async (msg) => {
  await handleVoicemail(msg, msg.voice.file_id);
});

bot.on("audio", async (msg) => {
  await handleVoicemail(msg, msg.audio.file_id);
});

bot.on("document", async (msg) => {
  const fileId = msg.document.file_id;
  const fileSize = msg.document.file_size;
  const chatId = msg.chat.id;

  //  ignore unrelated uploads
if (!msg.reply_to_message) {
  return;
}

  if (fileSize > 20 * 1024 * 1024) {
    return bot.sendMessage(
  chatId,
  "❌ File too large.\n\nMax allowed: 20MB\nPlease compress your audio."
).catch(err => {
  console.log("⚠️ Telegram rate limit:", err.message);
});
  }

  // 🔥 VALIDATE AUDIO FILE
const isAudioFile =
  msg.document.mime_type?.startsWith("audio/") ||

  /\.(mp3|wav|ogg|m4a)$/i.test(
    msg.document.file_name || ""
  );

if (!isAudioFile) {

  if (!msg.reply_to_message) return;

  return bot.sendMessage(
    chatId,
    "❌ Invalid file type.\n\nPlease send a real audio file."
  ).catch(err => {
    console.log("⚠️ Telegram rate limit:", err.message);
  });
}

await handleVoicemail(msg, fileId);
});

bot.on("message", async (msg) => {

  console.log("========== RECEIVED MESSAGE ==========");
  console.log(JSON.stringify(msg, null, 2));
  console.log("======================================");

  if (await handleManualAgentStatusMessage(msg)) return;

  const chatId = String(msg.chat.id).replace(".0", "");
  const groupName = (msg.chat.title || "PRIVATE").trim();

  console.log("📩 AUTO DETECT:");
  console.log("CHAT ID:", chatId);
  console.log("GROUP:", groupName);

  db.get(`
    SELECT id FROM chat_ids WHERE groupName = ?
  `, [groupName], (err, row) => {

    if (!row) {
      db.run(`
        INSERT INTO chat_ids (agentName, groupName, chatId)
        VALUES (?, ?, ?)
      `, ["AUTO", groupName, chatId]);

      console.log("✅ NEW GROUP SAVED");
    } else {
      console.log("ℹ️ Group already exists → updating chatId");

      // 🔥 OPTIONAL: update chatId if changed
      db.run(`
        UPDATE chat_ids
        SET chatId = ?
        WHERE groupName = ?
      `, [chatId, groupName]);
    }
});
});

async function handleManualAgentStatusMessage(msg) {
  const parserSettings = await getManualReplyParserSettings();
  const parsed = parseManualAgentStatus(msg.text || msg.caption || "", parserSettings);
  if (!parsed) return false;

  try {
    const replyMessageId = msg.reply_to_message?.message_id;
    const replyMatch = replyMessageId
      ? await findManualReplyTransactionByMessage(replyMessageId)
      : null;
    const referenceMatch = replyMatch ? null : await findManualReplyTransactionByReference(parsed);
    const row = replyMatch || referenceMatch?.row || null;

    if (!row) {
      addSystemLog("WARN", `Manual agent reply not matched (ref ${parsed.reference || "-"}, reply ${replyMessageId || "-"}, status ${parsed.rawStatus})`);
      return false;
    }

    const username = msg.from?.username || msg.from?.first_name || msg.chat?.title || "manual_reply";

    await dbRun(`
      UPDATE transactions
      SET agentStatus = ?,
          confirmedBy = ?,
          reason = ?,
          confirmedAt = datetime('now')
      WHERE id = ?
    `, [parsed.status, username, parsed.reason, row.id]);

    await disablePendingButtons(row, `Answered by agent: ${parsed.rawStatus}`);

    getIO()?.emit("update", {
      id: row.id,
      status: parsed.status,
      username,
      reason: parsed.reason,
      confirmedAt: new Date().toISOString(),
      sent: 1,
      type: "pending"
    });

    if (replyMatch) {
      addSystemLog("INFO", `Manual agent reply matched by Telegram reply message ${replyMessageId} for transaction ${row.id}`);
    } else if (!referenceMatch?.strongMatch) {
      addSystemLog("WARN", `Manual agent reply used reference-only match for transaction ${row.id} (${parsed.reference}); reply details may differ from pending row`);
    }

    addSystemLog("INFO", `Manual agent reply updated transaction ${row.id} (${row.transactionReference}) to ${parsed.status}`);

    bot.sendMessage(
      msg.chat.id,
      `✅ Updated ${row.transactionReference} to ${parsed.status}`
    ).catch(() => {});

    return true;
  } catch (err) {
    console.error("MANUAL AGENT REPLY ERROR:", err.message);
    addSystemLog("ERROR", `Manual agent reply failed: ${err.message}`);
    return false;
  }
}

async function findManualReplyTransactionByMessage(messageId) {
  return dbGet(`
    SELECT *
    FROM transactions
    WHERE telegramMessageId = ?
      AND (actionStatus IS NULL OR actionStatus = 'PENDING')
      AND (
        agentStatus IS NULL
        OR agentStatus = ''
        OR agentStatus = 'PENDING'
        OR agentStatus IN ('1st FF', '2nd FF', 'Final FF')
      )
    ORDER BY id DESC
    LIMIT 1
  `, [String(messageId)]);
}

async function findManualReplyTransactionByReference(parsed) {
  if (!parsed.reference) return null;

  const candidates = await dbAll(`
    SELECT *
    FROM transactions
    WHERE UPPER(transactionReference) = ?
      AND (actionStatus IS NULL OR actionStatus = 'PENDING')
      AND (
        agentStatus IS NULL
        OR agentStatus = ''
        OR agentStatus = 'PENDING'
        OR agentStatus IN ('1st FF', '2nd FF', 'Final FF')
      )
    ORDER BY id DESC
    LIMIT 20
  `, [parsed.reference]);

  const exactMatches = candidates.filter(transaction =>
    cleanManualRef(transaction.transactionReference) === parsed.reference
  );

  const strongMatch = exactMatches.find(transaction => {
    const amountMatches = parsed.amount === null || Number(transaction.amount) === parsed.amount;
    const walletMatches = !parsed.agentNumber || walletMatchesManualReply(transaction.agentNumber, parsed.agentNumber);
    const shopMatches = !parsed.shopName || cleanManualText(transaction.agentName).includes(parsed.shopName);

    return amountMatches && walletMatches && shopMatches;
  });

  const row = strongMatch || (exactMatches.length === 1 ? exactMatches[0] : null);

  return row ? { row, strongMatch: Boolean(strongMatch) } : null;
}

function parseManualAgentStatus(text, settings = DEFAULT_MANUAL_REPLY_PARSER) {
  const value = String(text || "").trim();
  if (!value) return null;

  const parser = normalizeManualReplyParser(settings);
  const reference = cleanManualRef(getManualField(value, parser.referenceLabels));
  const rawStatus = getManualField(value, parser.statusLabels);
  const statusText = String(rawStatus || "").trim();

  if (!statusText) return null;

  const normalizedStatus = statusText.replace(/\s+/g, " ").trim().toUpperCase();
  let status = null;
  const hasKeyword = (keywords) => keywords.some(keyword => {
    const normalizedKeyword = cleanManualText(keyword);
    if (!normalizedKeyword) return false;
    return new RegExp(`(^|\\b)${escapeRegExp(normalizedKeyword)}(\\b|$)`, "i").test(normalizedStatus);
  });

  if (hasKeyword(parser.notReceivedKeywords)) {
    status = "NOT RECEIVED";
  }

  if (!status && hasKeyword(parser.receivedKeywords)) {
    status = "RECEIVED";
  }

  if (!status) return null;

  return {
    reference,
    status,
    rawStatus: statusText,
    reason: statusText,
    amount: parseManualAmount(getManualField(value, parser.amountLabels)),
    agentNumber: cleanManualWallet(getManualField(value, parser.agentNumberLabels)),
    shopName: cleanManualText(getManualField(value, parser.shopLabels))
  };
}

async function getManualReplyParserSettings() {
  const row = await new Promise((resolve) => {
    db.get(`
      SELECT manualReplyParser
      FROM settings
      WHERE id = 1
      LIMIT 1
    `, (err, settings) => resolve(err ? null : settings));
  });

  return normalizeManualReplyParser(row?.manualReplyParser);
}

function normalizeManualReplyParser(value) {
  let parser = value;

  if (typeof value === "string" && value.trim()) {
    try {
      parser = JSON.parse(value);
    } catch (err) {
      parser = {};
    }
  }

  if (!parser || typeof parser !== "object") parser = {};

  const normalizeList = (key) => {
    const source = Array.isArray(parser[key])
      ? parser[key]
      : String(parser[key] || "").split(",");
    const values = source.map(item => String(item || "").trim()).filter(Boolean);
    return values.length ? values : DEFAULT_MANUAL_REPLY_PARSER[key];
  };

  return {
    shopLabels: normalizeList("shopLabels"),
    agentNumberLabels: normalizeList("agentNumberLabels"),
    amountLabels: normalizeList("amountLabels"),
    referenceLabels: normalizeList("referenceLabels"),
    statusLabels: normalizeList("statusLabels"),
    receivedKeywords: normalizeList("receivedKeywords"),
    notReceivedKeywords: normalizeList("notReceivedKeywords")
  };
}

function getManualField(text, labels) {
  for (const label of labels) {
    const pattern = new RegExp(`^\\s*${escapeRegExp(label)}\\s*:\\s*(.+?)\\s*$`, "im");
    const match = String(text || "").match(pattern);
    if (match) return match[1].trim();
  }

  return "";
}

function cleanManualRef(value) {
  return String(value || "").trim().toUpperCase().replace(/^="?|"?$/g, "").replace(/[^A-Z0-9]/g, "");
}

function cleanManualWallet(value) {
  return String(value || "").trim().replace(/^="?|"?$/g, "").replace(/\D/g, "");
}

function cleanManualText(value) {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
}

function parseManualAmount(value) {
  const amount = Number(String(value || "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function walletMatchesManualReply(transactionWallet, replyWallet) {
  const transactionVariants = walletVariantsManualReply(transactionWallet);
  const replyVariants = walletVariantsManualReply(replyWallet);
  return transactionVariants.some(wallet => replyVariants.includes(wallet));
}

function walletVariantsManualReply(value) {
  const wallet = cleanManualWallet(value);
  if (!wallet) return [];

  const variants = new Set([wallet]);
  const withoutLeadingZeroes = wallet.replace(/^0+/, "");

  if (withoutLeadingZeroes) variants.add(withoutLeadingZeroes);
  if (wallet.length > 10) variants.add(wallet.slice(-10));

  return [...variants];
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
});
}

initializeBotFromSettings();

const { transcribeAndTranslate } = require("./helpers/transcribe");


/* ===============================
   📤 SEND TELEGRAM (PENDING)
================================ */
function buildPendingMessage(data, options = {}) {
  const followUpCount = Number(data.followUpCount || 0);
  const followUpLabel = followUpMessageLabels[followUpCount];
  const messageLines = [];
  const selectedFields = normalizePendingMessageFields(options.fields);
  const customMessage = String(options.messageText || "").trim();

  if (followUpLabel) {
    messageLines.push(`${followUpLabel} Follow Up`);
  }

  if (followUpCount === MAX_FOLLOW_UPS) {
    messageLines.push(
      "Since you failed to answer after multiple consecutive follow-ups, this is the last follow-up. If you still fail to answer, it will auto credit and be added to your report. Thanks."
    );
    messageLines.push("");
  }

  if (options.remark) {
    messageLines.push(`Remark: ${options.remark}`);
    messageLines.push("");
  }

  messageLines.push("Deposit");

  if (customMessage) {
    messageLines.push("Message:");
    messageLines.push(escapeTelegramHtml(customMessage));
    messageLines.push("");
  }

  if (selectedFields.includes("agent")) {
    messageLines.push(`Agent: ${escapeTelegramHtml(data.agentName || "")}`);
  }

  if (selectedFields.includes("ref")) {
    messageLines.push(`Ref: ${escapeTelegramHtml(data.transactionReference || "")}`);
  }

  if (selectedFields.includes("amount")) {
    messageLines.push(`Amount: ${escapeTelegramHtml(data.amount || "")}`);
  }

  if (selectedFields.includes("customer")) {
    messageLines.push(`Customer: ${escapeTelegramHtml(data.customerNumber || "")}`);
  }

  if (selectedFields.includes("image") && data.imageLink) {
    if (options.imageFormat === "url") {
      messageLines.push(`Image: ${escapeTelegramHtml(data.imageLink)}`);
    } else {
      const imageLabel = escapeTelegramHtml(options.imageLabel || "View Receipt");
      messageLines.push(`Image: <a href="${escapeTelegramHtml(data.imageLink)}">${imageLabel}</a>`);
    }
  }

  return messageLines.join("\n");
}

function escapeTelegramHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizePendingMessageFields(fields) {
  const allowedFields = new Set(DEFAULT_PENDING_MESSAGE_FIELDS);

  if (Array.isArray(fields)) {
    return fields
      .map(field => String(field || "").trim())
      .filter(field => allowedFields.has(field));
  }

  if (typeof fields === "string" && fields.trim()) {
    try {
      return normalizePendingMessageFields(JSON.parse(fields));
    } catch (err) {
      return normalizePendingMessageFields(fields.split(","));
    }
  }

  return DEFAULT_PENDING_MESSAGE_FIELDS;
}

function getDepositAnswerKeyboard(id) {
  return {
    inline_keyboard: [[
      { text: "YES", callback_data: `yes_${id}` },
      { text: "NO", callback_data: `no_${id}_select` }
    ]]
  };
}

function ensureBotReady(action) {
  if (bot) return true;

  const message = `Telegram bot is not initialized; cannot ${action}. Save the bot token in Settings first.`;
  console.error(message);
  addSystemLog("ERROR", message);
  return false;
}

async function sendTelegram(data) {
  if (!ensureBotReady("send pending message")) return null;

  try {
    const followUpCount = Number(data.followUpCount || 0);
    const messageOptions = data.messageOptions || {};
    const replyMarkup = getDepositAnswerKeyboard(data.id);

    const messageText = buildPendingMessage(data, messageOptions);
    const msg = await bot.sendMessage(
      data.chatId,
      messageText,
      {
        parse_mode: "HTML",
        disable_web_page_preview: !messageOptions.imagePreview,
        reply_markup: replyMarkup
      }
    );

    if (data.id) {
      db.run(`
        UPDATE transactions
        SET
          sent = 1,
          chatId = ?,
          telegramMessageId = ?,
          followUpCount = CASE
            WHEN ? > 0 THEN ?
            ELSE followUpCount
          END,
          agentStatus = CASE
            WHEN ? = 1 THEN '1st FF'
            WHEN ? = 2 THEN '2nd FF'
            WHEN ? = 3 THEN 'Final FF'
            ELSE agentStatus
          END,
          lastFollowUpAt = CASE
            WHEN ? = 0 THEN datetime('now')
            ELSE COALESCE(lastFollowUpAt, datetime('now'))
          END
        WHERE id = ?
      `, [
        String(data.chatId),
        String(msg.message_id),
        followUpCount,
        followUpCount,
        followUpCount,
        followUpCount,
        followUpCount,
        followUpCount,
        data.id
      ]);
    }

    return msg;

  } catch (err) {

    console.error("TELEGRAM ERROR:", err.message);
    addSystemLog("ERROR", `Pending Telegram send failed (ID ${data.id || "-"}, agent ${data.agentName || "-"}): ${err.message}`);

    return null;
  }
}

/* ===============================
   SEND TELEGRAM (VIDEO)
================================ */
async function sendVideoTelegram(data) {
  if (!ensureBotReady("send video message")) return null;

  const message = `🎥 Video Case

Agent: ${data.agentName}
Ref: ${data.transactionReference}
Amount: ${data.amount}

Video: ${data.imageLink}`;

  try {
    // 🔥 IMPORTANT: capture the sent message
    const msg = await bot.sendMessage(data.chatId, message, {
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ RECEIVED", callback_data: `video_yes_${data.id}` },
          { text: "❌ NOT RECEIVED", callback_data: `video_no_${data.id}` }
        ]]
      }
    });

    console.log("📤 VIDEO SENT:", data.id, "MSG ID:", msg.message_id);

    // 🔥 SAVE message_id to DB
    db.run(`
      UPDATE video_cases
      SET telegramMessageId = ?
      WHERE id = ?
    `, [msg.message_id, data.id]);

  } catch (err) {
    console.error("❌ VIDEO SEND ERROR:", err.message);
    addSystemLog("ERROR", `Video Telegram send failed (ID ${data.id || "-"}): ${err.message}`);
  }
}

async function sendWalletHealthTelegram(data) {
  if (!ensureBotReady("send wallet health message")) return false;

  const rows = data.rows || [];
  const isAppUpdateNotice = data.messageType === "app_update";
  const isPermissionNotice = data.messageType === "permission";
  const ownerNames = compactUnique(rows.map(row => row.ownerName));
  const walletCount = rows.length;

  let lines;

  if (isAppUpdateNotice) {
    lines = buildWalletAppUpdateMessage(data, ownerNames, walletCount);
  } else if (isPermissionNotice) {
    lines = buildWalletPermissionMessage(data, ownerNames, walletCount);
  } else {
    lines = buildWalletHealthMessage(data, ownerNames, walletCount);
  }

  for (const chunk of splitTelegramMessage(lines.join("\n"))) {
    await bot.sendMessage(data.chatId, chunk);
  }

  return true;
}

async function sendBalanceOverviewTelegram(data) {
  if (!ensureBotReady("send balance overview message")) return false;

  const rows = Array.isArray(data.rows) ? data.rows : [];
  const lines = buildBalanceOverviewMessage(data, rows);

  for (const chunk of splitTelegramMessage(lines.join("\n"))) {
    await bot.sendMessage(data.chatId, chunk);
  }

  return true;
}

async function sendBalanceOverviewImageTelegram(data) {
  if (!ensureBotReady("send balance overview image")) return false;

  const images = Array.isArray(data.images) ? data.images : [];
  const caption = buildBalanceOverviewImageCaption(data);

  for (let index = 0; index < images.length; index += 1) {
    await bot.sendPhoto(
      data.chatId,
      images[index],
      index === 0 ? { caption } : {}
    );
  }

  return true;
}

async function sendBalanceOverviewFileTelegram(data) {
  if (!ensureBotReady("send balance overview file")) return false;

  const rows = Array.isArray(data.rows) ? data.rows : [];
  if (!rows.length) return false;

  const csvBuffer = buildBalanceOverviewCsvBuffer(rows);
  const caption = buildBalanceOverviewFileCaption(data, rows);
  const filename = buildBalanceOverviewFilename(data.agentGroup);

  await bot.sendDocument(
    data.chatId,
    csvBuffer,
    caption ? { caption } : {},
    { filename, contentType: "text/csv" }
  );

  return true;
}

function buildBalanceOverviewImageCaption(data) {
  const messageText = cleanTelegramLine(data.messageText);

  return messageText.slice(0, 1000);
}

function buildBalanceOverviewFileCaption(data, rows) {
  const messageText = data.includeMessageText === false
    ? ""
    : cleanTelegramLine(data.messageText);
  const lines = [
    `Balance Overview CSV - ${cleanTelegramLine(data.agentGroup || "-")}`,
    `Wallets: ${rows.length}`
  ];

  if (messageText) {
    lines.push("", messageText);
  }

  return lines.join("\n").slice(0, 1000);
}

function buildBalanceOverviewCsvBuffer(rows) {
  const labels = [];

  rows.forEach(row => {
    (Array.isArray(row.values) ? row.values : []).forEach(field => {
      const label = cleanTelegramLine(field.label || "-");
      if (label && !labels.includes(label)) labels.push(label);
    });
  });

  if (!labels.some(label => label.toLowerCase() === "owner")) {
    labels.unshift("Owner");
  }

  const csvRows = [
    labels.map(escapeCsvValue).join(",")
  ];

  rows.forEach(row => {
    const fieldMap = new Map(
      (Array.isArray(row.values) ? row.values : [])
        .map(field => [cleanTelegramLine(field.label || "-"), cleanTelegramLine(field.value || "-")])
    );

    csvRows.push(labels.map(label => {
      const value = label.toLowerCase() === "owner" && !fieldMap.has(label)
        ? row.ownerName || "-"
        : fieldMap.get(label) || "-";
      return escapeCsvValue(value);
    }).join(","));
  });

  return Buffer.from(`\ufeff${csvRows.join("\n")}`, "utf8");
}

function escapeCsvValue(value) {
  const text = cleanTelegramLine(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function buildBalanceOverviewFilename(agentGroup) {
  const group = cleanTelegramLine(agentGroup || "group")
    .replace(/[^a-z0-9_-]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "group";
  const stamp = new Date().toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");

  return `balance_overview_${group}_${stamp}.csv`;
}

function buildBalanceOverviewMessage(data, rows) {
  const messageText = cleanTelegramLine(data.messageText);
  const lines = [
    "Balance Overview Notice",
    `Group: ${cleanTelegramLine(data.agentGroup || "-")}`,
    `Wallets: ${rows.length}`,
    ""
  ];

  if (messageText) {
    lines.push(messageText, "");
  }

  rows.forEach((row, index) => {
    lines.push(`${index + 1}. ${cleanTelegramLine(row.ownerName || "Wallet")}`);

    (Array.isArray(row.values) ? row.values : []).forEach(field => {
      const label = cleanTelegramLine(field.label || "-");
      const value = cleanTelegramLine(field.value || "-");
      lines.push(`- ${label}: ${value || "-"}`);
    });

    lines.push("");
  });

  return lines;
}

function cleanTelegramLine(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/\t/g, " ")
    .replace(/[ \f\v]+/g, " ")
    .trim()
    .slice(0, 1000);
}

function buildWalletHealthMessage(data, ownerNames, walletCount) {
  return [
    "Wallet Health Notice",
    "",
    "Owners:",
    ...formatCompactList(ownerNames),
    "",
    "Action Required:",
    "Clear app data and relog-in the wallet APP.",
    "",
    "Transactions are STOPPED until the APP is relogged-in."
  ];
}

function buildWalletPermissionMessage(data, ownerNames, walletCount) {
  return [
    "Wallet Permission Notice",
    "",
    "Owners:",
    ...formatCompactList(ownerNames),
    "",
    "Action Required:",
    "Allow all required wallet APP permissions.",
    "",
    "Transactions are STOPPED until device permissions are fully allowed."
  ];
}

function buildWalletAppUpdateMessage(data, ownerNames, walletCount) {
  return [
    "Wallet App Update Required",
    `Latest App Ver: ${data.latestVersion || "-"}`,
    "",
    "Owners:",
    ...formatCompactList(ownerNames),
    "",
    "Action Required:",
    `Install the latest wallet APP version ${data.latestVersion || "4.X.X"}.`,
    "",
    "Transactions are STOPPED until the latest APP is installed."
  ];
}

function summarizeWalletHealthIssues(rows) {
  const issues = new Map();

  rows.forEach(row => {
    const conditionLabel = getHealthConditionLabel(row.appCondition);
    addIssue(issues, conditionLabel);

    const permissionIssues = getPermissionIssueList(row);
    if (permissionIssues.length) {
      addIssue(issues, `Permission: ${permissionIssues.join(", ")}`);
    }
  });

  return Array.from(issues.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function addIssue(issues, label) {
  const cleanLabel = String(label || "Needs review").trim();
  if (!cleanLabel || cleanLabel === "Healthy") return;
  issues.set(cleanLabel, (issues.get(cleanLabel) || 0) + 1);
}

function getHealthConditionLabel(value) {
  const normalized = normalizeHealth(value);

  if (normalized === "APP_OFFLINE") return "Disconnected";
  if (normalized === "SYNC_DELAYED") return "Sync Delayed";
  if (normalized === "PERMISSION_MISSING") return "Permission Missing";
  if (normalized === "NO_ACTIVE_DEVICE") return "No Active Device";
  if (normalized === "HEALTHY") return "Healthy";

  return String(value || "Needs review")
    .trim()
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, char => char.toUpperCase());
}

function compactUnique(values) {
  const seen = new Set();
  const result = [];

  values.forEach(value => {
    const text = String(value || "").trim();
    const key = normalizeHealth(text);
    if (!text || seen.has(key)) return;
    seen.add(key);
    result.push(text);
  });

  return result;
}

function formatCompactList(values, limit = 30) {
  const visible = values.slice(0, limit);
  const lines = visible.map(value => value);

  if (values.length > limit) {
    lines.push(`...and ${values.length - limit} more`);
  }

  return lines.length ? lines : ["-"];
}

function normalizeHealth(value) {
  return String(value || "").trim().toUpperCase();
}

function getPermissionIssues(row) {
  const issues = getPermissionIssueList(row);

  return issues.length ? issues.join(", ") : "OK";
}

function getPermissionIssueList(row) {
  const issues = [];

  if (!isAllowed(row.smsPermission)) issues.push("SMS");
  if (!isAllowed(row.notificationListener)) issues.push("Listener");
  if (!isAllowed(row.appNotifications)) issues.push("App Notif");
  if (!isAllowed(row.fullScreenAlert)) issues.push("Full Screen");
  if (!isAllowed(row.batteryOptimizationDisabled)) issues.push("Battery");

  return issues;
}

function isAllowed(value) {
  const normalized = normalizeHealth(value);
  return normalized === "YES" || normalized === "Y" || normalized === "TRUE" || normalized === "1";
}

function splitTelegramMessage(message) {
  const maxLength = 3900;
  const lines = message.split("\n");
  const chunks = [];
  let chunk = "";

  lines.forEach(line => {
    if ((chunk + "\n" + line).length > maxLength) {
      chunks.push(chunk);
      chunk = line;
      return;
    }

    chunk = chunk ? `${chunk}\n${line}` : line;
  });

  if (chunk) chunks.push(chunk);
  return chunks;
}

// ===============================
// 🔧 HELPER FUNCTION
// ===============================
function updateVoicemail(id, fileUrl, chatId) {
  db.run(`
    UPDATE video_cases
    SET
      caseStatus='CHECK VOICEMAIL',
      reason='Voicemail provided by agent',
      voicemailLink=?
    WHERE id=?
  `, [fileUrl, id]);

  getIO()?.emit("update", {
    id,
    type: "video",
    status: "CHECK VOICEMAIL",
    reason: "Voicemail provided by agent",
    voicemailLink: fileUrl
  });

  bot.sendMessage(chatId, "✅ Voicemail linked successfully.");
}

async function handleVoicemail(msg, fileId) {
  const chatId = msg.chat.id;
  const replyMsgId = msg.reply_to_message?.message_id;

  console.log("🎤 VOICEMAIL RECEIVED");

  if (!replyMsgId) {
  return;
}

  const file = await bot.getFile(fileId);

  if (!file || !file.file_path) {
    console.log("❌ Failed to get file path");
    return;
  }

  const fileUrl = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;

  let row = await new Promise((resolve) => {
    db.get(`
      SELECT * FROM video_cases
      WHERE telegramMessageId = ?
    `, [replyMsgId], (err, r) => resolve(r));
  });

  if (!row) {
    row = await new Promise((resolve) => {
      db.get(`
        SELECT * FROM video_cases
        WHERE caseStatus='WAITING VOICEMAIL'
        ORDER BY id DESC
        LIMIT 1
      `, (err, r) => resolve(r));
    });

    if (!row) {
      return bot.sendMessage(chatId, "❌ No matching case found.");
    }
  }

  console.log("✅ MATCH FOUND:", row.id);
  console.log("📎 FILE URL:", fileUrl);

  // 🔥 UPDATE STATUS
  db.run(`
    UPDATE video_cases
    SET
      caseStatus='CHECK VOICEMAIL',
      reason='Voicemail provided by agent',
      voicemailLink=?
    WHERE id=?
  `, [fileUrl, row.id]);

  // 🔥 SINGLE EMIT
  getIO()?.emit("update", {
    id: row.id,
    type: "video",
    status: "CHECK VOICEMAIL",
    reason: "Voicemail provided by agent",
    voicemailLink: fileUrl,
  });

  bot.sendMessage(chatId, "✅ Voicemail linked successfully.");
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function minutesFromTime(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (hours > 23 || minutes > 59) return null;
  return (hours * 60) + minutes;
}

function isWithinFollowUpWindow(startTime, endTime) {
  const start = minutesFromTime(startTime);
  const end = minutesFromTime(endTime);

  if (start === null || end === null || start === end) return true;

  const now = new Date();
  const current = (now.getHours() * 60) + now.getMinutes();

  if (start < end) {
    return current >= start && current < end;
  }

  return current >= start || current < end;
}

function parseFollowUpExcludedAgents(value) {
  return String(value || "")
    .split(/[\n,]+/)
    .map(item => item.trim().toUpperCase())
    .filter(Boolean);
}

function isFollowUpAgentExcluded(agentName, excludedAgents = []) {
  const normalizedAgent = String(agentName || "").trim().toUpperCase();
  if (!normalizedAgent) return false;

  return excludedAgents.some(excludedAgent =>
    normalizedAgent.includes(excludedAgent)
  );
}

async function getFollowUpSettings() {
  const rows = await dbAll(`
    SELECT
      followUpIntervalMinutes,
      followUpEnabled,
      followUpStartTime,
      followUpEndTime,
      followUpMessageText,
      followUpMessageFields,
      followUpDeletePrevious,
      followUpImagePreview,
      followUpImageFormat,
      followUpExcludedAgents
    FROM settings
    WHERE id = 1
    LIMIT 1
  `);

  const settings = rows[0] || {};
  const value = Number(settings.followUpIntervalMinutes);

  const intervalMinutes = (!Number.isFinite(value) || value < 1)
    ? DEFAULT_FOLLOW_UP_INTERVAL_MINUTES
    : Math.floor(value);

  return {
    enabled: Number(settings.followUpEnabled ?? 1) === 1,
    intervalMinutes,
    withinSchedule: isWithinFollowUpWindow(
      settings.followUpStartTime,
      settings.followUpEndTime
    ),
    deletePrevious: Number(settings.followUpDeletePrevious || 0) === 1,
    excludedAgents: parseFollowUpExcludedAgents(settings.followUpExcludedAgents),
    messageOptions: {
      messageText: settings.followUpMessageText || "",
      fields: normalizePendingMessageFields(settings.followUpMessageFields),
      imagePreview: Number(settings.followUpImagePreview || 0) === 1,
      imageFormat: settings.followUpImageFormat === "url" ? "url" : "link"
    }
  };
}

function disablePendingButtons(row, reason = "Failed to answer") {
  if (!row.chatId || !row.telegramMessageId) return Promise.resolve();

  return bot.editMessageText(
    buildPendingMessage(row, { remark: reason }),
    {
    chat_id: row.chatId,
    message_id: row.telegramMessageId,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [] }
  }).catch(() => {
    return bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: row.chatId,
      message_id: row.telegramMessageId
    });
  }).catch((err) => {
    console.log("FOLLOW-UP DISABLE ERROR:", err.message);
    addSystemLog("WARN", `Could not disable previous follow-up buttons (transaction ${row.id}, message ${row.telegramMessageId}): ${err.message}`);
  });
}

function deletePendingMessage(row) {
  if (!row.chatId || !row.telegramMessageId) return Promise.resolve();

  return bot.deleteMessage(row.chatId, row.telegramMessageId).catch((err) => {
    addSystemLog("WARN", `Could not delete previous follow-up message (transaction ${row.id}, message ${row.telegramMessageId}): ${err.message}`);
    return disablePendingButtons(row, "Failed to answer");
  });
}

function deleteTelegramMessage(chatId, messageId) {
  if (!bot || !chatId || !messageId) return Promise.resolve(false);

  return bot.deleteMessage(chatId, messageId)
    .then(() => true)
    .catch((err) => {
      addSystemLog("WARN", `Could not delete Telegram message ${messageId} in chat ${chatId}: ${err.message}`);
      return false;
    });
}

async function sendFollowUp(row, nextCount, messageOptions = {}) {
  const msg = await sendTelegram({
    chatId: row.chatId,
    id: row.id,
    transactionReference: row.transactionReference,
    amount: row.amount,
    agentName: row.agentName,
    customerNumber: row.customerNumber,
    imageLink: row.imageLink,
    followUpCount: nextCount,
    messageOptions
  });

  if (!msg) return false;

  await dbRun(`
    UPDATE transactions
    SET
      agentStatus = ?,
      reason = 'Failed to answer',
      followUpCount = ?,
      lastFollowUpAt = datetime('now'),
      chatId = ?,
      telegramMessageId = ?
    WHERE id = ?
  `, [
    followUpLabels[nextCount],
    nextCount,
    String(row.chatId),
    String(msg.message_id),
    row.id
  ]);

  getIO()?.emit("update", {
    id: row.id,
    status: followUpLabels[nextCount],
    reason: "Failed to answer",
    sent: 1,
    type: "pending"
  });

  addSystemLog("INFO", `Follow-up sent (${followUpLabels[nextCount]}) for transaction ${row.id}, ref ${row.transactionReference}`);

  return true;
}

async function markForReview(row) {
  await disablePendingButtons(row, "Failed to answer final follow-up");

  await dbRun(`
    UPDATE transactions
    SET
      agentStatus = 'For Review',
      reason = 'Failed to answer final follow-up',
      lastFollowUpAt = datetime('now')
    WHERE id = ?
  `, [row.id]);

  getIO()?.emit("update", {
    id: row.id,
    status: "For Review",
    reason: "Failed to answer final follow-up",
    sent: 1,
    type: "pending"
  });

  addSystemLog("WARN", `Transaction moved to For Review after final follow-up expired (ID ${row.id}, ref ${row.transactionReference})`);
}

async function runPendingFollowUps() {
  if (!bot || followUpRunning) return;

  followUpRunning = true;

  try {
    const followUpSettings = await getFollowUpSettings();

    if (!followUpSettings.enabled || !followUpSettings.withinSchedule) {
      return;
    }

    const intervalSql = `-${followUpSettings.intervalMinutes} minutes`;

    const rows = await dbAll(`
      SELECT *
      FROM transactions
      WHERE sent = 1
        AND (actionStatus IS NULL OR actionStatus = 'PENDING')
        AND (
          agentStatus IS NULL
          OR agentStatus = ''
          OR agentStatus = 'PENDING'
          OR agentStatus IN ('1st FF', '2nd FF', 'Final FF')
        )
        AND chatId IS NOT NULL
        AND telegramMessageId IS NOT NULL
        AND datetime(COALESCE(lastFollowUpAt, createdAt)) <= datetime('now', ?)
      ORDER BY id ASC
      LIMIT 25
    `, [intervalSql]);

    for (const row of rows) {
      if (isFollowUpAgentExcluded(row.agentName, followUpSettings.excludedAgents)) {
        continue;
      }

      const currentCount = Number(row.followUpCount || 0);

      if (currentCount >= MAX_FOLLOW_UPS) {
        await markForReview(row);
        continue;
      }

      const nextCount = currentCount + 1;

      if (followUpSettings.deletePrevious) {
        await deletePendingMessage(row);
      } else {
        await disablePendingButtons(row, "Failed to answer");
      }

      await sendFollowUp(row, nextCount, followUpSettings.messageOptions);
    }
  } catch (err) {
    console.error("FOLLOW-UP ERROR:", err.message);
    addSystemLog("ERROR", `Pending follow-up scheduler failed: ${err.message}`);
  } finally {
    followUpRunning = false;
  }
}

module.exports = {
  sendTelegram,
  sendVideoTelegram,
  sendWalletHealthTelegram,
  sendBalanceOverviewTelegram,
  sendBalanceOverviewImageTelegram,
  sendBalanceOverviewFileTelegram,
  deleteTelegramMessage,
  getBot,
  initializeBotFromSettings
};
