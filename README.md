# Arena CFO Profiles — Slack channel bot

Drop a résumé + headshot in `#cfo-profiles`, get the "Meet Your Arena CFO" flyer (PNG + PDF) posted back in the thread. No form, no clicks.

This package implements **Option A** from the design handoff (`Arena Design System.zip` → `design_references/SLACK-AUTOMATION.md`): the fully-automatic channel bot. It does not include Option B (hosted intake form + relay) — ask if you want that built too.

## What's in here

Everything lives inside `bot/` — one self-contained folder, so however you upload or
check it out, the paths inside it always resolve correctly:

```
bot/index.js                — Slack Bolt event handler (the bot itself)
bot/render.js                — loads the flyer, injects data, screenshots -> PNG,
                                wraps that PNG in a one-page PDF (via puppeteer-core +
                                @sparticuz/chromium — see "Why puppeteer-core" below)
bot/template/flyer.html      — standalone "Meet Your CFO" flyer, rebuilt in plain HTML/CSS/JS
                                from the design spec (colors, type, layout match the .dc.html
                                reference exactly). Exposes window.__arenaSetProfile(data) so
                                the bot can populate it headlessly. render.js finds this file
                                automatically (it's resolved relative to render.js itself).
bot/package.json             — dependencies
bot/.env.example             — environment variables (FLYER_URL is optional — only needed
                                if you want to point at a hosted copy instead of the local one)
```

**A note on the flyer template:** the original `MeetYourCfo.dc.html` reference uses a
proprietary design-tool runtime (`support.js`, `{{ }}` bindings, `<sc-if>`/`<sc-for>`)
that only runs inside that design tool. Per that file's own handoff notes, it's not
meant to ship as-is into another codebase — so `bot/template/flyer.html` reimplements the
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
   npmjs.com for `@slack/bolt`, `@anthropic-ai/sdk`, `puppeteer-core`, `@sparticuz/chromium`,
   `pdf-parse`, `jspdf`. For `@sparticuz/chromium` specifically, its README recommends
   matching its major version to the Chromium version your `puppeteer-core` release
   expects (see the package's own compatibility notes) — worth a quick check if browser
   launches ever start failing after a dependency update.
3. **Verify the Claude model ID.** `bot/index.js` defaults to `ANTHROPIC_MODEL=claude-sonnet-4-5`.
   Confirm the current, correct model ID in the Claude docs (docs.claude.com) before
   deploying — model IDs are versioned and this default may drift out of date.
4. Follow the setup guide (separate doc) to create the Slack app, get tokens, and host
   this service.

## Why `puppeteer-core` + `@sparticuz/chromium` instead of `puppeteer`

Earlier versions of this package used the full `puppeteer` package, which
downloads its own Chrome binary during `npm install`. On Render that caused a
repeating "Could not find Chrome" error: the download either landed in a
cache path the running app couldn't see, or didn't run at all during the
build step (both are documented Puppeteer-on-PaaS pain points).

**Current approach:** `puppeteer-core` (the automation API, no bundled
browser) paired with `@sparticuz/chromium` (a Chromium build shipped as a
regular npm package asset, unpacked at runtime — no separate download step,
no cache-path guessing). This is the standard fix recommended for exactly
this class of "browser missing at runtime" problem on constrained/PaaS hosts.

If you're migrating a repo that still has the old files: remove
`bot/puppeteer.config.cjs` if it's present (no longer used), make sure
`bot/package.json` lists `puppeteer-core` and `@sparticuz/chromium` (not
`puppeteer`), and set Render's **Build Command** back to plain `npm install`
— no special Chrome-install step is needed with this approach.

One resource note: `@sparticuz/chromium`'s own docs suggest at least 512 MB of
RAM, more comfortably 1+ GB — worth checking your Render instance's plan if
you're on a very constrained tier.

Sources: [@sparticuz/chromium on npm](https://www.npmjs.com/package/@sparticuz/chromium).

### If you hit "net::ERR_FILE_NOT_FOUND" pointing at a flyer.html path

The template lives at `bot/template/flyer.html`, and `render.js` locates it
relative to its own file location — not a hardcoded absolute path — so this
shouldn't happen with the current code. If it does, double-check the
`template/` folder was uploaded together with the rest of `bot/` (not left out
or placed elsewhere in the repo), and that no leftover `FLYER_URL` environment
variable in Render is pointing at a stale path (delete it if present — it's
optional and unnecessary for a normal deploy).

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
