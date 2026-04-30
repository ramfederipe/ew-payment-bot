const express = require("express");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = 3001;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve frontend
app.use(express.static(path.join(__dirname, "public")));

// Optional: API test route
app.get("/api/test", (req, res) => {
  res.json({ message: "Server is working!" });
});

// Import your modules
require("./bot");       // Telegram bot
require("./webhook");   // webhook routes (if using express router)

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});