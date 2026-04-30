// helpers/transcribe.js

const fs = require("fs");
const axios = require("axios");
const path = require("path");
const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function downloadFile(fileUrl, filename) {
  const filePath = path.join(__dirname, "../temp", filename);

  const response = await axios({
    url: fileUrl,
    method: "GET",
    responseType: "stream"
  });

  await new Promise((resolve, reject) => {
    const stream = fs.createWriteStream(filePath);
    response.data.pipe(stream);
    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  return filePath;
}

async function transcribeAndTranslate(fileUrl) {
  try {
    const filename = `audio_${Date.now()}.ogg`;
    const filePath = await downloadFile(fileUrl, filename);

    console.log("🎧 Downloaded:", filePath);

    // 🔥 TRANSCRIBE
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "gpt-4o-transcribe"
    });

    const text = transcription.text;

    console.log("📝 Transcript:", text);

    // 🔥 TRANSLATE
    const translation = await openai.chat.completions.create({
      model: "gpt-5-mini",
      messages: [
        {
          role: "system",
          content: "You are a translator. Always translate to clear English."
        },
        {
          role: "user",
          content: text
        }
      ]
    });

    const translated = translation?.choices?.[0]?.message?.content || "Translation unavailable";

    console.log("🌍 Translation:", translated);

    // 🧹 delete temp file
    fs.unlinkSync(filePath);

    return {
      transcript: text,
      translation: translated
    };

  } catch (err) {
    console.error("❌ TRANSCRIBE ERROR:", err);
    return null;
  }
}

module.exports = {
  transcribeAndTranslate
};