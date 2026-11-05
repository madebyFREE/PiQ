# PiQ

A private photo studio and AI mentor for Oliver.

- `docs/`: the website (GitHub Pages serves this folder)
- `worker/`: the private server (a Cloudflare Worker). It holds the Anthropic API key, checks access codes, runs a safety check on every chat message, and stores everything in the private data repo.
- `data/`: starter files for the private **piq-data** repo. Don't publish these in the public site repo.

## How it fits together

```
Oliver's browser ──> GitHub Pages site (docs/)
                        │  access code → session token
                        ▼
                 Cloudflare Worker (worker/) ──> Anthropic API (Claude)
                        │
                        ▼
          private GitHub repo "piq-data": profile.json, thread.json,
          photos/, brief.json, contests.json; safety flags become Issues
                        ▲
         Weekly check-in (Claude scheduled task) reads/writes here
```

## Safety measures (Anthropic's guidelines for products used by minors)

- **Only intended users:** access codes for Oliver and the parent. No public sign-up.
- **Content moderation:** a classifier checks every message before PiQ answers. Urgent messages get crisis resources and are not sent to the mentor model. Messages that need a look still get an answer.
- **Monitoring:** both kinds of flag open an Issue in `piq-data` (GitHub emails you). Parent view lets you read every conversation.
- **Disclosure:** the site says PiQ is an AI on the login screen, in the studio and next to the chat box.
- **Scope:** PiQ's instructions limit it to photography, captions/statements, contests and portfolio, with teen-appropriate rules. There's also a daily chat limit.
- **Privacy:** data lives only in your private repo. Nothing is shared or sold.

## Setup

1. **GitHub**
   - Create a public repo `piq` (the site) and a private repo `piq-data` (the data).
   - Push this folder to `piq`, minus `data/`. Push the contents of `data/` to `piq-data`.
   - In `piq`, go to Settings → Pages → Deploy from a branch → `main` / `/docs`.
   - Create a fine-grained token (Settings → Developer settings → Fine-grained tokens) with access to **only** `piq-data`, permissions **Contents: Read and write** and **Issues: Read and write**.
   - In `piq-data`, click **Watch → Custom → Issues** so safety flags email you.
2. **Anthropic**
   - At console.anthropic.com, add billing, create an API key and set a monthly spend limit (for example $10).
3. **Cloudflare** (free)
   - **Dashboard route, no command line:** Workers & Pages → Create → Worker → name it `piq` → Edit code → paste `worker/src/index.js` → Deploy.
   - Then go to Settings → Variables and secrets and add the values below.
   - **CLI route:** in `worker/`, edit `wrangler.toml`, then run `npx wrangler login`, `npx wrangler secret put …` for each secret, and `npx wrangler deploy`.
   - Variables (plain text):
     - `DATA_REPO` = `yourname/piq-data`
     - `SITE_ORIGIN` = `https://yourname.github.io`
     - `CHAT_MODEL` = `claude-sonnet-5-5`
     - `MOD_MODEL` = `claude-haiku-5-5`
     - `DAILY_CHAT_LIMIT` = `60`
   - Secrets (encrypted):
     - `ANTHROPIC_API_KEY`
     - `GITHUB_TOKEN`
     - `OLIVER_CODE`: something memorable but not guessable, for example three random words and a number
     - `PARENT_CODE`
     - `SESSION_SECRET`: any long random string
4. **Connect the two**
   - Put the Worker's URL (`https://piq.<you>.workers.dev`) into `docs/index.html` → `window.PIQ_API`, and push.
5. **Test**
   - Open the site, enter the parent code (read-only view), then Oliver's code.
   - Send a test message.
6. **Hand off**
   - Give Oliver the site address and his code.

Cost: Cloudflare and GitHub Pages are free. Claude API usage for one student is typically a few dollars a month. The daily limit and the Console spend limit cap it.
