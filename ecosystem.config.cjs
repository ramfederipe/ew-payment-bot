module.exports = {
  apps: [
    {
      name: "ew-payment-bot",
      script: "webhook.js",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || 3001
      }
    }
  ]
};
