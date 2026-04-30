const db = require("./db");
const TelegramBot = require("node-telegram-bot-api");
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN);

setInterval(() => {

  // ⏳ EXPIRE
  db.all(`
    SELECT * FROM video_cases
    WHERE caseStatus='WAITING VOICEMAIL'
    AND datetime(voicemailDeadline) <= datetime('now')
  `, (err, rows) => {

    rows.forEach(r => {
      db.run(`
        UPDATE video_cases
        SET caseStatus='FOR APPROVAL',
            reason='Failed to provide voicemail'
        WHERE id=?
      `, [r.id]);
    });

  });

  // 🔔 REMINDER (after 2 days)
  db.all(`
    SELECT * FROM video_cases
    WHERE caseStatus='WAITING VOICEMAIL'
    AND datetime(voicemailDeadline) <= datetime('now', '+1 day')
  `, (err, rows) => {

    rows.forEach(r => {
      bot.sendMessage(r.chatId, `
⏳ Reminder:

You have less than 24 hours to submit voicemail.
      `);
    });

  });

}, 60 * 60 * 1000); // every hour