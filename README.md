# WhatsApp Bot — Baileys + n8n

Minimal, memory-efficient WhatsApp automation.
Runs stably on **Render free tier**.

---

## 📁 Project Structure

```
whatsapp-bot/
├── index.js          ← main bot (single file)
├── package.json
├── .gitignore
└── auth_info/        ← auto-created on first run (session files)
```

---

## ⚙️ Setup & Run

### 1. Install dependencies
```bash
npm install
```

### 2. First run — scan QR
```bash
node index.js
```
- A QR code will appear in terminal.
- Open WhatsApp → **Settings → Linked Devices → Link a Device**.
- Scan the QR.
- You'll see: `✅ WhatsApp Connected!`

### 3. Subsequent runs — no QR needed
```bash
node index.js
# Session reloads from auth_info/ automatically
```

---

## 🚀 Deploy on Render

1. Push this folder to a **GitHub repo**.
2. Create a new **Web Service** on [render.com](https://render.com).
3. Settings:
   | Field | Value |
   |-------|-------|
   | Runtime | Node |
   | Build Command | `npm install` |
   | Start Command | `node index.js` |
   | Instance Type | Free |

4. **First deploy**: Go to Render logs, copy the QR, scan it.
5. Session is saved — no QR on future redeploys.

> ⚠️ **Important**: Add `auth_info/` to `.gitignore` so session files
> are NOT committed to GitHub. Use Render's **Persistent Disk** (paid)
> or a session-save strategy if you need true persistence across deploys.

---

## 🔄 Flow

```
WhatsApp Message
      ↓
  index.js (Baileys)
      ↓
  POST → n8n Webhook
      ↓
  n8n processes & returns reply
      ↓
  Bot sends reply back to user
```

---

## 📦 n8n Webhook Payload

**Bot sends to n8n:**
```json
{
  "sender": "923001234567@s.whatsapp.net",
  "message": "Hello!"
}
```

**n8n should return:**
```json
{ "reply": "Your response text here" }
```
or plain text string.

---

## 🛡️ .gitignore (recommended)

```
node_modules/
auth_info/
```
