/**
 * WhatsApp Bot — Baileys + n8n Webhook
 * Lightweight + deployment friendly (Render/free tier)
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
  downloadMediaMessage,
} = require("@whiskeysockets/baileys");

const axios  = require("axios");
const qrcode = require("qrcode");
const pino   = require("pino");
const http   = require("http");
const fs     = require("fs");
const path   = require("path");

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || "https://n8n-jyfj.onrender.com/webhook-test/helotest";
const SESSION_DIR     = path.join(__dirname, "auth_info");
const MEDIA_DIR       = path.join(__dirname, "media");
const PORT            = process.env.PORT || 3000;
const HOST            = process.env.HOST || "0.0.0.0";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || null;
const RECONNECT_MS    = 5000;
const RESET_SESSION_ON_START = process.env.RESET_SESSION_ON_START !== "false";

const logger = pino({ level: "silent" });

let currentQR   = null;
let isConnected = false;
let waSocket    = null;
let reconnectTimer = null;
let isReconnecting = false;

// ─── HTTP Server ───────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {

  if (req.method === "GET" && req.url === "/") {
    if (isConnected) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0f0f0f;color:#00e676;">
        <h1>✅ WhatsApp Connected</h1>
        <p>Bot is running and QR scan is no longer required.</p>
      </body></html>`);
      return;
    }

    if (!currentQR) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0f0f0f;color:#fff;">
        <h2>⏳ QR Loading...</h2>
        <p>Refresh in a few seconds.</p>
        <script>setTimeout(()=>location.reload(), 4000)</script>
      </body></html>`);
      return;
    }

    try {
      const qrImage = await qrcode.toDataURL(currentQR, { width: 420 });
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html><html><head>
        <title>WhatsApp QR Scan</title>
        <meta http-equiv="refresh" content="30">
        <style>
          body{background:#0f0f0f;color:#fff;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0}
          img{border:8px solid #fff;border-radius:16px;margin:20px 0}
          p{color:#bdbdbd}
        </style>
      </head><body>
        <h2>📱 Scan this QR from WhatsApp</h2>
        <img src="${qrImage}" width="320" height="320" />
        <p>WhatsApp > Linked Devices > Link a Device</p>
      </body></html>`);
    } catch {
      res.writeHead(500).end("QR render error");
    }
    return;
  }

  if (req.method === "POST" && req.url === "/send-message") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const { phone, message } = JSON.parse(body);
        if (!phone || !message) { res.writeHead(400).end("missing fields"); return; }
        const jid = phone.includes("@") ? phone : `${phone}@s.whatsapp.net`;
        await waSocket.sendMessage(jid, { text: message });
        res.writeHead(200).end(JSON.stringify({ status: "sent" }));
      } catch(err) { res.writeHead(500).end(err.message); }
    });
    return;
  }

  res.writeHead(404).end("Not Found");
});

server.listen(PORT, HOST, () => {
  const localUrl = `http://localhost:${PORT}`;
  const serverUrl = PUBLIC_BASE_URL || localUrl;
  console.log(`🌐 Server started on ${HOST}:${PORT}`);
  console.log(`🔗 Open this URL to scan QR: ${serverUrl}`);
  if (!PUBLIC_BASE_URL) {
    console.log("ℹ️ For remote deployment, set PUBLIC_BASE_URL to your public server URL.");
  }
});

async function resetSessionIfNeeded() {
  if (!RESET_SESSION_ON_START) return;

  try {
    await fs.promises.rm(SESSION_DIR, { recursive: true, force: true });
    console.log("🧹 Previous WhatsApp session cleared on startup.");
  } catch (err) {
    console.error(`⚠️ Failed to clear previous session: ${err.message}`);
  }
}

function unwrapMessage(message = {}) {
  let content = message;
  while (true) {
    if (content?.ephemeralMessage?.message) {
      content = content.ephemeralMessage.message;
      continue;
    }
    if (content?.viewOnceMessage?.message) {
      content = content.viewOnceMessage.message;
      continue;
    }
    if (content?.viewOnceMessageV2?.message) {
      content = content.viewOnceMessageV2.message;
      continue;
    }
    if (content?.viewOnceMessageV2Extension?.message) {
      content = content.viewOnceMessageV2Extension.message;
      continue;
    }
    if (content?.documentWithCaptionMessage?.message) {
      content = content.documentWithCaptionMessage.message;
      continue;
    }
    break;
  }
  return content || {};
}

function getTextFromMessage(content = {}) {
  return (
    content?.conversation ||
    content?.extendedTextMessage?.text ||
    content?.imageMessage?.caption ||
    content?.videoMessage?.caption ||
    content?.documentMessage?.caption ||
    content?.buttonsResponseMessage?.selectedDisplayText ||
    content?.listResponseMessage?.title ||
    content?.templateButtonReplyMessage?.selectedDisplayText ||
    null
  );
}

function getMediaNode(content = {}) {
  const mediaTypes = [
    "imageMessage",
    "videoMessage",
    "audioMessage",
    "documentMessage",
    "stickerMessage",
  ];
  for (const type of mediaTypes) {
    if (content?.[type]) return { mediaType: type, mediaNode: content[type] };
  }
  return null;
}

function extFromMime(mimetype = "") {
  const clean = String(mimetype).split(";")[0].trim();
  if (!clean.includes("/")) return "bin";
  return clean.split("/")[1] || "bin";
}

function sanitizeFileName(name) {
  return String(name || "file")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
}

async function persistMediaBuffer(sender, mediaType, mediaNode, buffer) {
  await fs.promises.mkdir(MEDIA_DIR, { recursive: true });

  const senderPart = (sender || "unknown").replace(/[^a-zA-Z0-9]/g, "_");
  const providedName = mediaNode?.fileName ? sanitizeFileName(mediaNode.fileName) : null;
  const extension = extFromMime(mediaNode?.mimetype);
  const generatedName = `${Date.now()}_${senderPart}_${mediaType}.${extension}`;
  const finalName = providedName || generatedName;
  const fullPath = path.join(MEDIA_DIR, finalName);

  await fs.promises.writeFile(fullPath, buffer);
  return fullPath;
}

// ─── WhatsApp Connection ───────────────────────────────────────────────────
async function connectToWhatsApp() {
  if (isReconnecting) return;
  isReconnecting = true;

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version }          = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    logger,
    printQRInTerminal: false,
    browser: ["WhatsApp Bot", "Chrome", "1.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined,
  });

  waSocket = sock;
  isReconnecting = false;

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      currentQR = qr;
      isConnected = false;
      console.log("📱 QR generated. Open the server URL in browser to scan.");
    }
    if (connection === "open") {
      currentQR = null;
      isConnected = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      console.log("✅ WhatsApp Connected!");
    }
    if (connection === "close") {
      isConnected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        console.log(`🔄 Reconnecting... (${code})`);
        if (!reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connectToWhatsApp().catch(err => console.error("Reconnect fatal:", err));
          }, RECONNECT_MS);
        }
      } else { console.log("🚫 Logged out. Delete auth_info and restart."); }
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (msg.key.fromMe || isJidBroadcast(msg.key.remoteJid) || msg.key.remoteJid === "status@broadcast") continue;

      const sender = msg.key.remoteJid;
      if (!sender || !msg.message) continue;

      const content = unwrapMessage(msg.message);
      const text = getTextFromMessage(content);
      const mediaInfo = getMediaNode(content);
      const payload = {
        sender,
        messageId: msg.key.id || null,
        messageTimestamp: msg.messageTimestamp || null,
        messageType: mediaInfo?.mediaType || (text ? "text" : Object.keys(content)[0] || "unknown"),
        message: text || "",
      };

      if (mediaInfo) {
        try {
          const mediaBuffer = await downloadMediaMessage(msg, "buffer", {});
          const savedPath = await persistMediaBuffer(sender, mediaInfo.mediaType, mediaInfo.mediaNode, mediaBuffer);
          const base64Data = mediaBuffer.toString("base64");

          payload.media = {
            type: mediaInfo.mediaType,
            mimetype: mediaInfo.mediaNode?.mimetype || null,
            fileName: mediaInfo.mediaNode?.fileName || path.basename(savedPath),
            caption: mediaInfo.mediaNode?.caption || null,
            seconds: mediaInfo.mediaNode?.seconds || null,
            ptt: !!mediaInfo.mediaNode?.ptt,
            fileLength: mediaInfo.mediaNode?.fileLength || mediaBuffer.length,
            savedPath,
            base64: base64Data,
          };

          console.log(
            `📎 Media [${sender}] type=${payload.media.type} mimetype=${payload.media.mimetype || "unknown"} size=${mediaBuffer.length}B`
          );
        } catch (downloadErr) {
          payload.media = {
            type: mediaInfo.mediaType,
            downloadError: downloadErr?.message || "media download failed",
          };
          console.error(`⚠️ Media download failed [${sender}]: ${payload.media.downloadError}`);
        }
      } else {
        console.log(`📩 [${sender}] ${payload.messageType}: ${text || "(non-text event)"}`);
      }

      await handleWebhook(sock, payload);
    }
  });
}

// ─── Webhook Handler ───────────────────────────────────────────────────────
async function handleWebhook(sock, incomingPayload) {
  try {
    const fallbackWebhookUrl = N8N_WEBHOOK_URL.includes("/webhook-test/")
      ? N8N_WEBHOOK_URL.replace("/webhook-test/", "/webhook/")
      : null;
    const urlsToTry = fallbackWebhookUrl ? [N8N_WEBHOOK_URL, fallbackWebhookUrl] : [N8N_WEBHOOK_URL];
    const sender = incomingPayload.sender;
    let response = null;

    for (const webhookUrl of urlsToTry) {
      console.log(`➡️ Sending to n8n: ${webhookUrl}`);
      const attempt = await axios.post(
        webhookUrl,
        incomingPayload,
        {
          timeout: 15000,
          headers: { "Content-Type": "application/json" },
          responseType: "arraybuffer",
          validateStatus: () => true,
          maxBodyLength: 50 * 1024 * 1024,
          maxContentLength: 50 * 1024 * 1024,
        }
      );

      if (attempt.status >= 200 && attempt.status < 300) {
        response = attempt;
        console.log(`✅ n8n accepted message (status ${attempt.status})`);
        break;
      }

      const failText = Buffer.from(attempt.data || "").toString("utf-8").slice(0, 140);
      console.error(`⚠️ n8n rejected (${attempt.status}) at ${webhookUrl} ${failText ? `- ${failText}` : ""}`);
    }

    if (!response) {
      throw new Error("n8n webhook failed on all configured URLs");
    }

    const contentType = response.headers["content-type"] || "";

    if (contentType.includes("audio")) {
      const audioBuffer = Buffer.from(response.data);

      const isOgg = contentType.includes("ogg");

      await sock.sendMessage(sender, {
        audio: audioBuffer,
        mimetype: isOgg ? "audio/ogg; codecs=opus" : "audio/mpeg",
        ptt: isOgg,  // sirf ogg hone pe PTT enable karo
      });
      console.log(`🔊 Audio sent to [${sender}]`);

    } else {
      const rawText = Buffer.from(response.data).toString("utf-8");

      const parsed = (() => {
        try { return JSON.parse(rawText); } catch { return null; }
      })();

      const reply = parsed
        ? parsed?.reply || parsed?.message || parsed?.text || null
        : rawText || null;

      if (reply) {
        await sock.sendMessage(sender, { text: reply });
        console.log(`📤 Text replied to [${sender}]`);
      }
    }

  } catch(err) {
    console.error(`❌ Webhook error: ${err?.response?.status || err?.message}`);
  }
}

resetSessionIfNeeded()
  .then(() => connectToWhatsApp())
  .catch(err => { console.error("Fatal:", err); process.exit(1); });