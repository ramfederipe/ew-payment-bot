const crypto = require("crypto");

function decryptAES(encryptedBase64, key) {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(true);

  let decrypted = decipher.update(encryptedBase64, "base64", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

function generateMark(data, RESPONSE_PASS) {
  const raw =
    data.transactionReference +
    data.invoiceNumber +
    RESPONSE_PASS +
    data.YOUR_UNIQUE_RESPONSE_ID +
    data.YOUR_UNIQUE_RESPONSE_ID +
    data.amount;

  return crypto.createHash("sha1").update(raw).digest("hex");
}

module.exports = { decryptAES, generateMark };