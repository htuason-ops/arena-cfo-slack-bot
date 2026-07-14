# Arena CFO Profiles — Slack channel bot

Drop a résumé + headshot in `#cfo-profiles`, get the "Meet Your Arena CFO" flyer (PNG + PDF) posted back in the thread. No form, no clicks.

This package implements **Option A** from the design handoff (`Arena Design System.zip` → `design_references/SLACK-AUTOMATION.md`): the fully-automatic channel bot. It does not include Option B (hosted intake form + relay) — ask if you want that built too.

## What's in here

Everything lives inside `bot/` — one self-contained folder, so however you upload or
check it out, the paths inside it always resolve correctly:

```
bot/index.js                — Slack Bolt event handler (the bot itself). Also handles
                                pairing a résumé + headshot that arrive in two separate
                                messages from the same person (see "Two-message uploads").
bot/render.js                — loads the flyer, injects data, screenshots -> PNG,
                                wraps that PNG in a one-page PDF (via puppeteer-core +
                                @sparticuz/chromium — see "Why puppeteer-core" below)
bot/bg-remove.js             — server-side headshot background removal + crop-to-subject,
                                ported from the original design's browser canvas logic
                                (see "Headshot background removal" below)
bot/template/flyer.html      — standalone "Meet Your CFO" flyer, rebuilt in plain HTML/CSS/JS
                                from the design spec (colors, type, layout match the .dc.html
                                reference exactly, minus the email line — see note below).
                                Exposes window.__arenaSetProfile(data) so the bot can
                                populate it headlessly. render.js finds this file
                                automatically (it's resolved relative to render.js itself).
bot/template/arena-wordmark-navy.png — the real Arena wordmark (pulled from the
                                #arena-brand-guidelines canvas in Slack), pre-cropped to
                                just the logo content so it displays at the right
                                proportions in the header.
bot/package.json             — dependencies
bot/.env.example             — environment variables (FLYER_URL is optional — only needed
                                if you want to point at a hosted copy instead of the local one)
```

**A note on the flyer template:** the original `MeetYourCfo.dc.html` reference uses a
proprietary design-tool runtime (`support.js`, `{{ }}` bindings, `<sc-if>`/`<sc-for>`)
that only runs inside that design tool. Per that file's own handoff notes, it's not
meant to ship as-is into another codebase — so `bot/template/flyer.html` reimplements the
same visual spec (pixel values, colors, fonts pulled directly from the handoff README)
as plain HTML so Puppeteer can render it headlessly. One intentional difference from the
original spec: the **email line has been removed** from the flyer (per request). The
Arena wordmark is the real brand asset (see below), not a placeholder.

## Headshot background removal

`bot/bg-remove.js` ports the exact algorithm from the original browser-based template
(`MeetYourCfo.dc.html`'s `removeBg` method) to run server-side with `sharp` instead of
`<canvas>`: it samples background color from the top edge/corners, flood-fills
background pixels starting only from the image border (so light interior areas like a
white shirt are preserved), zeroes their alpha, softens the cutout edge, then crops to
the bounding box of what's left. For a typical headshot (subject filling most of the
frame) that crop naturally comes out as a head-and-shoulders shot with the background
gone. If it can't detect a subject (e.g. a very unusual photo), it falls back to the
original uploaded photo rather than failing the whole profile — same behavior as the
original design.

## Two-message uploads

The bot no longer requires the résumé and headshot in the same Slack message. If only
one shows up, it's held in memory (keyed by channel + sender) for 90 seconds; if the
other one arrives from the same person in that window, the bot combines them
automatically. If the window elapses first, it nudges the sender for whatever's still
missing. This is in-memory only — restarting the bot drops anything pending, and it
won't survive a multi-instance deploy (each instance has its own memory) — fine for a
single-instance team bot, worth revisiting if you scale this out.

## Before you deploy

1. **Verify dependency versions.** The versions pinned in `bot/package.json` are a
   reasonable starting point but I haven't checked them against the npm registry as of
   today — run `npm install` and let npm resolve current versions, or check
   npmjs.com for `@slack/bolt`, `@anthropic-ai/sdk`, `puppeteer-core`, `@sparticuz/chromium`,
   `pdf-parse`, `jspdf`, `sharp`. For `@sparticuz/chromium` specifically, its README recommends
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

- **Résumé parsing** covers PDF and plain text (matches the reference spec). DOCX
  résumés are not handled; add a converter (e.g. `mammoth`) if your team uses Word files.
- **Two-message pairing is in-memory and single-instance** (see above) — fine for normal
  team use, but won't survive a bot restart mid-wait or a multi-instance deployment.

## Local test

```
cd bot
cp .env.example .env   # fill in real values
npm install
npm start
```

Then post a résumé + headshot together in a channel your Slack app has been invited to.
