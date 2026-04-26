# WhatsApp Bot — Baileys + n8n

Minimal WhatsApp bot for n8n automation, ready for Render free deployment.

## What this does

- Receives WhatsApp messages (text + media).
- Sends data to your n8n webhook.
- Sends n8n response back to WhatsApp.
- Shows QR on browser URL (`/`) for linking WhatsApp.

## Render behavior in this project

- Server binds to Render `PORT` automatically.
- QR is shown on your running service URL (`https://your-app.onrender.com`).
- Session is cleared on every restart (fresh login each time).
  - Controlled by `RESET_SESSION_ON_START` (default is `true`).

## Required files

Already included:

- `package.json` with `start` script (`node index.js`)
- `.gitignore` for `node_modules/` and `auth_info/`

Recommended `.gitignore`:

```gitignore
node_modules/
auth_info/
media/
```

## Local run

```bash
npm install
node index.js
```

Open:

- `http://localhost:3000` (or the port shown in terminal)

## Step 1: Create GitHub repository

1. Go to [https://github.com/new](https://github.com/new)
2. Repository name: for example `whatsapp-n8n-bot`
3. Keep it Public or Private (your choice)
4. Click **Create repository**

## Step 2: Push code to GitHub

Run these commands inside your project folder:

```bash
git init
git add .
git commit -m "Initial WhatsApp Baileys bot"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

If repo is already initialized, skip `git init`.

## Step 3: Deploy on Render

1. Open [https://render.com](https://render.com)
2. Click **New +** → **Web Service**
3. Connect your GitHub repo
4. Use these settings:
   - Runtime: `Node`
   - Build Command: `npm install`
   - Start Command: `node index.js`
   - Plan: `Free`
5. Add environment variables:
   - `N8N_WEBHOOK_URL` = your n8n webhook URL
   - `PUBLIC_BASE_URL` = your Render URL (example: `https://your-app.onrender.com`)
   - `RESET_SESSION_ON_START` = `true`
6. Deploy

## Step 4: Scan QR on Render URL

After deploy:

1. Open your Render URL in browser:
   - `https://your-app.onrender.com`
2. QR page will appear.
3. WhatsApp → Linked Devices → Link a Device → scan QR.

## Notes

- If service restarts, session is removed by design, and new QR login is required.
- For stable long-term session persistence, this behavior can be turned off by setting:
  - `RESET_SESSION_ON_START=false`
