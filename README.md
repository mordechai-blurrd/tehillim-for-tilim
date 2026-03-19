# תהילים לטילים — Tehillim for Tilim

> *"When rockets fly, we raise our voices to Heaven."*

Real-time rocket alert notifications for the global Jewish community. Powered by **Pikud Ha'oref** (Israel Home Front Command). Sends instant **email** (EmailJS) and **SMS** (Twilio) notifications to subscribers worldwide whenever rockets are fired toward Israel.

---

## How It Works

```
Pikud Ha'oref API ──► alertPoller.js ──► server.js ──► WebSocket ──► Browser UI
                                                  └──► notifier.js ──► EmailJS (email)
                                                                  └──► Twilio  (SMS)
```

1. `alertPoller.js` polls `oref.org.il` every 5 seconds (falls back to `tzevaadom.co.il`)
2. On a new alert, `server.js` broadcasts via WebSocket to all connected browsers
3. `notifier.js` sends email + SMS to all active subscribers
4. Frontend auto-reconnects on disconnect and shows live alert banner

---

## Quick Start (Local Dev)

```bash
# 1. Clone / unzip the project
cd tehillim-for-tilim

# 2. Install dependencies
npm install

# 3. Copy and fill in your credentials
cp .env.example .env
# Edit .env with your Twilio + EmailJS keys

# 4. Run
npm run dev
# → http://localhost:3000
```

---

## Step-by-Step Credential Setup

### A) EmailJS (Free — 200 emails/month)

1. Go to **https://emailjs.com** → Create free account
2. **Add a Service**: Connect Gmail, Outlook, or any SMTP
   - Dashboard → Email Services → Add New Service
   - Connect your sender email (e.g. `alerts@tehillimfortilim.com`)
   - Copy the **Service ID** → `EMAILJS_SERVICE_ID`

3. **Create an Alert Template**:
   - Dashboard → Email Templates → Create New Template
   - Subject: `🚨 Red Alert — Say Tehillim Now`
   - Body (HTML or text):
     ```
     Shalom {{to_name}},
     
     🚨 RED ALERT — Rocket fire detected near: {{areas}}
     Time: {{alert_time}}
     
     Please stop and say Tehillim now.
     
     עם ישראל חי — Am Yisrael Chai.
     
     Suggested Tehillim: Chapters 20, 83, 121, or 130.
     
     ─
     Unsubscribe: {{unsubscribe_url}}
     Tehillim for Tilim
     ```
   - Set **To Email** field to: `{{to_email}}`
   - Save → Copy the **Template ID** → `EMAILJS_TEMPLATE_ID`

4. **Create a Welcome Template** (optional but recommended):
   - Same process, subject: `Welcome to Tehillim for Tilim 🕊️`
   - Copy Template ID → `EMAILJS_WELCOME_TEMPLATE_ID`

5. **Get API Keys**:
   - Dashboard → Account → General → API Keys
   - Copy **Public Key** → `EMAILJS_PUBLIC_KEY`
   - Copy **Private Key** → `EMAILJS_PRIVATE_KEY`

---

### B) Twilio (SMS — Pay as you go, ~$0.008/SMS)

1. Go to **https://twilio.com** → Create account (free trial gives $15 credit)

2. **Get a phone number**:
   - Console → Phone Numbers → Manage → Buy a Number
   - Choose a number with SMS capability
   - For international reach, a US (+1) number works in most countries
   - Copy the number → `TWILIO_FROM_NUMBER` (format: `+12125550100`)

3. **Get credentials**:
   - Console Dashboard (top of page)
   - Copy **Account SID** → `TWILIO_ACCOUNT_SID`
   - Copy **Auth Token** → `TWILIO_AUTH_TOKEN`

4. **For global SMS** (outside US/Canada):
   - Go to Console → Messaging → Settings → Geo Permissions
   - Enable the countries you need (Israel, US, UK, etc.)
   - Some countries require a local sender ID — check Twilio's coverage docs

---

### C) .env File (final)

```env
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_FROM_NUMBER=+12125550100

EMAILJS_SERVICE_ID=service_xxxxxxx
EMAILJS_TEMPLATE_ID=template_xxxxxxx
EMAILJS_WELCOME_TEMPLATE_ID=template_yyyyyyy
EMAILJS_PUBLIC_KEY=xxxxxxxxxxxxxxxxxxxx
EMAILJS_PRIVATE_KEY=xxxxxxxxxxxxxxxxxxxx

PORT=3000
NODE_ENV=development
BASE_URL=http://localhost:3000
POLL_INTERVAL_SECONDS=5
ALERT_COOLDOWN_SECONDS=120
```

---

## Deploying to Production

### Option 1: Railway (Recommended — easiest, free tier)

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login + deploy
railway login
railway init
railway up

