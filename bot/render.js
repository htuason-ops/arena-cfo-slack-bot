// Renders the Arena "Meet Your CFO" flyer headlessly (Puppeteer) and
// returns { png, pdf } buffers, using the same template that a human
// would fill out in the browser (./template/flyer.html, right next to this
// file), driven by the window.__arenaSetProfile(data) hook exposed in that
// file.
//
// The template lives inside this bot/ folder (not a sibling directory) so
// the path is correct no matter how the repo is checked out or which
// directory a host treats as its "root" — no dependency on FLYER_URL being
// set correctly. FLYER_URL remains available as an override if you'd rather
// point at a hosted copy of the template instead.

const path = require('path');
const puppeteer = require('puppeteer');
const { jsPDF } = require('jspdf');

async function renderFlyerFiles(data, photoBuf, photoMimetype) {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1440, deviceScaleFactor: 2 });

    const defaultFlyerUrl = 'file://' + path.join(__dirname, 'template', 'flyer.html');
    const flyerUrl = process.env.FLYER_URL || defaultFlyerUrl;
    await page.goto(flyerUrl, { waitUntil: 'networkidle0' });

    const photoDataUrl = photoBuf
      ? `data:${photoMimetype || 'image/jpeg'};base64,${photoBuf.toString('base64')}`
      : null;

    await page.evaluate((d, photo) => {
      window.__arenaSetProfile({ ...d, photo });
    }, data, photoDataUrl);

    // let the headshot / fonts paint before capturing
    await new Promise((r) => setTimeout(r, 500));

    const el = await page.$('#flyer');
    if (!el) throw new Error('Could not find #flyer element in template — did the template markup change?');
    const png = await el.screenshot({ type: 'png' });

    // Wrap the same pixels in a single-page PDF sized to match (1080 wide;
    // height adapts if the flyer grew past 1440 due to long bullet lists).
    const box = await el.boundingBox();
    const w = Math.round((box && box.width) || 1080);
    const h = Math.round((box && box.height) || 1440);

    // NOTE: verify the jsPDF constructor options / addImage signature against
    // the current jsPDF docs for the version pinned in package.json — this
    // mirrors the pattern from the handoff spec (SLACK-AUTOMATION.md) but you
    // should confirm it against your installed version before relying on it.
    const doc = new jsPDF({ orientation: 'portrait', unit: 'px', format: [w, h] });
    doc.addImage(`data:image/png;base64,${png.toString('base64')}`, 'PNG', 0, 0, w, h);
    const pdf = Buffer.from(doc.output('arraybuffer'));

    return { png, pdf };
  } finally {
    await browser.close();
  }
}

module.exports = { renderFlyerFiles };
