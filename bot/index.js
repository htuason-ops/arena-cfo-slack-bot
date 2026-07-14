// Arena CFO Profiles — Slack channel bot (Option A: fully automatic).
//
// Flow: a team member posts a résumé (+ ideally a headshot) as file(s) in the
// watched channel (e.g. #cfo-profiles) -> this bot downloads the file(s),
// asks Claude to extract structured profile data, removes the headshot's
// background, renders the "Meet Your Arena CFO" flyer headlessly, and posts
// the PNG + PDF back in the same thread.
//
// The résumé and headshot can arrive together in one message, OR as two
// separate messages from the same person within a short window (see
// PENDING_TIMEOUT_MS below) — the bot holds onto whichever arrives first and
// combines them once the second one shows up.
//
// Required env vars (see .env.example):
//   SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, ANTHROPIC_API_KEY
// (FLYER_URL is optional — it defaults to the template shipped in this
// bot/template folder; only set it if you're pointing at a hosted copy.)
//
// This is adapted from the reference implementation in
// design_references/SLACK-AUTOMATION.md (Option A), hardened with basic
// validation, per-thread de-duplication, cross-message pairing, and error
// reporting back to Slack.

require('dotenv').config();
const { App } = require('@slack/bolt');
const pdfParse = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk');
const { renderFlyerFiles } = require('./render');
const { removeBackgroundAndCrop } = require('./bg-remove');

const REQUIRED_ENV = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'ANTHROPIC_API_KEY'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}. See .env.example.`);
    process.exit(1);
  }
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// NOTE: verify this is a currently-available model ID in your Anthropic
// console / the Claude docs (https://docs.claude.com) before deploying —
// model IDs change over time and this repo cannot guarantee it's current.
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

// Very small in-memory guard so a message isn't processed twice if Slack
// retries the event (e.g. on a slow response). Fine for team-scale volume;
// swap for a real queue/store if you need this to survive restarts.
const seen = new Set();

// How long to hold onto a résumé (or headshot) while waiting for the other
// one to show up in a separate message from the same person, before nudging
// them instead. In-memory only — restarting the bot drops anything pending.
const PENDING_TIMEOUT_MS = 90 * 1000;
const pending = new Map(); // key: `${channel}:${user}` -> { resume, resumeTs, photo, photoTs, timer }

const PROFILE_PROMPT = (text) =>
  'Résumé text:\n"""\n' + text.slice(0, 12000) + '\n"""\n\n' +
  "Extract data for a 'Meet Your Arena CFO' marketing profile. Return ONLY minified JSON " +
  '(no prose, no markdown code fences) with keys: name (string), email (string, or "" if not ' +
  'present), quote (a concise first-person professional quote, 1-2 sentences, capturing their ' +
  'approach or philosophy — adapt from any summary/objective, otherwise craft one from their ' +
  'experience), education (array of degrees/certifications, most notable first, max 4 short ' +
  'strings), expertise (array of skills in Title Case, max 9 short strings), field (array of ' +
  'industries/verticals served, max 6 short strings).';

function parseProfileJson(raw) {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Model did not return JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function downloadSlackFile(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Slack file download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function buildAndPostProfile({ client, channel, user, threadTs, resume, photo }) {
  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: `<@${user}> Building your Arena CFO profile… :hourglass_flowing_sand:`,
  });

  const token = process.env.SLACK_BOT_TOKEN;
  const [resumeBuf, rawPhotoBuf] = await Promise.all([
    downloadSlackFile(resume.url_private_download, token),
    downloadSlackFile(photo.url_private_download, token),
  ]);

  const resumeText = /pdf/i.test(resume.mimetype || '')
    ? (await pdfParse(resumeBuf)).text
    : resumeBuf.toString('utf8');

  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1200,
    messages: [{ role: 'user', content: PROFILE_PROMPT(resumeText) }],
  });
  const textBlock = msg.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('No text response from model');
  const data = parseProfileJson(textBlock.text);

  // Background removal is a nice-to-have on top of the core flyer — if it
  // fails for any reason, fall back to the raw uploaded photo rather than
  // failing the whole profile (same behavior as the original browser-based
  // template: "Using photo as-is (auto-cut skipped)").
  let photoBuf = rawPhotoBuf;
  let photoMimetype = photo.mimetype;
  try {
    photoBuf = await removeBackgroundAndCrop(rawPhotoBuf);
    photoMimetype = 'image/png';
  } catch (err) {
    console.error('Background removal failed, using original photo:', err.message);
  }

  const { png, pdf } = await renderFlyerFiles(data, photoBuf, photoMimetype);

  const base = `ArenaCFO Profile - ${(data.name || 'cfo').replace(/\s+/g, '-')}`;
  await client.files.uploadV2({
    channel_id: channel,
    thread_ts: threadTs,
    initial_comment: `<@${user}> here's your Meet Your Arena CFO profile :white_check_mark:`,
    file_uploads: [
      { file: png, filename: `${base}.png` },
      { file: pdf, filename: `${base}.pdf` },
    ],
  });
}

app.event('message', async ({ event, client }) => {
  const pendingKey = `${event.channel}:${event.user}`;
  try {
    if (event.subtype !== 'file_share' || !event.files || !event.files.length) return;

    const dedupeKey = `${event.channel}:${event.ts}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    const resume = event.files.find((f) => /pdf|text/i.test(f.mimetype || '') || /\.(pdf|txt)$/i.test(f.name || ''));
    const photo = event.files.find((f) => /^image\//i.test(f.mimetype || ''));

    if (!resume && !photo) return; // not a résumé or headshot, ignore

    const existing = pending.get(pendingKey) || {};
    if (existing.timer) clearTimeout(existing.timer);
    if (resume) { existing.resume = resume; existing.resumeTs = event.ts; }
    if (photo) { existing.photo = photo; existing.photoTs = event.ts; }

    if (existing.resume && existing.photo) {
      // Complete pair — process now, replying in the thread of whichever
      // message just completed it.
      pending.delete(pendingKey);
      await buildAndPostProfile({
        client,
        channel: event.channel,
        user: event.user,
        threadTs: event.ts,
        resume: existing.resume,
        photo: existing.photo,
      });
      return;
    }

    // Only have one of the two so far — wait a bit for the other one to
    // arrive in a separate message before nudging.
    existing.timer = setTimeout(async () => {
      pending.delete(pendingKey);
      const missing = existing.resume ? 'a headshot' : 'a résumé (PDF or .txt)';
      const gotTs = existing.resume ? existing.resumeTs : existing.photoTs;
      try {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: gotTs,
          text: `<@${event.user}> got that — still need ${missing} to build your Arena CFO profile. Post it here (same channel) and I'll pick it up.`,
        });
      } catch (_) { /* best effort */ }
    }, PENDING_TIMEOUT_MS);
    pending.set(pendingKey, existing);
  } catch (err) {
    console.error('Failed to build CFO profile:', err);
    pending.delete(pendingKey);
    try {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: `Sorry <@${event.user}>, something went wrong building that profile: ${err.message}. Ping whoever maintains this bot.`,
      });
    } catch (_) { /* best effort */ }
  }
});

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`Arena CFO Slack bot listening on :${port}`);
})();
