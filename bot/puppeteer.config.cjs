// Fixes "Could not find Chrome" on Render (and similar hosts).
//
// By default Puppeteer downloads Chrome into ~/.cache/puppeteer during
// `npm install` (the build step). On Render, the build step's home directory
// isn't guaranteed to be the same location the app runs from at start time,
// so the downloaded browser "disappears" between build and runtime.
//
// Pointing the cache at a folder inside the project directory instead keeps
// it on the same persistent path for both build and runtime. Source: the
// official Puppeteer configuration guide (https://pptr.dev/guides/configuration,
// "Changing the default cache directory") and Render's community forum
// (https://community.render.com/t/puppeteer-fails-to-find-chromium-on-render/9920).
//
// IMPORTANT: this file must exist *before* `npm install` runs (i.e., be
// committed to the repo before your next Render deploy) — Puppeteer reads it
// during its postinstall download step.

const { join } = require('path');

/** @type {import('puppeteer').Configuration} */
module.exports = {
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
