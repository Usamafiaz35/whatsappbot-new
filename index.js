/**
 * WhatsApp Bot — Baileys + n8n Webhook
 * QR code browser mein dikhta hai (Render ke liye)
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
} = require("@whiskeysockets/baileys");

const axios  = require("axios");
const qrcode = require("qrcode");
const pino   = require("pino");
const http   = require("http");
const path   = require("path");

const N8N_WEBHOOK_URL = "https://n8n-jyfj.onrender.com/webhook/whatsapp";
const SESSION_DIR     = path.join(__dirname, "auth_info");
const PORT            = process.env.PORT || 3000;
const RECONNECT_MS    = 5000;

const logger = pino({ level: "silent" });

let currentQR   = null;
let isConnected = false;
let waSocket    = null;

// ─── HTTP Server ───────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {

  if (req.method === "GET" && req.url === "/") {
    if (isConnected) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0f0f0f;color:#00e676;">
        <h1>✅ WhatsApp Connected!</h1><p>Bot is running fine.</p>
      </body></html>`);
      return;
    }

    if (!currentQR) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#0f0f0f;color:#fff;">
        <h2>⏳ QR Loading...</h2><p>Refresh in 5 seconds.</p>
        <script>setTimeout(()=>location.reload(),4000)</script>
      </body></html>`);
      return;
    }

    try {
      const qrImage = await qrcode.toDataURL(currentQR, { width: 400 });
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html>
<html>
<head>
  <title>WhatsApp QR</title>
  <meta http-equiv="refresh" content="30">
  <style>
    body{background:#0f0f0f;color:#fff;font-family:sans-serif;
         display:flex;flex-direction:column;align-items:center;
         justify-content:center;min-height:100vh;margin:0}
    img{border:8px solid #fff;border-radius:16px;margin:24px 0}
    p{color:#aaa;font-size:14px}
  </style>
</head>
<body>
  <h2>📱 WhatsApp se Scan karo</h2>
  <img src="${qrImage}" width="320" height="320"/>
  <p>WhatsApp → Settings → Linked Devices → Link a Device</p>
  <p style="color:#ff5252">Page 30s mein auto-refresh hota hai</p>
</body>
</html>`);
    } catch(e) { res.writeHead(500).end("QR error"); }
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

server.listen(PORT, () => console.log(`🌐 Server started on port ${PORT}`));

// ─── WhatsApp Connection ───────────────────────────────────────────────────
async function connectToWhatsApp() {
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

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) { currentQR = qr; isConnected = false; console.log("📱 QR ready — open Render URL in browser"); }
    if (connection === "open")  { currentQR = null; isConnected = true; console.log("✅ WhatsApp Connected!"); }
    if (connection === "close") {
      isConnected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        console.log(`🔄 Reconnecting... (${code})`);
        setTimeout(connectToWhatsApp, RECONNECT_MS);
      } else { console.log("🚫 Logged out. Delete auth_info and restart."); }
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe || isJidBroadcast(msg.key.remoteJid) || msg.key.remoteJid === "status@broadcast") continue;
      const sender = msg.key.remoteJid;
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text ||
                   msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || null;
      if (!sender || !text) continue;
      console.log(`📩 [${sender}]: ${text}`);
      await handleWebhook(sock, sender, text);
    }
  });
}

async function handleWebhook(sock, sender, text) {
  try {
    const { data } = await axios.post(N8N_WEBHOOK_URL, { sender, message: text },
      { timeout: 0, headers: { "Content-Type": "application/json" } });
    const reply = typeof data === "string" ? data : data?.reply || data?.message || data?.text || null;
    if (reply) { await sock.sendMessage(sender, { text: reply }); console.log(`📤 Replied to [${sender}]`); }
  } catch(err) { console.error(`❌ Webhook error: ${err?.response?.status || err?.message}`); }
}

connectToWhatsApp().catch(err => { console.error("Fatal:", err); process.exit(1); });