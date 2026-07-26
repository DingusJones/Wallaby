# Wallaby 🦘

Cross-chain DeFi wallet position viewer. Like Rabby Wallet, but as a website — and it covers **Solana too**, not just EVM chains.

## What It Does

- Enter any wallet address (EVM or Solana) → see all DeFi positions (LPs, staking, lending, farming) across every chain
- Add multiple wallets, switch between them with tabs
- Filter by chain, see net worth, total positions, protocols, best APY
- Dark mode, mobile-first, clean design
- Runs on GitHub Pages (static frontend) + Cloudflare Workers (API proxy)

## Architecture

```
Browser (GitHub Pages)  →  Cloudflare Worker (hides API keys)  →  1inch Portfolio API + Mobula API
```

- **Frontend:** `index.html` + `styles.css` + `app.js` — static site, no backend
- **Proxy:** `worker.js` — Cloudflare Worker that injects API keys server-side
- **Data sources:**
  - **1inch Portfolio V5** (primary) — covers EVM + Solana, dedicated `/positions` endpoint
  - **Mobula** (backup/supplement) — cross-chain balances, Solana support
  - **Helius** (future) — for deep Solana position parsing

## Setup

### 1. Get API Keys (all free tiers)
- **1inch:** https://portal.1inch.dev/ — create account, get API key
- **Mobula:** https://mobula.io/ — create account, get API key

### 2. Deploy the Cloudflare Worker
```bash
# Install wrangler if you don't have it
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Set secrets
wrangler secret put ONEINCH_API_KEY    # paste your 1inch key
wrangler secret put MOBULA_API_KEY      # paste your Mobula key

# Deploy
wrangler deploy
```

### 3. Configure the Frontend
Edit `app.js`, set `CONFIG.proxyUrl` to your worker URL:
```js
proxyUrl: 'https://wallaby-proxy.your-subdomain.workers.dev',
```

### 4. Deploy to GitHub Pages
```bash
git init
git remote add origin git@github.com:DingusJones/wallaby.git
git add .
git commit -m "Wallaby: cross-chain wallet position viewer"
git push -u origin main
```
Then enable GitHub Pages in repo settings → Pages → Source → `main` branch.

## Local Testing
Open `index.html` in a browser. For the API to work, you need the Cloudflare Worker deployed (or run `wrangler dev` locally and point `proxyUrl` to `http://localhost:8787`).

## Tech Stack
- Vanilla JS (no frameworks, no build step)
- CSS custom properties (dark theme)
- Cloudflare Workers (serverless proxy)
- 1inch Portfolio API + Mobula API
- GitHub Pages hosting