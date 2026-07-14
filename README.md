# Arena CFO Profiles — Slack channel bot

Drop a résumé + headshot in `#cfo-profiles`, get the "Meet Your Arena CFO" flyer (PNG + PDF) posted back in the thread. No form, no clicks.

This package implements **Option A** from the design handoff (`Arena Design System.zip` → `design_references/SLACK-AUTOMATION.md`): the fully-automatic channel bot. It does not include Option B (hosted intake form + relay) — ask if you want that built too.

## What's in here

```
template/flyer.html   — standalone "Meet Your CFO" flyer, rebuilt in plain HTML/CSS/JS
                         from the design spec (colors, type, layout match the .dc.html
                         reference exactly). Exposes window.__arenaSetProfile(data) so
                         the bot can populate it headlessly.
bot/index.js           — Slack Bolt event handler (the bot itself)
bot/render.js           — Puppeteer: loads the flyer, injects data, screenshots -> PNG,
                          wraps that PNG in a one-page PDF
bot/package.json        — dependencies
bot/.env.example        — required environment variables
bot/puppeteer.config.cjs — fixes a "Could not find Chrome" error on Render (see below)
```

**A note on the flyer template:** the original `MeetYourCfo.dc.html` reference uses a
proprietary design-tool runtime (`support.js`, `{{ }}` bindings, `<sc-if>`/`<sc-for>`)
that only runs inside that design tool. Per that file's own handoff notes, it's not
meant to ship as-is into another codebase — so `template/flyer.html` reimplements the
same visual spec (pixel values, colors, fonts pulled directly from the handoff README)
as plain HTML so Puppeteer can render it headlessly. It does **not** yet include the
Arena wordmark image or the client-side headshot background-removal — see "Known gaps"
below.

## Before you deploy

1. **Drop in the real brand asset.** Put `arena-wordmark-navy.png` next to `flyer.html`
   (the template already references it by that filename with a silent fallback if
   missing). Get it from your design system export.
2. **Verify dependency versions.** The versions pinned in `bot/package.json` are a
   reasonable starting point but I haven't checked them against the npm registry as of
   today — run `npm install` and let npm resolve current versions, or check
   npmjs.com for `@slack/bolt`, `@anthropic-ai/sdk`, `puppeteer`, `pdf-parse`, `jspdf`.
3. **Verify the Claude model ID.** `bot/index.js` defaults to `ANTHROPIC_MODEL=claude-sonnet-4-5`.
   Confirm the current, correct model ID in the Claude docs (docs.claude.com) before
   deploying — model IDs are versioned and this default may drift out of date.
4. Follow the setup guide (separate doc) to create the Slack app, get tokens, and host
   this service.

## Fixing "Could not find Chrome" on Render

If the bot posts back an error like `Could not find Chrome (ver. ...)`, this is a
known Puppeteer-on-Render issue: by default Puppeteer downloads Chrome to
`~/.cache/puppeteer` during the build step, but Render doesn't carry that
directory over from build to the running app.

**Fix (already included):** `bot/puppeteer.config.cjs` redirects Puppeteer's
cache into the project directory itself, which *does* persist between build and
runtime on Render. To pick this up:

1. Make sure `bot/puppeteer.config.cjs` is committed to your repo (it's in this
   package already).
2. In the Render dashboard, use **Manual Deploy → Clear build cache & deploy**
   (not just a regular redeploy) so `npm install` re-downloads Chrome into the
   new cache path.
3. Re-test by posting a résumé + headshot again.

Sources: [Puppeteer configuration guide — "Changing the default cache directory"](https://pptr.dev/guides/configuration), [Render community: "Puppeteer fails to find Chromium on Render"](https://community.render.com/t/puppeteer-fails-to-find-chromium-on-render/9920).

## Known gaps vs. the full design spec

- **Headshot background removal** (the edge-connected flood-fill described in the
  handoff README) is a client-side canvas technique built for the browser-based intake
  form. This headless bot uses the raw uploaded photo as-is. Porting the removal logic
  to run server-side (e.g., via `node-canvas` or an image library) is a follow-up if you
  want it — say the word.
- **Résumé parsing** covers PDF and plain text (matches the reference spec). DOCX
  résumés are not handled; add a converter (e.g. `mammoth`) if your team uses Word files.
- This implements the "both files in one message" path called out as the simplest
  starting point in the spec. If résumé and headshot commonly arrive in separate
  messages, the bot currently asks the sender to reply with the missing one rather than
  buffering across messages — a small, well-scoped enhancement if you want it.

## Local test

```
cd bot
cp .env.example .env   # fill in real values
npm install
npm start
```

Then post a résumé + headshot together in a channel your Slack app has been invited to.