# Add environment variables
railway variables set TWILIO_ACCOUNT_SID=... TWILIO_AUTH_TOKEN=... # etc.

# Set your live URL
railway variables set BASE_URL=https://your-app.railway.app
```

Railway supports WebSockets natively. ✓

---

### Option 2: Render.com (Free tier available)

1. Push code to GitHub
2. New Web Service → connect repo
3. Build command: `npm install`
4. Start command: `node server.js`
5. Add all env vars in the Environment tab
6. Set `BASE_URL` to your Render URL

Render supports WebSockets. ✓

---

### Option 3: Vercel (Serverless — WebSockets need upgrade)

> ⚠️ Vercel's free tier doesn't support persistent WebSocket connections.
> Use Railway or Render instead, OR replace WebSocket with SSE (Server-Sent Events).
> `vercel.json` is included if you want to try Vercel Pro.

---

### Option 4: VPS / DigitalOcean Droplet

```bash
# On the server
git clone your-repo
cd tehillim-for-tilim
npm install
cp .env.example .env && nano .env   # fill in creds

# Run with PM2 (keeps it alive)
npm install -g pm2
pm2 start server.js --name t4t
pm2 startup && pm2 save

# Nginx reverse proxy (optional)
# Proxy :80 → :3000, enable WebSocket upgrade headers
```

---

## Scaling Beyond Free Tier

| Service | Free Tier | Paid |
|---------|-----------|------|
| EmailJS | 200 emails/month | $15/mo = 1,000/month |
| Twilio SMS | $15 trial credit | ~$0.008/SMS (US) |
| Railway | $5/mo after trial | $5/mo for hobby |

**For serious scale** (1,000+ subscribers):
- Replace EmailJS with **SendGrid** (free: 100/day, paid: 40k/month for $20)
- Replace file-based DB with **PostgreSQL** (Railway includes one free)
- Consider **Redis** for alert deduplication across restarts

---

## File Structure

```
tehillim-for-tilim/
├── server.js          ← Express + WebSocket server (main entry)
├── alertPoller.js     ← Pikud Ha'oref API polling (EventEmitter)
├── notifier.js        ← EmailJS + Twilio dispatch
├── db.js              ← Subscriber store (JSON file → swap for DB)
├── public/
│   └── index.html     ← Full frontend (WebSocket-connected)
├── .env.example       ← Template for credentials
├── .gitignore
├── vercel.json
└── package.json
```

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`  | `/api/status` | Current alert status + subscriber count |
| `POST` | `/api/subscribe` | Sign up (`name`, `method`, `email`, `phone`) |
| `GET`  | `/unsubscribe/:id` | One-click unsubscribe (from email/SMS link) |
| `GET`  | `/api/admin` | Subscriber list + alert log |
| `POST` | `/api/test-alert` | Trigger test alert (`areas: string[]`) |
| `WS`   | `/ws` | WebSocket: receives `alert`, `clear`, `status`, `dispatch_stats` |

---

## Alert Sources

| Source | URL | Notes |
|--------|-----|-------|
| Primary | `oref.org.il/WarningMessages/alert/alerts.json` | Official IDF Home Front Command |
| Fallback | `api.tzevaadom.co.il/alerts` | Community mirror, high uptime |

The poller automatically switches to the fallback after 3 consecutive primary failures and switches back when primary recovers.

---

## עם ישראל חי

---

## WhatsApp Setup (Twilio)

WhatsApp uses the **same Twilio account** as SMS — just a different sender format.

### Sandbox (Free — for testing)

1. In Twilio Console → **Messaging → Try it out → Send a WhatsApp message**
2. Note the sandbox number: `+1 415 523 8886` and your join keyword (e.g. `join bright-fish`)
3. Set in `.env`:
   ```
   TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
   ```
4. Each subscriber needs to send `join <your-keyword>` to `+1 415 523 8886` on WhatsApp **once** to opt in. The welcome message they receive will include instructions.

### Production (No opt-in required — users receive alerts directly)

1. Twilio Console → **Messaging → Senders → WhatsApp senders**
2. Click **"Apply to use WhatsApp"** — approval takes 1–5 business days
3. Once approved, you'll get a dedicated WhatsApp Business number
4. Update `.env`:
   ```
   TWILIO_WHATSAPP_FROM=whatsapp:+1XXXXXXXXXX
   ```

### WhatsApp Message Format

WhatsApp messages support **bold** (`*text*`) and _italic_ (`_text_`) formatting, which the notifier uses automatically for a clean, readable alert.

### Pricing

| Channel | Cost |
|---------|------|
| WhatsApp (user-initiated) | Free |
| WhatsApp (business-initiated, like alerts) | ~$0.005–$0.014/message depending on country |
| WhatsApp Business number setup | ~$5/month on Twilio |

WhatsApp is generally **cheaper than SMS** for international messages.
