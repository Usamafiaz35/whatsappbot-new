/**
 * WhatsApp Bot — Baileys + n8n Webhook
 * Lightweight, production-ready for Render free tier
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidBroadcast,
} = require("@whiskeysockets/baileys");

const axios = require("axios");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const path = require("path");

// ─── Config ────────────────────────────────────────────────────────────────
const N8N_WEBHOOK_URL = "https://n8n-jyfj.onrender.com/webhook/whatsapp";
const SESSION_DIR = path.join(__dirname, "auth_info");
const RECONNECT_DELAY_MS = 5000; // 5 sec retry on disconnect

// Minimal logger — only errors reach stdout (saves RAM on Render)
const logger = pino({ level: "silent" });

// ─── Main Connection Function ───────────────────────────────────────────────
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      // Cacheable store = lower memory usage
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: false,       // We handle QR manually
    browser: ["WhatsApp Bot", "Chrome", "1.0.0"],
    syncFullHistory: false,         // Don't pull old messages (saves RAM)
    markOnlineOnConnect: false,     // Stay invisible
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined, // Skip message retry store
  });

  // ── Connection Updates ──────────────────────────────────────────────────
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n📱 Scan this QR code in WhatsApp → Linked Devices:\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("✅ WhatsApp Connected!");
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        console.log(`🔄 Reconnecting in ${RECONNECT_DELAY_MS / 1000}s... (reason: ${statusCode})`);
        setTimeout(connectToWhatsApp, RECONNECT_DELAY_MS);
      } else {
        console.log("🚫 Logged out. Delete auth_info folder and restart.");
      }
    }
  });

  // ── Save Credentials on Update ──────────────────────────────────────────
  sock.ev.on("creds.update", saveCreds);

  // ── Incoming Messages ───────────────────────────────────────────────────
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    // Only process new real-time messages
    if (type !== "notify") return;

    for (const msg of messages) {
      // Skip: outgoing, broadcast, status updates
      if (
        msg.key.fromMe ||
        isJidBroadcast(msg.key.remoteJid) ||
        msg.key.remoteJid === "status@broadcast"
      ) {
        continue;
      }

      const sender = msg.key.remoteJid;

      // Extract text from any common message type
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        null;

      if (!sender || !text) continue;

      console.log(`📩 [${sender}]: ${text}`);

      // Forward to n8n and reply
      await handleWebhook(sock, sender, text);
    }
  });
}

// ─── Webhook Handler ────────────────────────────────────────────────────────
async function handleWebhook(sock, sender, text) {
  try {
    const { data } = await axios.post(
      N8N_WEBHOOK_URL,
      { sender, message: text },
      {
        timeout: 15000,
        headers: { "Content-Type": "application/json" },
      }
    );

    // n8n can return: string | { reply: string } | { message: string }
    const reply =
      typeof data === "string"
        ? data
        : data?.reply || data?.message || data?.text || null;

    if (reply) {
      await sock.sendMessage(sender, { text: reply });
      console.log(`📤 Replied to [${sender}]`);
    }
  } catch (err) {
    const status = err?.response?.status;
    const msg = err?.message;
    console.error(`❌ Webhook error [${status || msg}] for ${sender}`);
  }
}

// ─── Boot ───────────────────────────────────────────────────────────────────
connectToWhatsApp().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
