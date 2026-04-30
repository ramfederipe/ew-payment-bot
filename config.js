const db = require("./db");

function getSettings() {
  return new Promise((resolve) => {
    db.get(`SELECT * FROM settings WHERE id = 1`, (err, row) => {
      if (err) {
        console.error("❌ Error loading settings:", err.message);
        return resolve({});
      }
      resolve(row || {});
    });
  });
}

module.exports = { getSettings };