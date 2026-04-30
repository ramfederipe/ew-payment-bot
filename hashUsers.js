const bcrypt = require("bcrypt");
const db = require("./db");

db.all("SELECT id, password FROM users", async (err, rows) => {
  if (err) {
    console.error(err);
    return;
  }

  for (const user of rows) {
    // skip if already hashed
    if (user.password.startsWith("$2b$")) continue;

    const hashed = await bcrypt.hash(user.password, 10);

    db.run(
      "UPDATE users SET password = ? WHERE id = ?",
      [hashed, user.id]
    );
  }

  console.log("✅ Users converted to bcrypt");
  process.exit();
});