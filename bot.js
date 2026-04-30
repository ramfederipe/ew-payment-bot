require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const db = require("./db");
const { getIO } = require("./socket");

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

const { transcribeAndTranslate } = require("./helpers/transcribe");

/* ===============================
   📤 SEND TELEGRAM (PENDING)
================================ */
async function sendTelegram(data) {
  try {
    const msg = await bot.sendMessage(data.chatId, `💰 Deposit
Agent: ${data.agentName}
Ref: ${data.transactionReference}
Amount: ${data.amount}
Customer: ${data.customerNumber}

Image: ${data.imageLink}`, {
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ YES", callback_data: `yes_${data.id}` },
          { text: "❌ NO", callback_data: `no_${data.id}_select` }
        ]]
      }
    });

    return msg; // ✅ IMPORTANT

  } catch (err) {
    console.error("❌ TELEGRAM ERROR:", err.message);
    return null; // ✅ IMPORTANT
  }
}

/* ===============================
   📤 SEND TELEGRAM (VIDEO)
================================ */
async function sendVideoTelegram(data) {
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
  }
}

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

        bot.sendMessage(chatId, `
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

      bot.editMessageText(
`${status === "RECEIVED" ? "✅ RECEIVED" : "❌ NOT RECEIVED"}

Agent: ${row.agentName}
Ref: ${row.transactionReference}
Amount: ${row.amount}

Confirmed By: ${username}`,
        {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id
        }
      ).catch(() => {});
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
      bot.editMessageText(
`${status === "RECEIVED" ? "✅ RECEIVED" : "❌ NOT RECEIVED"}
${reasonText ? "\nReason: " + reasonText : ""}

Agent: ${row.agentName}
Ref: ${row.transactionReference}
Amount: ${row.amount}
Customer: ${row.customerNumber}

Confirmed By: ${username}`,
        {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id
        }
      ).catch(() => {});
    });

    return;
  }

});

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
    return bot.sendMessage(chatId, "⚠️ Please reply to the video message.");
  }

  const file = await bot.getFile(fileId);

  if (!file || !file.file_path) {
    console.log("❌ Failed to get file path");
    return;
  }

  const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_TOKEN}/${file.file_path}`;

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

  if (fileSize > 20 * 1024 * 1024) {
    return bot.sendMessage(chatId,
      "❌ File too large.\n\nMax allowed: 20MB\nPlease compress your audio."
    );
  }

  await handleVoicemail(msg, fileId);
});

bot.on("message", (msg) => {
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

module.exports = { sendTelegram, sendVideoTelegram, bot };