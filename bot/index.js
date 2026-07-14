// Arena CFO Profiles — Slack channel bot (Option A: fully automatic).
//
// Flow: a team member posts a résumé (+ ideally a headshot) as a file in the
// watched channel (e.g. #cfo-profiles) -> this bot downloads the file(s),
// asks Claude to extract structured profile data, renders the "Meet Your
// Arena CFO" flyer headlessly, and posts the PNG + PDF back in the same
// thread.
//
// Required env vars (see .env.example):
//   SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, ANTHROPIC_API_KEY
// (FLYER_URL is optional — it defaults to the template shipped in this
// bot/template folder; only set it if you're pointing at a hosted copy.)
//
// This is adapted from the reference implementation in
// design_references/SLACK-AUTOMATION.md (Option A), hardened with basic
// validation, per-thread de-duplication, and error reporting back to Slack.

require('dotenv').config();
const { App } = require('@slack/bolt');
const pdfParse = require('pdf-parse');
const Anthropic = require('@anthropic-ai/sdk');
const { renderFlyerFiles } = require('./render');

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

// Very small in-memory guard so a thread isn't processed twice if Slack
// retries the event (e.g. on a slow response). Fine for team-scale volume;
// swap for a real queue/store if you need this to survive restarts.
const seen = new Set();

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

app.event('message', async ({ event, client }) => {
  try {
    if (event.subtype !== 'file_share' || !event.files || !event.files.length) return;

    const dedupeKey = `${event.channel}:${event.ts}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    const resume = event.files.find((f) => /pdf|text/i.test(f.mimetype || '') || /\.(pdf|txt)$/i.test(f.name || ''));
    const photo = event.files.find((f) => /^image\//i.test(f.mimetype || ''));

    if (!resume) return; // wait until a message with a résumé shows up

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: `<@${event.user}> Building your Arena CFO profile… :hourglass_flowing_sand:`,
    });

    if (!photo) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: `<@${event.user}> I don't see a headshot attached — reply to this thread with one and I'll rebuild the profile, or send both files together next time.`,
      });
      return;
    }

    const token = process.env.SLACK_BOT_TOKEN;
    const [resumeBuf, photoBuf] = await Promise.all([
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

    const { png, pdf } = await renderFlyerFiles(data, photoBuf, photo.mimetype);

    const base = `ArenaCFO Profile - ${(data.name || 'cfo').replace(/\s+/g, '-')}`;
    await client.files.uploadV2({
      channel_id: event.channel,
      thread_ts: event.ts,
      initial_comment: `<@${event.user}> here's your Meet Your Arena CFO profile :white_check_mark:`,
      file_uploads: [
        { file: png, filename: `${base}.png` },
        { file: pdf, filename: `${base}.pdf` },
      ],
    });
  } catch (err) {
    console.error('Failed to build CFO profile:', err);
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
