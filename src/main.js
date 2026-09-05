const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, globalShortcut, nativeImage, Menu } = require('electron');
const { autoUpdater } = require('electron-updater');

const log = require('electron-log');
const path = require('path');
const fs = require('fs');
const { pathToFileURL, fileURLToPath } = require('url');
const version = require('../package.json').version;

// Clean zoom steps: 50% to 300% in 5% increments (stored as factors: 0.50, 0.55, ..., 3.00)
const ZOOM_STEPS = [];
for (let pct = 50; pct <= 300; pct += 5) {
  ZOOM_STEPS.push(Math.round(pct) / 100);
}

function getNextZoomStep(currentFactor, zoomIn) {
  if (zoomIn) {
    for (let i = 0; i < ZOOM_STEPS.length; i++) {
      if (ZOOM_STEPS[i] > currentFactor + 0.001) return ZOOM_STEPS[i];
    }
    return ZOOM_STEPS[ZOOM_STEPS.length - 1];
  } else {
    for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
      if (ZOOM_STEPS[i] < currentFactor - 0.001) return ZOOM_STEPS[i];
    }
    return ZOOM_STEPS[0];
  }
}

function snapToZoomStep(factor) {
  let closest = ZOOM_STEPS[0];
  let minDiff = Math.abs(factor - closest);
  for (let i = 1; i < ZOOM_STEPS.length; i++) {
    const diff = Math.abs(factor - ZOOM_STEPS[i]);
    if (diff < minDiff) { minDiff = diff; closest = ZOOM_STEPS[i]; }
  }
  return closest;
}

const NAV_PANEL_WIDTH = 250;
const NAV_PANEL_STRIP_WIDTH = 110;
let navPanelMode = 'expanded';
let navPanelDesiredMode = 'expanded';
let navPanelPrevMode = null;
let navPanelCollapsed = false;
let navPanelPrevX = null;
let chatPrevY     = null;
let chatAnimTimer = null;

log.transports.file.level = 'info';

// ── Auto-updater ──────────────────────────────────────────────────────────────
let updateAvailableVersion = null;
// True where updates cannot be delivered at all (unsigned macOS builds), so the
// Settings tab can say so instead of showing a check that never finds anything.
let updaterUnavailable = false;
let updateDownloaded       = false;
let updateDownloading      = false;
let updateReleaseNotes     = null;

autoUpdater.autoDownload         = false;
autoUpdater.autoInstallOnAppQuit = true;

function setupAutoUpdater() {
  // macOS refuses unsigned updates, so checking there only produces errors and
  // offers updates that cannot install. Skip it and report it as unavailable.
  if (process.platform === 'darwin') {
    log.info('Auto-updates are not available on macOS (unsigned build)');
    updaterUnavailable = true;
    return;
  }
  // Always check silently - even if disabled, so settings can show available version
  autoUpdater.on('update-available', (info) => {
    log.info('Update available:', info.version);
    updateAvailableVersion = info.version;
    updateReleaseNotes     = info.releaseNotes || null;

    if (appSettings.updaterEnabled === false) {
      log.info('Auto-updates disabled, not prompting.');
      return;
    }
    if (appSettings.skippedVersion === info.version) {
      log.info('Skipped version:', info.version);
      return;
    }

    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'info',
      buttons: ['Download in background', 'Skip this version', 'Remind me later'],
      defaultId: 0, cancelId: 2,
      title: 'Update Available - LostKit',
      message: `v${info.version} is available`,
      detail: `You're on v${version}.\n\nDownloads silently in the background. LostKit installs it automatically next time you close and reopen - no interruption now.`
    });

    if (choice === 0) {
      updateDownloading = true;
      autoUpdater.downloadUpdate();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-downloading', info.version);
      if (navView && !navView.webContents.isDestroyed()) navView.webContents.send('update-downloading', info.version);
    } else if (choice === 1) {
      appSettings.skippedVersion = info.version;
      saveSettingsDebounced();
    }
  });

  autoUpdater.on('update-not-available', () => {
    log.info('App is up to date. v' + version);
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('update-not-available');
  });

  autoUpdater.on('download-progress', (progress) => {
    const pct = Math.round(progress.percent);
    log.info('Download progress:', pct + '%');
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-progress', pct);
    if (navView && !navView.webContents.isDestroyed()) navView.webContents.send('update-progress', pct);
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info('Update downloaded, will install on quit:', info.version);
    updateDownloaded  = true;
    updateDownloading = false;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-ready', info.version);
    if (navView && !navView.webContents.isDestroyed()) navView.webContents.send('update-ready', info.version);
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('update-ready', info.version);
  });

  autoUpdater.on('error', (err) => {
    log.error('Auto-updater error:', err.message);
    updateDownloading = false;
  });

  setTimeout(() => {
    try { autoUpdater.checkForUpdates(); }
    catch (e) { log.error('checkForUpdates failed:', e.message); }
  }, 6000);
}

// ── Updater IPC ───────────────────────────────────────────────────────────────
ipcMain.on('updater-install-now', () => {
  if (updateDownloaded) autoUpdater.quitAndInstall(false, true);
});
ipcMain.handle('get-updater-settings', () => ({
  enabled:        appSettings.updaterEnabled !== false,
  skippedVersion: appSettings.skippedVersion || '',
  currentVersion: version,
  updateReady:    updateDownloaded,
  downloading:    updateDownloading,
  updateVersion:  updateAvailableVersion,
  releaseNotes:   updateReleaseNotes,
  unavailable:    updaterUnavailable
}));

ipcMain.on('open-whats-new', (event, requestedVersion) => {
  const targetVersion = (requestedVersion || updateAvailableVersion || version || '').toString().trim();
  const releaseTag = targetVersion.startsWith('v') ? targetVersion : `v${targetVersion}`;
  const releaseUrl = `https://github.com/LostHQ/LostKit-Electron/releases/tag/${encodeURIComponent(releaseTag)}`;
  shell.openExternal(releaseUrl).catch((err) => {
    log.error('Failed to open release page:', err);
  });
});
ipcMain.on('set-updater-enabled', (event, enabled) => {
  appSettings.updaterEnabled = !!enabled;
  saveSettingsDebounced();
});
ipcMain.on('updater-clear-skip', () => {
  appSettings.skippedVersion = '';
  saveSettingsDebounced();
});
ipcMain.on('updater-manual-download', () => {
  if (!updateDownloading && !updateDownloaded && updateAvailableVersion) {
    updateDownloading = true;
    autoUpdater.downloadUpdate();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-downloading', updateAvailableVersion);
    if (navView && !navView.webContents.isDestroyed()) navView.webContents.send('update-downloading', updateAvailableVersion);
  }
});

const settingsPath = path.join(process.env.APPDATA || process.env.HOME || '.', '.lostkit-settings.json');
let appSettings = {
  mainWindow: { width: 1100, height: 920, x: null, y: null },
  zoomFactor: 1, tabZoom: {}, externalZoom: {}, chatZoom: 1,
  chatHeight: 300, chatVisible: true,
  lastWorld: { url: 'https://w2-2004.lostcity.rs/rs2.cgi?plugin=0&world=2&lowmem=0', title: 'W2 HD' },
  soundManagerWindow: { width: 450, height: 500 }, notesWindow: { width: 500, height: 600 },
  screenshotFolder: '', screenshotKeybind: '',
  screenshotSoundEnabled: true, screenshotSoundVolume: 80, screenshotCustomSoundPath: '',
  creatorChannels: [],
  creatorNotifSettings: { notifLive: true, notifVideo: true, pollIntervalMs: 30000 },
  hiddenNavButtons: [],
  streamWindow: { width: 960, height: 600, x: null, y: null, pinned: false, chatOpen: false, videoHidden: false, prevWinWidth: 960 },
  updaterEnabled: true,
  skippedVersion: '',
  alwaysOnTop: false,
  // Tool tabs open at last quit, in strip order, restored on next launch.
  // activeTab is an index into openTabs, or 'main' for the game view tab.
  openTabs: [], activeTab: 'main',
  // Market watchlist: items being tracked, and whether matches raise a desktop
  // notification (the panel always shows them either way).
  marketWatches: [], marketNotifyEnabled: true, marketPollIntervalMs: 300000
};

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf8');
      const loaded = JSON.parse(data);
      appSettings = { ...appSettings, ...loaded };
      if (appSettings.zoomFactor) appSettings.zoomFactor = snapToZoomStep(appSettings.zoomFactor);
      if (appSettings.chatZoom) appSettings.chatZoom = snapToZoomStep(appSettings.chatZoom);
      if (appSettings.tabZoom) for (const url in appSettings.tabZoom) appSettings.tabZoom[url] = snapToZoomStep(appSettings.tabZoom[url]);
      if (appSettings.externalZoom) for (const url in appSettings.externalZoom) appSettings.externalZoom[url] = snapToZoomStep(appSettings.externalZoom[url]);
      log.info('Settings loaded from', settingsPath);
    }
  } catch (e) {
    log.error('Failed to load settings:', e);
    // Keep the unreadable file instead of silently overwriting it on the next
    // save - it's the only copy of everything the user configured.
    try {
      if (fs.existsSync(settingsPath)) {
        const backup = settingsPath + '.corrupt';
        fs.copyFileSync(settingsPath, backup);
        log.error('Unreadable settings file backed up to', backup);
      }
    } catch (e2) {}
  }
}

// Atomic write: writing straight over the settings file means a crash or power
// cut mid-write leaves a truncated file and resets every setting there is.
// Write alongside it, then rename - rename is atomic on NTFS and POSIX alike.
function saveSettings() {
  const json = JSON.stringify(appSettings, null, 2);
  const tmpPath = settingsPath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, json, 'utf8');
    fs.renameSync(tmpPath, settingsPath);
  } catch (e) {
    log.error('Atomic settings write failed, falling back to direct write:', e);
    try { fs.writeFileSync(settingsPath, json, 'utf8'); }
    catch (e2) { log.error('Failed to save settings:', e2); }
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e3) {}
  }
}

function saveSettingsDebounced() {
  if (saveSettingsDebounced.timer) clearTimeout(saveSettingsDebounced.timer);

  saveSettingsDebounced.timer = setTimeout(saveSettings, 500);
}

// Writes pending debounced changes right now. On quit the process dies with the
// 500ms timer still pending, so anything changed in the last half second -
// window bounds, the tab list, a zoom step - would be lost without this.
function flushSettings() {
  if (saveSettingsDebounced.timer) { clearTimeout(saveSettingsDebounced.timer); saveSettingsDebounced.timer = null; }
  saveSettings();
}

// ── Always-on-top ────────────────────────────────────────────────────────────
// Applies appSettings.alwaysOnTop to the main window and every window LostKit
// opens, EXCEPT creator stream/chat windows (tagged _isCreatorWindow), which
// own their pin state via the stream window's own "always on top" control.
function applyAlwaysOnTop(win) {
  if (!win || win.isDestroyed() || win._isCreatorWindow) return;
  try { win.setAlwaysOnTop(!!appSettings.alwaysOnTop); } catch (e) {}
}
function applyAlwaysOnTopAll() {
  for (const win of BrowserWindow.getAllWindows()) applyAlwaysOnTop(win);
}

// ── Creators background polling ──────────────────────────────────────────────
let creatorPollTimer = null;
let currentNavViewName = 'nav';

async function bgCheckChannelLive(channelId) {
  try {
    const res = await fetch(`https://www.youtube.com/channel/${channelId}/live`, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept-Language': 'en-US,en;q=0.9' }
    });
    const html = await res.text();

    // Signal 1: final URL after redirect contains watch?v=
    const finalUrlMatch = res.url.match(/[?&]v=([\w-]{11})/);
    if (finalUrlMatch) return { isLive: true, liveVideoId: finalUrlMatch[1] };

    // Signal 2: canonical URL in page HTML
    const canonMatch = html.match(/<link rel="canonical" href="[^"]*[?&]v=([\w-]{11})"/);
    if (canonMatch) return { isLive: true, liveVideoId: canonMatch[1] };

    // Signal 3: og:url in page HTML
    const ogMatch = html.match(/<meta property="og:url" content="[^"]*[?&]v=([\w-]{11})"/);
    if (ogMatch) return { isLive: true, liveVideoId: ogMatch[1] };

    // Signal 4: isLiveNow:true in page JSON
    if (/"isLiveNow"\s*:\s*true/.test(html)) {
      const vm = html.match(/"videoId"\s*:\s*"([\w-]{11})"/);
      if (vm) return { isLive: true, liveVideoId: vm[1] };
    }

    // Signal 5: hlsManifestUrl present = active HLS stream
    if (/"hlsManifestUrl"\s*:\s*"/.test(html)) {
      const vm = html.match(/"videoId"\s*:\s*"([\w-]{11})"/);
      if (vm) return { isLive: true, liveVideoId: vm[1] };
    }

    // Signal 6: legacy isLive:true pattern
    const legacy = html.match(/"videoId":"([\w-]{11})"[^}]*"isLive"\s*:\s*true/) ||
                   html.match(/"isLive"\s*:\s*true[^}]*"videoId":"([\w-]{11})"/);
    if (legacy) return { isLive: true, liveVideoId: legacy[1] };

    return { isLive: false, liveVideoId: null };
  } catch { return { isLive: false, liveVideoId: null }; }
}

async function bgFetchRSS(channelId) {
  try {
    const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (!res.ok) return null;
    const xml = await res.text();
    const entries = [];
    const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
    let m;
    while ((m = entryRe.exec(xml)) !== null) {
      const e = m[1];
      const videoId = (e.match(/<yt:videoId>(.*?)<\/yt:videoId>/) || [])[1];
      const title   = (e.match(/<title>(.*?)<\/title>/)            || [])[1];
      const pub     = (e.match(/<published>(.*?)<\/published>/)     || [])[1];
      const upd     = (e.match(/<updated>(.*?)<\/updated>/)         || [])[1];
      const thumb   = (e.match(/url="(https:\/\/i\.ytimg[^"]+)"/) || [])[1] || null;
      if (videoId) entries.push({ videoId, title: title||'', published: pub, updated: upd, thumbnail: thumb });
    }
    const nm = xml.match(/<author>\s*<name>(.*?)<\/name>/);
    return { channelName: nm ? nm[1] : 'Unknown', entries };
  } catch { return null; }
}

function fireCreatorNotif(title, body, videoId) {
  const { Notification } = require('electron');
  if (!Notification.isSupported()) return;
  const notif = new Notification({ title, body: body || '', silent: false });
  notif.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
    if (videoId) {
      const sw = new BrowserWindow({
        width: 960, height: 600, minWidth: 480, minHeight: 360,
        title: title || 'Stream', backgroundColor: '#000000',
        webPreferences: { nodeIntegration: true, contextIsolation: false, webviewTag: true },
        autoHideMenuBar: true, frame: false,
      });
      sw._isCreatorWindow = true; // self-manages its own pin/always-on-top
      sw.loadFile(path.join(__dirname, 'youtube-stream.html'), {
        query: { v: videoId, title: encodeURIComponent(title||''), mode: 'stream', live: '1' }
      });
      sw.on('close', () => sw.destroy());
    }
  });
  notif.show();
}

async function pollCreatorsBackground() {
  const channels = appSettings.creatorChannels;
  if (!channels || !channels.length) return;
  const ns = appSettings.creatorNotifSettings || {};
  for (const ch of channels) {
    try {
      const [liveR, rssR] = await Promise.allSettled([
        bgCheckChannelLive(ch.channelId), bgFetchRSS(ch.channelId)
      ]);
      const wasLive = ch.isLive;
      const prevTopId = ch.entries?.[0]?.videoId;
      if (liveR.status === 'fulfilled') {
        const detected = liveR.value.isLive;
        if (detected) {
          // Confirmed live - reset strikes, update state immediately
          ch.isLive = true;
          ch.liveVideoId = liveR.value.liveVideoId;
          ch.offlineStrikes = 0;
        } else if (wasLive) {
          // Was live, now check returned offline - require 3 consecutive misses
          // before actually flipping to offline (guards against flaky /live URL checks
          // on very long streams like 24/7 channels e.g. Lo-fi Girl)
          ch.offlineStrikes = (ch.offlineStrikes || 0) + 1;
          if (ch.offlineStrikes >= 3) {
            ch.isLive = false;
            ch.liveVideoId = null;
          }
          // else: keep ch.isLive=true and ch.liveVideoId intact for this cycle
        } else {
          ch.isLive = false;
          ch.liveVideoId = liveR.value.liveVideoId;
          ch.offlineStrikes = 0;
        }
      }
      if (rssR.status === 'fulfilled' && rssR.value) {
        const rss = rssR.value;
        ch.name = rss.channelName || ch.name;
        ch.entries = rss.entries;
        if (ch.isLive && ch.liveVideoId) {
          const le = rss.entries.find(e => e.videoId === ch.liveVideoId);
          ch.liveTitle = le?.title || ch.liveTitle || null;
          ch.liveThumbnail = le?.thumbnail || ch.liveThumbnail || null;
        }
      }
      if (!wasLive && ch.isLive && ch.liveVideoId &&
          ch.liveVideoId !== ch.lastNotifiedLiveId && ns.notifLive !== false) {
        ch.lastNotifiedLiveId = ch.liveVideoId;
        fireCreatorNotif(`🔴 ${ch.name} is LIVE!`, ch.liveTitle||'', ch.liveVideoId);
      }
      const newTopId = ch.entries?.[0]?.videoId;
      // Exclude video IDs that were already notified as a live stream (stream VOD / live start entry)
      const alreadyNotifiedAsLive = newTopId && newTopId === ch.lastNotifiedLiveId;
      if (!ch.isLive && newTopId && newTopId !== prevTopId &&
          prevTopId && !alreadyNotifiedAsLive &&
          newTopId !== ch.lastNotifiedVideoId && ns.notifVideo !== false) {
        ch.lastNotifiedVideoId = newTopId;
        fireCreatorNotif(`📹 New video: ${ch.name}`, ch.entries[0].title||'', newTopId);
      }
      ch.lastChecked = Date.now();
    } catch(e) { log.warn('Creator bg poll:', ch.channelId, e.message); }
  }
  saveSettingsDebounced();
  if (currentNavViewName === 'youtube' && navView && !navView.webContents.isDestroyed())
    navView.webContents.send('creator-channels-updated', appSettings.creatorChannels);
}

// ── Market watchlist ─────────────────────────────────────────────────────────
// Watches player listings on markets.lostcity.rs and notifies when one lands in
// the price range you asked for. Polling lives here rather than in the panel so
// alerts still fire while the panel is closed - same shape as creator polling.
//
// markets.lostcity.rs is an Inertia app: the same URLs return JSON when asked
// with the X-Inertia headers, and fall back to HTML with the payload embedded in
// data-page. The version hash changes whenever the site deploys, so we cache it
// and re-read it from the HTML whenever a request comes back stale.
const MARKET_ORIGIN = 'https://markets.lostcity.rs';
const MARKET_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) LostKit';
let marketInertiaVersion = null;
let marketPollTimer = null;
let watchlistWindow = null;
let compareWindow = null;
let priceHistoryWindow = null;

function decodeHtmlEntities(s) {
  return s.replace(/&quot;/g, '"').replace(/&#039;/g, "'")
          .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

async function marketFetchPage(path) {
  const url = MARKET_ORIGIN + path;
  if (marketInertiaVersion) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': MARKET_UA, 'X-Inertia': 'true',
                   'X-Inertia-Version': marketInertiaVersion, 'Accept': 'text/html, application/xhtml+xml' }
      });
      if (res.ok && (res.headers.get('content-type') || '').includes('json')) return await res.json();
    } catch (e) { /* fall through to the HTML route */ }
  }
  // HTML route: works regardless of the version hash, and refreshes our copy.
  // Note that either route costs the site one request and nothing else - we read
  // the embedded data and never fetch the stylesheets, scripts or images a real
  // page view would. See the note above startMarketPolling for what that adds up
  // to across a user base.
  const res = await fetch(url, { headers: { 'User-Agent': MARKET_UA } });
  if (!res.ok) throw new Error(`market request failed: ${res.status}`);
  const html = await res.text();
  const m = html.match(/data-page="([^"]*)"/);
  if (!m) throw new Error('market payload not found');
  const page = JSON.parse(decodeHtmlEntities(m[1]));
  if (page.version) marketInertiaVersion = page.version;
  return page;
}

// A listing pays in a bundle of items, not a number. Coins are the only thing
// that reduces to a comparable price; barter offers are surfaced in the panel
// but never threshold-matched, because "4600 cosmic runes" isn't a gp value.
// Per-unit price of a lot. Bulk offers - "30,000 coins for the lot of 100,000
// flax" - work out below 1gp each, and rounding those to a whole number turned
// a real price into 0, which then plotted as a crash to the floor. Small values
// keep their fraction; a genuine zero is no price at all.
function perUnitPrice(coinTotal, perEach, lotQty) {
  const qty = Math.max(1, lotQty || 1);
  // "For each item:" is already per-unit; "For:" is the price of the whole lot.
  const raw = perEach ? coinTotal : coinTotal / qty;
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return raw < 10 ? Math.round(raw * 1000) / 1000 : Math.round(raw);
}

function listingUnitPrice(listing) {
  const offer = listing.offers && listing.offers[0];
  if (!offer || !Array.isArray(offer.items) || offer.items.length !== 1) return null;
  const paid = offer.items[0];
  if (!paid.item || paid.item.slug !== 'coins') return null;
  return perUnitPrice(paid.quantity, /each/i.test(offer.title || ''), listing.quantity);
}

function describeOffer(listing) {
  const offer = listing.offers && listing.offers[0];
  if (!offer || !Array.isArray(offer.items) || !offer.items.length) return 'no offer';
  return offer.items.map(i => `${i.quantity.toLocaleString()} ${i.item ? i.item.name : '?'}`).join(' + ');
}

function isListingLive(l) {
  return !l.soldAt && !l.deletedAt && !l.pausedAt;
}

// ── Placeholder prices ──────────────────────────────────────────────────────
// Some listings put a token number in the coin field and the real one in the
// notes: a santa hat wanted for "169 Coins", notes "169m offer pm for list".
// Taken at face value one of those drags an average through the floor, and to a
// watch it looks like the deal of the century. So anything wildly out of step
// with the going rate is checked against its notes before it is believed, and
// if the notes do not explain it, it is kept out of the numbers entirely.

const OUTLIER_FACTOR = 20;      // 20x off the going rate is not a real price

// Amounts written the way players write them: 169m, 1.5b, 250k, "169 mil".
function noteAmounts(notes) {
  const out = [];
  if (!notes) return out;
  // 13,000 -> 13000, so a thousands separator is not read as a decimal point.
  const text = String(notes).replace(/(\d),(?=\d{3}\b)/g, '$1');
  const re = /(\d+(?:\.\d+)?)\s*(bil(?:lion)?|mil(?:lion)?|b|m|k)?\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const mantissa = parseFloat(m[1]);
    if (!Number.isFinite(mantissa) || mantissa <= 0) continue;
    const unit = (m[2] || '').toLowerCase().charAt(0);
    const mult = unit === 'b' ? 1e9 : unit === 'm' ? 1e6 : unit === 'k' ? 1e3 : 1;
    out.push({ value: Math.round(mantissa * mult), mantissa, scaled: !!unit });
  }
  return out;
}

// The going rate to judge listings against. A median needs a real sample to
// mean anything, so below three prices we take whatever context the caller can
// give us - and with none, we decline to judge rather than guess.
function referencePrice(prices, ...fallbacks) {
  const clean = prices.filter(p => p != null && p > 0);
  if (clean.length >= 3) {
    const sorted = [...clean].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }
  for (const f of fallbacks) if (f != null && f > 0) return f;
  return null;
}

// Judges one price. Returns what to use and how it was arrived at:
//   ok      - believed as listed
//   notes   - the coin field was a placeholder; the real number came from notes
//   suspect - far off the market and the notes do not explain it, so it must be
//             kept out of averages and must never trigger an alert
function screenPrice(price, notes, reference) {
  if (price == null) return { price: null, source: 'ok' };
  if (reference == null || reference <= 0) return { price, source: 'ok' };
  const plausible = (v) => v != null && v >= reference / OUTLIER_FACTOR && v <= reference * OUTLIER_FACTOR;
  if (plausible(price)) return { price, source: 'ok' };

  const amounts = noteAmounts(notes);
  // Strongest tell by far: the notes repeat the listed digits with the
  // magnitude that was left off - "169 Coins" alongside "169m offer".
  const sameDigits = amounts.find(a =>
    a.scaled && Math.round(a.mantissa) === Math.round(price) && plausible(a.value));
  if (sameDigits) return { price: sameDigits.value, source: 'notes' };
  // Otherwise believe the notes only if exactly one number in them lands in the
  // right neighbourhood. Anything vaguer is a guess, and a wrong guess here is
  // worse than admitting we don't know.
  const fits = amounts.filter(a => a.scaled && plausible(a.value));
  if (fits.length === 1) return { price: fits[0].value, source: 'notes' };
  return { price, source: 'suspect' };
}

// A watch on "buy" means the user wants to buy, so it scans other people's
// SELL listings - and vice versa. Getting this backwards is the easiest way to
// make the whole feature useless, so it is stated once, here.
function listingTypeWatched(direction) { return direction === 'buy' ? 'sell' : 'buy'; }

function priceInRange(price, watch) {
  if (price == null) return false;
  if (watch.min != null && price < watch.min) return false;
  if (watch.max != null && price > watch.max) return false;
  return true;
}

// How far outside the range a listing may sit and still be worth showing. Set a
// max of 10m on a dragon chainbody and you do not want to read about the 40m
// ones - but you probably do want to see the 11m one.
function priceWithinDeviation(price, watch) {
  if (price == null) return false;
  const dev = Number.isFinite(watch.deviation) ? watch.deviation : 20;
  // With no bounds at all there is nothing to deviate from - show everything.
  if (watch.min == null && watch.max == null) return true;
  const factor = 1 + Math.max(0, dev) / 100;
  if (watch.max != null && price > watch.max * factor) return false;
  if (watch.min != null && price < watch.min / factor) return false;
  return true;
}

async function refreshMarketWatch(watch) {
  // An item page returns one side of the book at a time and defaults to buy
  // listings, so the side we want has to be asked for explicitly.
  const wanted = listingTypeWatched(watch.direction);
  const page = await marketFetchPage(`/items/${encodeURIComponent(watch.slug)}?type=${wanted}`);
  const all = (page.props && page.props.listings && page.props.listings.data) || [];
  const rows = all
    .filter(l => l.type === wanted && isListingLive(l))
    .map(l => ({
      id: l.id,
      username: l.username,
      quantity: l.quantity,
      price: listingUnitPrice(l),
      offer: describeOffer(l),
      notes: l.notes || '',
      updatedAt: l.updatedAt
    }));

  // Placeholder prices are screened before anything is sorted, matched or
  // alerted on - an unscreened "169 Coins" on a santa hat is both the cheapest
  // listing on the page and a notification saying you just found one for 169gp.
  // With too few listings to form a median, the range the user asked for is the
  // best statement of what they think the item is worth.
  const midpoint = watch.min != null && watch.max != null ? (watch.min + watch.max) / 2 : null;
  const reference = referencePrice(rows.map(r => r.price), midpoint, watch.max, watch.min);
  rows.forEach(r => {
    const screened = screenPrice(r.price, r.notes, reference);
    r.suspect = screened.source === 'suspect';
    r.priceFromNotes = screened.source === 'notes';
    r.price = screened.price;
  });

  // Best first: cheapest when buying, highest paying when selling.
  const priced = rows.filter(r => r.price != null && !r.suspect);
  priced.sort((a, b) => watch.direction === 'buy' ? a.price - b.price : b.price - a.price);

  // Only listings near the asked-for price are shown; the rest are counted so
  // you can still tell the difference between "nothing close" and "nothing".
  const near = priced.filter(r => priceWithinDeviation(r.price, watch));
  watch.listings = near.slice(0, 8);
  watch.farCount = priced.length - near.length;
  watch.suspectCount = rows.filter(r => r.suspect).length;
  watch.barterCount = rows.length - priced.length - watch.suspectCount;
  watch.best = priced.length ? priced[0].price : null;
  watch.matches = priced.filter(r => priceInRange(r.price, watch));
  watch.lastChecked = Date.now();
  watch.error = null;
  return watch;
}

async function pollMarketWatches({ notify = true } = {}) {
  const watches = appSettings.marketWatches;
  if (!watches || !watches.length) return;
  for (const watch of watches) {
    try {
      const before = new Set(watch.notifiedListingIds || []);
      await refreshMarketWatch(watch);
      if (notify && appSettings.marketNotifyEnabled !== false) {
        const fresh = watch.matches.filter(m => !before.has(m.id));
        if (fresh.length) {
          const best = fresh[0];
          const verb = watch.direction === 'buy' ? 'selling' : 'buying';
          fireMarketNotif(
            `${watch.name} - ${best.price.toLocaleString()} gp`,
            `${best.username} is ${verb} ${best.quantity.toLocaleString()}${fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''}`,
            watch.slug
          );
        }
      }
      // Only remember ids that still match, so a listing that leaves the range
      // and comes back later alerts again.
      watch.notifiedListingIds = watch.matches.map(m => m.id);
    } catch (e) {
      watch.error = e.message;
      log.warn('Market watch failed:', watch.slug, e.message);
    }
  }
  saveSettingsDebounced();
  broadcastMarketWatches();
}

// The panel can be open in the nav column, in its own window, or both.
function broadcastMarketWatches() {
  if (currentNavViewName === 'watchlist' && navView && !navView.webContents.isDestroyed())
    navView.webContents.send('market-watches-updated', appSettings.marketWatches);
  if (watchlistWindow && !watchlistWindow.isDestroyed())
    watchlistWindow.webContents.send('market-watches-updated', appSettings.marketWatches);
}

function fireMarketNotif(title, body, slug) {
  const { Notification } = require('electron');
  if (!Notification.isSupported()) return;
  const notif = new Notification({ title, body: body || '', silent: false });
  notif.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
    // Open the item's market page as a tab so the offer is one click away.
    ipcMain.emit('add-tab', null, `${MARKET_ORIGIN}/items/${slug}`, 'Markets', 'assets/market.png');
  });
  notif.show();
}

// How much load does watching actually put on markets.lostcity.rs? Worth having
// the arithmetic written down, because the answer is reassuring and the question
// keeps coming back:
//
//   one watch = one request every 5 minutes
//   30 users x 5 watches = 150 requests / 300s = 0.5 requests per second
//
// And each of those is cheaper than a person opening the same page in a browser.
// marketFetchPage pulls the Inertia payload only - no CSS, no scripts, none of
// the twenty-odd assets a real page view drags along. So the whole background
// load of a modest user base costs their server about what a couple of people
// casually clicking around the site would.
//
// Which is to say: 5 minutes is not a number to be nervous about. It is worth
// keeping only so that a user with a lot of watches stays unremarkable in their
// logs.
function startMarketPolling() {
  if (marketPollTimer) clearInterval(marketPollTimer);
  const interval = appSettings.marketPollIntervalMs || 300000;
  marketPollTimer = setInterval(() => pollMarketWatches(), interval);
}

function startCreatorPolling() {
  if (creatorPollTimer) clearInterval(creatorPollTimer);
  const interval = (appSettings.creatorNotifSettings?.pollIntervalMs) || 300000;
  creatorPollTimer = setInterval(pollCreatorsBackground, interval);
}

// ── Font injection ────────────────────────────────────────────────────────────
// RS-Bold is the interface font throughout - the old Quill option was dropped
// for being hard to read. This still runs because it also carries the size
// bumps, and because it has to out-specify the stopwatch panel, which forces
// font-family: RS-Plain !important on its own elements.
const FONT_STYLE_ID = '__lk-font-override__';

function buildFontCSS() {
  return [
    // Deliberately blunt, and it overrides the stylesheets. The panels opt small
    // print back out with their own !important rules on --font-small - see the
    // small-print block at the top of watchlist.css.
    "body, body * { font-family: 'RS-Bold', sans-serif !important; }",
    ".stopwatch-panel, .stopwatch-panel .mode-indicator, .stopwatch-panel .section-title,",
    ".stopwatch-panel .setting-row, .stopwatch-panel .setting-row label,",
    ".stopwatch-panel .range-value, .stopwatch-panel .big-btn, .stopwatch-panel .btn,",
    ".stopwatch-panel .sound-checkbox-label, .stopwatch-panel .mode-btn {",
    "  font-family: 'RS-Bold', sans-serif !important; }",
    // General size bumps (+2px over CSS defaults)
    "button, .btn, .nav-button, .world-item, .world-title, .lookup-btn, .loading, .stat-row { font-size: 16px !important; }",
    ".tab, .tab-btn, .nav-buttons-top span { font-size: 15px !important; }",
    ".world-info strong, .world-players, .world-latency, .setting-row label, .range-value, .status-text, .section-label { font-size: 14px !important; }",
    ".stat-values, .stat-level, .stat-xp, .stat-rank, .error-message { font-size: 13px !important; }",
    // Stopwatch mode-btn: pin to a small explicit size so the generic
    // "button { font-size !important }" rule never blows it up. Higher
    // specificity (.stopwatch-panel .mode-btn) so it wins.
    // text-align: center keeps Bold glyphs (wider than Plain) inside the button.
    ".stopwatch-panel .mode-btn { text-align: center !important; }",
    ".stopwatch-panel .mode-indicator { text-align: center !important; }",
    ".stopwatch-panel .section-title { font-size: 15px !important; }",
    ".stopwatch-panel .sound-checkbox-label, .stopwatch-panel .setting-row label { font-size: 13px !important; }",
  ].join("\n");
}

function injectFontCSS(wc, css) {
  if (!wc || wc.isDestroyed()) return;
  const escaped = css.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
  wc.executeJavaScript(`
    (function() {
      var existing = document.getElementById('${FONT_STYLE_ID}');
      if (existing) existing.remove();
      if (${JSON.stringify(css)} !== '') {
        var s = document.createElement('style');
        s.id = '${FONT_STYLE_ID}';
        s.textContent = \`${escaped}\`;
        document.head.appendChild(s);
      }

    })();
  `).catch(() => {});
}

// isNavitem is kept in the signature because every caller passes it; navitem
// windows load main.css via ../ so the rules are identical either way.
function applyFontToView(wc, isNavitem) {
  injectFontCSS(wc, buildFontCSS());
}

if (require('electron-squirrel-startup')) app.quit();

let mainWindow;
let settingsWindow = null;
let addToolWindow = null;
let afkGameClick = false;
let afkInputType = 'click'; // game click/keypress - hover mode removed
let afkHover = false;
let hoverPaused = false;
let soundAlert = false;
let soundVolume = 60;
let customSoundPath = '';
let defaultPackagedSoundPath = '';

// Game-click AFK timer (legacy - kept for stopwatch panel IPC compatibility)
let gameClickTimerRunning = false;
let gameClickTimerInterval = null;
let gameClickTimerSeconds = 0;
// Wall-clock start of the current count. Counting interval ticks instead lost
// time whenever the main process was busy, since a late tick still counts one.
// Matches how the background timer already works.
let gameClickTimerStartTime = 0;
let gameClickAlertTriggeredInCycle = false;
let alertThreshold = 10;

// Unified background timer - drives the stopwatch panel display AND the titlebar
let backgroundTimerInterval = null;
let backgroundTimerSeconds = 0;
let backgroundTimerMode = 'afk';
let backgroundTimerRunning = false;
let backgroundCountdownTime = 90;
let backgroundAlertTriggered = false;
let backgroundAutoLoop = false;
let backgroundTimerStartTime = null;

const baseWindowTitle = `LostKit 2 v${version} - by LostHQ Team`;

// ── World status (latency in titlebar) ──────────────────────────────────────
let worldStatusInterval = null;
let lastKnownLatency = null;

function measureLatency(url) {
  return new Promise((resolve) => {
    try {
      const { hostname } = new URL(url);
      const start = Date.now();
      const socket = require('net').createConnection(443, hostname);
      socket.setTimeout(3000);
      socket.on('connect', () => { resolve(Date.now() - start); socket.destroy(); });
      socket.on('error', () => resolve(null));
      socket.on('timeout', () => { socket.destroy(); resolve(null); });
    } catch (e) { resolve(null); }
  });
}

function getCurrentWorldTitle() {
  const mainTab = tabs.find(t => t.id === 'main');
  return mainTab ? mainTab.title : (appSettings.lastWorld && appSettings.lastWorld.title) || 'World';
}

async function refreshLatency() {
  const mainTab = tabs.find(t => t.id === 'main');
  const url = mainTab ? mainTab.url : (appSettings.lastWorld && appSettings.lastWorld.url);
  if (url) lastKnownLatency = await measureLatency(url);
  // Pick the correct running timer so latency ping never wipes an active timer
  if (backgroundTimerRunning) {
    updateWindowTitleWithTimer(true, backgroundTimerSeconds, backgroundTimerMode, backgroundCountdownTime);
  } else if (gameClickTimerRunning) {
    updateWindowTitleWithTimer(true, gameClickTimerSeconds, 'afk', 90);
  } else {
    updateWindowTitleWithTimer(false, 0, backgroundTimerMode, backgroundCountdownTime);
  }
}

function startWorldStatusInterval() {
  if (worldStatusInterval) return;
  worldStatusInterval = setInterval(refreshLatency, 2000);
  refreshLatency();
}

function formatWindowTitleTime(totalSeconds) {
  const mins = Math.floor(Math.abs(totalSeconds) / 60);
  const secs = Math.abs(totalSeconds) % 60;
  const sign = totalSeconds < 0 ? '-' : '';
  return `${sign}${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function updateWindowTitleWithTimer(running, seconds, mode, countdownTime) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const worldTitle = getCurrentWorldTitle();
  const latencyStr = lastKnownLatency != null ? `${lastKnownLatency}ms` : '-ms';
  let title = `${baseWindowTitle}  |  ${worldTitle}  |  ${latencyStr}`;
  if (running) {
    let modeLabel, displayValue;
    if (mode === 'afk') {
      modeLabel = 'AFK';
      displayValue = formatWindowTitleTime(90 - seconds);
    } else if (mode === 'countdown') {
      modeLabel = 'CNT';
      displayValue = formatWindowTitleTime(countdownTime - seconds);
    } else if (mode === 'stopwatch') {
      modeLabel = 'TMR';
      displayValue = formatWindowTitleTime(seconds);
    }
    title += `  |  ${modeLabel}: ${displayValue}`;
  }
  mainWindow.setTitle(title);
}

let primaryViews = [];
let navView, chatView;
let soundManagerWindow = null, notesWindow = null;

const defaultWorldUrl = 'https://w2-2004.lostcity.rs/rs2.cgi?plugin=0&world=2&lowmem=0';
const defaultWorldTitle = 'W2 HD';
// Icon shown on the unclosable game view tab (the world switcher nav button uses
// assets/worldswitch.png - a different icon).
const MAIN_TAB_ICON = 'assets/LostCity.png';
let tabs = [{ id: 'main', url: defaultWorldUrl, title: defaultWorldTitle, icon: MAIN_TAB_ICON }];
let tabByUrl = new Map([[defaultWorldUrl, 'main']]);
// url -> Set<BrowserWindow>: several external windows may share the same URL.
// Per-URL bounds/zoom are written by whichever window of that URL closes last.
let externalWindowsByUrl = new Map();
// Toolbar webContents id → a lookup for the page that toolbar drives, so a
// button press acts on its own page and no other tab's or window's.
const toolbarTargets = new Map();
const TOOLBAR_HEIGHT = 34;
let currentTab = 'main';
// ── Split view ── (all parts of this feature carry this heading)
// Shows one tab beside another. Off until asked for.
let splitTabId = null;          // the tab shown beside the active one, or null
let splitGrewWindowBy = 0;      // px of window width borrowed to fit the split
let splitLocked = false;        // frozen pair: clicking a third tab leaves the
let splitLockedPair = null;     // split intact instead of pulling that tab in
let splitOtherId = null;        // the tab holding the side that follows your
                                // clicks, remembered so that clicking the other
                                // pane keeps both on screen instead of collapsing
const SPLIT_MIN_PANE = 480;     // what a split needs to be worth starting
const SPLIT_DRAG_MIN = 220;     // but once split, the border can be dragged this
                                // far - the player decides how to trade the space,
                                // including squeezing the game if that suits them
const SPLIT_DIVIDER = 6;        // the seam, left unpainted by both views so the
                                // window's own page shows through and can be grabbed
let chatVisible = true;
let chatHeightValue = 300;

// ── Tool icons ───────────────────────────────────────────────────────────────
// Nav buttons pass an icon path relative to src/ (e.g. "assets/forums.png").
// The same icon identifies a tool everywhere it can appear: in front of the tab
// title, and as the window icon of a detached / external window.
function resolveAssetIcon(iconPath) {
  if (!iconPath || typeof iconPath !== 'string') return null;
  // Custom tool icons live in the user data dir and travel as file:// urls.
  if (iconPath.startsWith('file://')) return resolveCustomIcon(iconPath);
  const rel = iconPath.replace(/^[\\/]+/, '');
  const full = path.normalize(path.join(__dirname, rel));
  const assetsRoot = path.normalize(path.join(__dirname, 'assets'));
  if (!full.startsWith(assetsRoot)) return null;      // keep lookups inside src/assets
  try { return fs.existsSync(full) ? full : null; } catch (e) { return null; }
}

// Electron's default menu carries Reload, Force Reload and back/forward
// accelerators, which fire against whatever has focus. Replace it with a menu
// that has no navigation roles. Dev tools stay.
function installAppMenu() {
  const template = [];

  // macOS keeps Quit, Hide and About in the app menu; without one there is no
  // Cmd+Q. Neither this nor the window menu navigates anything.
  if (process.platform === 'darwin') template.push({ role: 'appMenu' });

  Menu.setApplicationMenu(Menu.buildFromTemplate(template.concat([
    {
      // Editing roles only - they keep clipboard shortcuts working in the notes
      // and settings windows. Nothing here navigates anything.
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ].concat(process.platform === 'darwin' ? [{ role: 'windowMenu' }] : []))));
}

function applyWindowIcon(win, iconPath) {
  const full = resolveAssetIcon(iconPath);
  if (!full || !win || win.isDestroyed()) return;
  try {
    const img = nativeImage.createFromPath(full);
    if (!img.isEmpty()) win.setIcon(img);
  } catch (e) { log.warn('Failed to set window icon:', e.message); }
}

// ── Custom tools ─────────────────────────────────────────────────────────────
// User-added pages. Both halves live in the user data dir, not in src/, which
// an update replaces:
//   list  -> .lostkit-settings.json
//   icons -> %APPDATA%/LostKit/toolicons
// A custom tool is a url/title/icon triple, the same shape as a built-in nav
// button, so tabs, windows, tear-off and docking need no special cases.
const customIconsDir = path.join(
  process.env.APPDATA || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.config'),
  'LostKit', 'toolicons'
);
const CUSTOM_TOOL_FALLBACK_ICON = 'assets/utilities.png';

function ensureCustomIconsDir() {
  try { fs.mkdirSync(customIconsDir, { recursive: true }); return true; }
  catch (e) { log.warn('Could not create tool icons dir:', e.message); return false; }
}

// Custom icons are addressed as file:// URLs so the nav panel and tab strip can
// use them as an <img src> directly, the same way they use "assets/…" paths.
function customIconUrl(filename) {
  try { return pathToFileURL(path.join(customIconsDir, filename)).href; } catch (e) { return null; }
}

function resolveCustomIcon(fileUrl) {
  try {
    const full = path.normalize(fileURLToPath(fileUrl));
    // Trailing separator so a sibling dir (…/toolicons-other) cannot pass as inside.
    const root = path.normalize(customIconsDir) + path.sep;
    if (!full.startsWith(root)) return null;
    return fs.existsSync(full) ? full : null;
  } catch (e) { return null; }
}

// A url the user typed: "mytool.example" and "localhost:8080" should both work.
function normalizeToolUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw;
  try {
    const u = new URL(withScheme);
    if (!/^https?:$/i.test(u.protocol)) return null;   // only pages, no file:// or app: schemes
    if (!u.hostname) return null;
    return u.href;
  } catch (e) { return null; }
}

// Loads the page off-screen to read its title and favicon, then discards the
// window. Always resolves by timeoutMs so a slow site cannot hang the add.
function fetchSiteMeta(url, timeoutMs = 12000) {
  return new Promise(resolve => {
    const result = { title: null, iconUrl: null };
    let win = null, settled = false, graceTimer = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline); clearTimeout(graceTimer);
      try { if (win && !win.isDestroyed()) win.destroy(); } catch (e) {}
      resolve(result);
    };
    const deadline = setTimeout(finish, timeoutMs);

    try {
      win = new BrowserWindow({
        show: false, width: 1024, height: 768,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
      });
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('page-title-updated', (e, title) => { if (title) result.title = title; });
      win.webContents.on('page-favicon-updated', (e, icons) => {
        if (Array.isArray(icons) && icons.length) result.iconUrl = icons[icons.length - 1];
      });
      win.webContents.on('did-finish-load', () => {
        if (!result.title) { try { result.title = win.webContents.getTitle() || null; } catch (e) {} }
        // The favicon event usually lands just after the load finishes.
        graceTimer = setTimeout(finish, result.iconUrl ? 300 : 2500);
      });
      win.webContents.on('did-fail-load', (e, code, desc, failedUrl, isMainFrame) => {
        if (isMainFrame) { log.warn('Tool page failed to load:', desc); finish(); }
      });
      win.loadURL(url);
    } catch (e) {
      log.warn('Could not inspect tool page:', e.message);
      finish();
    }
  });
}

const ICON_EXT_BY_TYPE = {
  'image/png': '.png', 'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico',
  'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/svg+xml': '.svg', 'image/webp': '.webp'
};
const MAX_ICON_BYTES = 2 * 1024 * 1024;

// Writes the site's icon into the icons dir and returns its filename, or null.
async function downloadToolIcon(iconUrl, toolId) {
  if (!iconUrl || !ensureCustomIconsDir()) return null;
  try {
    let buf, ext = '';

    if (/^data:/i.test(iconUrl)) {
      const m = /^data:([^;,]+)?(;base64)?,(.*)$/is.exec(iconUrl);
      if (!m) return null;
      buf = Buffer.from(m[2] ? m[3] : decodeURIComponent(m[3]), m[2] ? 'base64' : 'utf8');
      ext = ICON_EXT_BY_TYPE[(m[1] || '').toLowerCase()] || '.png';
    } else {
      const res = await fetch(iconUrl, { redirect: 'follow' });
      if (!res.ok) return null;
      buf = Buffer.from(await res.arrayBuffer());
      ext = ICON_EXT_BY_TYPE[(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()] || '';
    }

    if (!buf || !buf.length || buf.length > MAX_ICON_BYTES) return null;
    if (!ext) {
      const m = /\.(png|ico|jpe?g|gif|svg|webp)(?:[?#]|$)/i.exec(iconUrl);
      ext = m ? '.' + m[1].toLowerCase().replace('jpeg', 'jpg') : '.png';
    }

    // One icon per tool. The name carries a stamp: renderers address icons by
    // path, so reusing the name would show the cached old image.
    removeToolIconFiles(toolId);
    const filename = toolId + '.' + Date.now().toString(36) + ext;
    fs.writeFileSync(path.join(customIconsDir, filename), buf);
    return filename;
  } catch (e) {
    log.warn('Could not download tool icon:', e.message);
    return null;
  }
}

function removeToolIconFiles(toolId) {
  try {
    if (!fs.existsSync(customIconsDir)) return;
    fs.readdirSync(customIconsDir)
      .filter(f => f === toolId || f.startsWith(toolId + '.'))
      .forEach(f => { try { fs.unlinkSync(path.join(customIconsDir, f)); } catch (e) {} });
  } catch (e) {}
}

// Grabs the icon for a tool, falling back to the site's /favicon.ico when the
// page never advertised one.
async function captureToolIcon(url, toolId, knownIconUrl) {
  let filename = knownIconUrl ? await downloadToolIcon(knownIconUrl, toolId) : null;
  if (!filename) {
    try { filename = await downloadToolIcon(new URL('/favicon.ico', url).href, toolId); } catch (e) {}
  }
  return filename;
}

function getCustomTools() {
  if (!Array.isArray(appSettings.customTools)) appSettings.customTools = [];
  return appSettings.customTools;
}

// Shape the nav panel and tab strip consume: an icon they can render right now,
// falling back to a generic one when the site had none or the file went missing.
function customToolsForRenderer() {
  return getCustomTools().map(t => {
    const url = t.icon ? customIconUrl(t.icon) : null;
    return { id: t.id, url: t.url, title: t.title, icon: (url && resolveCustomIcon(url)) ? url : CUSTOM_TOOL_FALLBACK_ICON };
  });
}

// Drop a removed tool's id from the hidden list, or a later tool reusing that id
// would come back invisible.
function forgetHiddenNavButton(toolId) {
  const navId = 'custom:' + toolId;
  if (!Array.isArray(appSettings.hiddenNavButtons)) return;
  const remaining = appSettings.hiddenNavButtons.filter(x => x !== navId);
  if (remaining.length === appSettings.hiddenNavButtons.length) return;
  appSettings.hiddenNavButtons = remaining;
  if (navView && navView.webContents && !navView.webContents.isDestroyed())
    navView.webContents.send('update-nav-visibility', remaining);
}

function broadcastCustomTools() {
  const tools = customToolsForRenderer();
  if (navView && navView.webContents && !navView.webContents.isDestroyed())
    navView.webContents.send('custom-tools-updated', tools);
  if (settingsWindow && !settingsWindow.isDestroyed())
    settingsWindow.webContents.send('custom-tools-updated', tools);
  if (addToolWindow && !addToolWindow.isDestroyed())
    addToolWindow.webContents.send('custom-tools-updated', tools);
}

loadSettings();
chatHeightValue = appSettings.chatHeight || 300;

async function loadSoundSettings() {
  try {
    const soundsDir = path.join(process.env.APPDATA || path.join(process.env.HOME || process.env.USERPROFILE, '.config'), 'LostKit', 'sounds');
    const configPath = path.join(process.env.APPDATA || process.env.HOME, '.lostkit-stopwatch-config.json');
    const fsPromises = require('fs').promises;
    const configData = await fsPromises.readFile(configPath, 'utf8');
    const config = JSON.parse(configData);
    soundAlert = config.soundAlert || false;
    soundVolume = config.soundVolume || 60;
    if (config.customSoundFilename) customSoundPath = path.normalize(path.join(soundsDir, config.customSoundFilename));
    console.log('Sound settings loaded at startup:', { soundAlert, soundVolume, customSoundPath });
  } catch (e) { console.log('Sound settings not found, using defaults'); }
}

loadSoundSettings();
chatVisible = appSettings.chatVisible !== false;

function getScreenshotFolder() {
  let folder = appSettings.screenshotFolder;
  if (!folder) folder = path.join(app.getPath('pictures'), 'LostKit Screenshots');
  if (!fs.existsSync(folder)) {
    try { fs.mkdirSync(folder, { recursive: true }); }
    catch (e) { log.error('Failed to create screenshot folder:', e); folder = app.getPath('pictures'); }
  }
  return folder;
}

if (appSettings.lastWorld && appSettings.lastWorld.url) {
  tabs[0].url = appSettings.lastWorld.url;
  tabs[0].title = appSettings.lastWorld.title || 'World';
  tabByUrl.clear();
  tabByUrl.set(tabs[0].url, 'main');
}

let windowManagerReflowTimers = [];
let rendererResizeTimer = null;

function getViewWebContents() {
  const contents = [];
  if (mainWindow && !mainWindow.isDestroyed()) contents.push(mainWindow.webContents);
  if (navView && navView.webContents) contents.push(navView.webContents);
  if (chatView && chatView.webContents) contents.push(chatView.webContents);
  primaryViews.forEach(({ view, toolbar }) => {
    if (view && view.webContents) contents.push(view.webContents);
    if (toolbar && toolbar.webContents) contents.push(toolbar.webContents);
  });
  return contents.filter(wc => wc && !wc.isDestroyed());
}

function scheduleRendererResizeEvents() {
  if (rendererResizeTimer) clearTimeout(rendererResizeTimer);
  rendererResizeTimer = setTimeout(() => {
    rendererResizeTimer = null;
    getViewWebContents().forEach(wc => {
      // Skip views still loading: executeJavaScript would queue a did-stop-loading
      // listener until load finishes, piling up and triggering MaxListeners warnings.
      // A view that just loaded already lays out at its correct bounds.
      if (wc.isLoading()) return;
      wc.executeJavaScript("window.dispatchEvent(new Event('resize'));", true).catch(() => {});
    });
  }, 16);
}

// ── Split view ──
// The two tabs on screen as panes, or null for a single view.
// Unlocked, the pair follows the active tab. Locked, it is frozen and a third
// tab opens on its own.
function splitPairIds() {
  if (!splitTabId) return null;
  if (appSettings.splitViewEnabled === false) return null;
  const present = id => primaryViews.some(p => p.id === id);

  if (splitLocked && splitLockedPair) {
    const { leftId, rightId } = splitLockedPair;
    if (!present(leftId) || !present(rightId)) return null;
    // Away from the pair, the tab you clicked gets the whole area to itself.
    if (currentTab !== leftId && currentTab !== rightId) return null;
    return { leftId, rightId };
  }

  if (!present(splitTabId)) return null;

  // Either tab of the pair shows the pair. Clicking the pinned side falls back
  // to the last tab that held the other side, instead of collapsing to one.
  const other = currentTab === splitTabId ? splitOtherId : currentTab;
  if (!other || other === splitTabId || !present(other)) return null;

  // The game joins a split only as the side you deliberately picked, so clicking
  // the game tab never drags it into a split of two tools.
  if (other === 'main') return null;

  // And when it is in the split, it keeps the left side.
  const gameOnLeft = splitTabId === 'main';
  return {
    leftId: gameOnLeft ? 'main' : other,
    rightId: gameOnLeft ? other : splitTabId
  };
}

// The geometry of those two panes, or null when the window is too narrow.
function splitPanes(primaryWidth) {
  const usable = primaryWidth - SPLIT_DIVIDER;
  if (usable < SPLIT_DRAG_MIN * 2) return null;   // no longer room for two panes at all
  const ratio = Math.min(0.9, Math.max(0.1, appSettings.splitRatio || 0.5));
  const leftWidth = Math.max(SPLIT_DRAG_MIN, Math.min(usable - SPLIT_DRAG_MIN, Math.round(usable * ratio)));
  const rightWidth = usable - leftWidth;
  return { leftX: 0, leftWidth, rightX: leftWidth + SPLIT_DIVIDER, rightWidth };
}

function updateBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || !navView || !chatView) return;

  const [rawWidth, rawHeight] = mainWindow.getContentSize();
  const width = Math.max(0, rawWidth);
  const height = Math.max(0, rawHeight);
  const tabHeight = Math.min(28, height);
  const navWidth = navPanelMode === 'collapsed'
    ? 0
    : (navPanelMode === 'strip' ? NAV_PANEL_STRIP_WIDTH : Math.min(NAV_PANEL_WIDTH, width));
  const dividerHeight = chatVisible ? 3 : 0;
  const maxChatHeight = Math.max(0, height - tabHeight - dividerHeight);
  const chatHeight = chatVisible ? Math.min(chatHeightValue, maxChatHeight) : 0;
  const primaryWidth = Math.max(0, width - navWidth);
  const primaryHeight = Math.max(0, height - tabHeight - chatHeight - dividerHeight);

  // A tab with a toolbar gives up its top strip to it; the game view has none
  // and keeps the whole area. Two panes share the width, and the strip is told
  // which tab is on which side.
  const pair = splitPairIds();
  const panes = pair ? splitPanes(primaryWidth) : null;
  const splitLeftId = panes ? pair.leftId : null;
  const splitRightId = panes ? pair.rightId : null;
  primaryViews.forEach(({ id, view, toolbar }) => {
    let paneX = 0, paneWidth = primaryWidth;
    if (panes) {
      if (id === splitLeftId) { paneX = panes.leftX; paneWidth = panes.leftWidth; }
      else if (id === splitRightId) { paneX = panes.rightX; paneWidth = panes.rightWidth; }
    }
    if (toolbar) {
      const barHeight = Math.min(TOOLBAR_HEIGHT, primaryHeight);
      toolbar.setBounds({ x: paneX, y: tabHeight, width: paneWidth, height: barHeight });
      view.setBounds({ x: paneX, y: tabHeight + barHeight, width: paneWidth, height: Math.max(0, primaryHeight - barHeight) });
    } else {
      view.setBounds({ x: paneX, y: tabHeight, width: paneWidth, height: primaryHeight });
    }
    // Visibility comes from the pair, not from currentTab/splitTabId: with the
    // game pinned and its own tab active those are the same id, and the other
    // pane matched neither, leaving a hidden view holding half the window.
    const visible = panes ? (id === splitLeftId || id === splitRightId) : (id === currentTab);
    view.setVisible(visible);
    if (toolbar) toolbar.setVisible(visible);
  });
  if (navPanelMode !== 'collapsed') {
    navView.setVisible(true);
    navView.setBounds({ x: primaryWidth, y: 0, width: navWidth, height: height });
  } else {
    navView.setVisible(false);
  }
  chatView.setBounds({ x: 0, y: height - chatHeight, width: primaryWidth, height: chatHeight });
  // What the tab strip marks. A locked pair keeps its marks while a third tab is
  // open, since one click brings it back; `showing` tells the strip to dim them.
  const lockedPairIntact = splitLocked && splitLockedPair &&
    primaryViews.some(p => p.id === splitLockedPair.leftId) &&
    primaryViews.some(p => p.id === splitLockedPair.rightId);
  mainWindow.webContents.send('update-split-tabs',
    panes ? { leftId: splitLeftId, rightId: splitRightId, locked: splitLocked, showing: true }
    : (lockedPairIntact ? { leftId: splitLockedPair.leftId, rightId: splitLockedPair.rightId, locked: true, showing: false }
    : null));
  // ── Split view ── the seam the player drags to trade width between panes.
  mainWindow.webContents.send('update-split-divider', panes ? {
    x: panes.rightX - SPLIT_DIVIDER, y: tabHeight, width: SPLIT_DIVIDER, height: primaryHeight,
    usable: primaryWidth - SPLIT_DIVIDER   // what a drag position is measured against
  } : null);
  mainWindow.webContents.send('update-resizer', chatHeight);
  scheduleRendererResizeEvents();
}

// ── Tab strip as a drop target ───────────────────────────────────────────────
// Where the tab strip sits in screen coordinates, so a window being dragged can
// tell whether it is over it. The strip spans the content area minus the nav
// panel, which is painted on top of it. The band is given a little vertical
// slack because you are aiming with a titlebar, not a cursor tip.
const TAB_STRIP_HEIGHT = 28;   // matches the tabHeight used in updateBounds()
const TAB_STRIP_DROP_SLACK = 10;

function getTabStripScreenRect() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return null;
  const cb = mainWindow.getContentBounds();
  const navWidth = navPanelMode === 'collapsed'
    ? 0
    : (navPanelMode === 'strip' ? NAV_PANEL_STRIP_WIDTH : Math.min(NAV_PANEL_WIDTH, cb.width));
  return {
    x: cb.x, y: cb.y,
    width: Math.max(0, cb.width - navWidth),
    height: TAB_STRIP_HEIGHT + TAB_STRIP_DROP_SLACK
  };
}

function isCursorOverTabStrip() {
  const rect = getTabStripScreenRect();
  if (!rect || rect.width <= 0) return false;
  const { screen } = require('electron');
  const p = screen.getCursorScreenPoint();
  return p.x >= rect.x && p.x <= rect.x + rect.width &&
         p.y >= rect.y && p.y <= rect.y + rect.height;
}

let tabStripDropTarget = false;
function setTabStripDropTarget(active) {
  if (tabStripDropTarget === active) return;
  tabStripDropTarget = active;
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('tab-strip-drop-target', active);
}

function scheduleWindowManagerReflow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  updateBounds();
  windowManagerReflowTimers.forEach(clearTimeout);
  windowManagerReflowTimers = [50, 150, 350, 800].map(delay => setTimeout(() => {
    updateBounds();
  }, delay));
}

function animateChatToggle(toVisible) {
  if (chatAnimTimer) { clearInterval(chatAnimTimer); chatAnimTimer = null; }

  const CHAT_DELTA = chatHeightValue + 3; // panel height + divider
  const STEPS = 12;
  const MS    = 14;

  const { screen } = require('electron');
  const startBounds = mainWindow.getBounds();
  const display     = screen.getDisplayMatching(startBounds);
  const workArea    = display.workArea;

  let targetBounds;
  if (toVisible) {
    const expandedBottom = startBounds.y + startBounds.height + CHAT_DELTA;
    let newY = startBounds.y;
    if (expandedBottom > workArea.y + workArea.height) {
      chatPrevY = startBounds.y;
      newY = Math.max(workArea.y, startBounds.y - (expandedBottom - (workArea.y + workArea.height)));
    } else {
      chatPrevY = null;
    }
    targetBounds = { x: startBounds.x, y: newY, width: startBounds.width, height: startBounds.height + CHAT_DELTA };
    chatView.setVisible(true);
  } else {
    let restoreY = startBounds.y;
    if (chatPrevY !== null) { restoreY = chatPrevY; chatPrevY = null; }
    targetBounds = { x: startBounds.x, y: restoreY, width: startBounds.width, height: startBounds.height - CHAT_DELTA };
  }

  let step = 0;
  chatAnimTimer = setInterval(() => {
    step++;
    const p  = step / STEPS;
    const ep = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    const wb = {
      x:      Math.round(startBounds.x      + (targetBounds.x      - startBounds.x)      * ep),
      y:      Math.round(startBounds.y      + (targetBounds.y      - startBounds.y)      * ep),
      width:  Math.round(startBounds.width  + (targetBounds.width  - startBounds.width)  * ep),
      height: Math.round(startBounds.height + (targetBounds.height - startBounds.height) * ep),
    };
    mainWindow.setBounds(wb);
    updateBounds();
    if (step >= STEPS) {
      clearInterval(chatAnimTimer); chatAnimTimer = null;
      chatVisible = toVisible;
      if (!toVisible) chatView.setVisible(false);
      appSettings.chatVisible = toVisible;
      saveSettingsDebounced();
      mainWindow.setBounds(targetBounds);
      updateBounds();
      mainWindow.webContents.send('chat-toggled', toVisible, chatHeightValue);
      if (navView && !navView.webContents.isDestroyed()) {
        navView.webContents.send('chat-toggled', toVisible, chatHeightValue);
      }
    }
  }, MS);
}

function getGameViewAbsoluteBounds() {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    if (mainWindow.isMinimized()) return null;
    const mainPV = primaryViews.find(pv => pv.id === 'main');
    if (!mainPV || !mainPV.view) return null;
    const contentBounds = mainWindow.getContentBounds();
    const viewBounds = mainPV.view.getBounds();
    return { x: contentBounds.x + viewBounds.x, y: contentBounds.y + viewBounds.y, width: viewBounds.width, height: viewBounds.height };
  } catch (e) { return null; }
}

function initDefaultPackagedSoundPath() {
  try {
    const possiblePaths = [
      path.join(__dirname, 'assets', 'sound', "Bell_(Wizards'_Guild)_ringing.wav.ogg"),
      path.join(process.resourcesPath, 'assets', 'sound', "Bell_(Wizards'_Guild)_ringing.wav.ogg"),
      path.join(__dirname, 'src', 'assets', 'sound', "Bell_(Wizards'_Guild)_ringing.wav.ogg"),
    ];
    for (const testPath of possiblePaths) {
      if (fs.existsSync(testPath)) { defaultPackagedSoundPath = testPath; console.log('Found default packaged sound at:', defaultPackagedSoundPath); return; }
    }
    console.log('Default packaged sound not found');
  } catch (e) { console.log('Error initializing default packaged sound path:', e); }
}

app.whenReady().then(() => {
  initDefaultPackagedSoundPath();
  startCreatorPolling(); // background polling for creators
  startMarketPolling();  // background polling for watched market items

  if (typeof appSettings.navPanelMode === 'string') {
    navPanelDesiredMode = appSettings.navPanelMode;
  } else {
    navPanelDesiredMode = 'expanded';
  }
  navPanelMode = (typeof appSettings.navPanelCollapsed === 'boolean' && appSettings.navPanelCollapsed)
    ? 'collapsed'
    : navPanelDesiredMode;
  navPanelCollapsed = navPanelMode === 'collapsed';

  ipcMain.on('toggle-nav-panel', () => {
    if (navPanelMode === 'collapsed') {
      navPanelMode = navPanelDesiredMode || 'expanded';
      navPanelCollapsed = false;
    } else {
      navPanelPrevMode = navPanelMode;
      navPanelMode = 'collapsed';
      navPanelCollapsed = true;
    }

    appSettings.navPanelMode = navPanelDesiredMode;
    appSettings.navPanelCollapsed = navPanelCollapsed;
    saveSettingsDebounced();

    const bounds = mainWindow.getBounds();
    const { screen } = require('electron');
    const display = screen.getDisplayMatching(bounds);
    const displayRight = display.workArea.x + display.workArea.width;
    log.info('--- NAV PANEL TOGGLE ---');
    log.info('Window bounds:', bounds);
    log.info('Display workArea:', display.workArea);

    const currentNavWidth = navPanelPrevMode === 'strip' ? NAV_PANEL_STRIP_WIDTH : NAV_PANEL_WIDTH;
    if (navPanelCollapsed) {
      let restoreX = bounds.x;
      if (navPanelPrevX !== null) { restoreX = navPanelPrevX; navPanelPrevX = null; }
      mainWindow.setBounds({ width: Math.max(bounds.width - currentNavWidth, 800), height: bounds.height, x: restoreX, y: bounds.y });
    } else {
      let newX = bounds.x;
      const expandedWidth = navPanelMode === 'strip' ? NAV_PANEL_STRIP_WIDTH : NAV_PANEL_WIDTH;
      const expandedRight = bounds.x + bounds.width + expandedWidth;
      if (expandedRight > displayRight) { navPanelPrevX = bounds.x; newX = bounds.x - (expandedRight - displayRight); }
      else { navPanelPrevX = null; }
      mainWindow.setBounds({ width: bounds.width + expandedWidth, height: bounds.height, x: newX, y: bounds.y });
    }

    scheduleWindowManagerReflow();
    if (navView && !navView.webContents.isDestroyed()) navView.webContents.send('nav-panel-collapsed', navPanelCollapsed);
  });

  ipcMain.on('toggle-nav-panel-mode', () => {
    if (navPanelMode === 'collapsed') {
      navPanelMode = navPanelDesiredMode || 'expanded';
      navPanelCollapsed = false;
    }

    const prevMode = navPanelMode;
    if (navPanelMode === 'expanded') {
      navPanelMode = 'strip';
      navPanelDesiredMode = 'strip';
    } else if (navPanelMode === 'strip') {
      navPanelMode = 'expanded';
      navPanelDesiredMode = 'expanded';
    }

    navPanelCollapsed = false;
    appSettings.navPanelMode = navPanelDesiredMode;
    appSettings.navPanelCollapsed = false;
    saveSettingsDebounced();

    // Adjust the actual native window size so toggling between strip and
    // expanded does not reduce the primary view width - grow/shrink the
    // window instead, keeping the game canvas size intact.
    try {
      const bounds = mainWindow.getBounds();
      const { screen } = require('electron');
      const display = screen.getDisplayMatching(bounds);
      const delta = NAV_PANEL_WIDTH - NAV_PANEL_STRIP_WIDTH;
      if (prevMode === 'expanded' && navPanelMode === 'strip') {
        const newWidth = Math.max(800, bounds.width - delta);
        let newX = bounds.x;
        const newRight = newX + newWidth;
        const displayRight = display.workArea.x + display.workArea.width;
        if (newRight > displayRight) newX = Math.max(display.workArea.x, bounds.x - (newRight - displayRight));
        mainWindow.setBounds({ width: newWidth, height: bounds.height, x: newX, y: bounds.y });
      } else if (prevMode === 'strip' && navPanelMode === 'expanded') {
        const newWidth = bounds.width + delta;
        let newX = bounds.x;
        const newRight = newX + newWidth;
        const displayRight = display.workArea.x + display.workArea.width;
        if (newRight > displayRight) newX = Math.max(display.workArea.x, bounds.x - (newRight - displayRight));
        mainWindow.setBounds({ width: newWidth, height: bounds.height, x: newX, y: bounds.y });
      }
    } catch (e) {}

    scheduleWindowManagerReflow();
    if (navView && !navView.webContents.isDestroyed()) navView.webContents.send('nav-panel-mode', navPanelMode);
  });

  const savedBounds = appSettings.mainWindow || {};
  mainWindow = new BrowserWindow({
    width: savedBounds.width || 1100, height: savedBounds.height || 920,
    x: savedBounds.x != null ? savedBounds.x : undefined,
    y: savedBounds.y != null ? savedBounds.y : undefined,
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
    title: `LostKit 2 v${version} - by LostHQ Team`
  });
  installAppMenu();
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  applyAlwaysOnTop(mainWindow);
  mainWindow.webContents.on('did-finish-load', () => {
    applyFontToView(mainWindow.webContents, false);
    setupAutoUpdater();
    mainWindow.webContents.send('nav-panel-collapsed', navPanelCollapsed);
    mainWindow.webContents.send('chat-toggled', chatVisible, chatHeightValue);
    if (navView && !navView.webContents.isDestroyed()) {
      navView.webContents.send('chat-toggled', chatVisible, chatHeightValue);
    }
    // Reopen the tabs from last quit. Runs here because the tab strip only
    // exists once index.html has loaded - earlier sends would be dropped.
    restoreTabs();
    scheduleWindowManagerReflow();
  });

  // ── Screenshot IPC ──────────────────────────────────────────────────────────
  ipcMain.handle('select-screenshot-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: 'Select Screenshot Folder' });
    if (!result.canceled && result.filePaths.length > 0) {
      const folder = result.filePaths[0];
      appSettings.screenshotFolder = folder; saveSettingsDebounced();
      mainWindow.webContents.send('screenshot-folder-updated', folder);
      return folder;
    }
    return null;
  });
  ipcMain.handle('get-screenshot-folder', () => getScreenshotFolder());
  ipcMain.on('open-screenshot-folder', () => shell.openPath(getScreenshotFolder()));
  // System calculator. Windows and macOS have one each; on Linux try the common
  // desktop calculators and launch the first that is installed.
  const LINUX_CALCULATORS = ['gnome-calculator', 'kcalc', 'mate-calc', 'galculator', 'qalculate-gtk', 'xcalc'];

  ipcMain.on('open-calculator', () => {
    const { exec } = require('child_process');

    if (process.platform === 'win32') { exec('calc.exe', { windowsHide: false }); return; }
    if (process.platform === 'darwin') { exec('open -a Calculator'); return; }

    (function tryNext(i) {
      if (i >= LINUX_CALCULATORS.length) {
        log.warn('No calculator found. Tried: ' + LINUX_CALCULATORS.join(', '));
        return;
      }
      const name = LINUX_CALCULATORS[i];
      exec('which ' + name, (err) => {
        if (err) { tryNext(i + 1); return; }
        exec(name);
        log.info('Opened calculator: ' + name);
      });
    })(0);
  });
  function takeScreenshot() {
    const mainPV = primaryViews.find(p => p.id === currentTab);
    if (!mainPV || !mainPV.view || !mainPV.view.webContents) return;
    // Use canvas-based capture via preload so we get only the game canvas,
    // not the entire BrowserView bounds. The preload responds with 'save-screenshot'.
    mainPV.view.webContents.send('request-screenshot');
  }
// Canvas-based screenshot save (from gameview-preload.js canvas capture)
ipcMain.on('save-screenshot', (event, dataUrl) => {
  if (!dataUrl) return;
  const folder = getScreenshotFolder();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filepath = path.join(folder, `screenshot-${timestamp}.png`);
  try {
    fs.writeFileSync(filepath, dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
    log.info('Screenshot saved:', filepath);
    // Play screenshot sound if enabled
    if (appSettings.screenshotSoundEnabled !== false) {
      const vol = appSettings.screenshotSoundVolume !== undefined ? appSettings.screenshotSoundVolume : 80;
      const custom = appSettings.screenshotCustomSoundPath;
      let soundPath = null;
      if (custom && custom.trim() !== '') {
        try { if (fs.existsSync(custom)) soundPath = custom; } catch(e) {}
      }
      if (!soundPath) {
        const bloomPaths = [
          path.join(__dirname, 'assets', 'sound', 'Bloom.ogg.mp3'),
          path.join(__dirname, '..', 'assets', 'sound', 'Bloom.ogg.mp3'),
          path.join(__dirname, 'src', 'assets', 'sound', 'Bloom.ogg.mp3'),
        ];
        if (process.resourcesPath) {
          bloomPaths.push(path.join(process.resourcesPath, 'assets', 'sound', 'Bloom.ogg.mp3'));
          bloomPaths.push(path.join(process.resourcesPath, 'app', 'assets', 'sound', 'Bloom.ogg.mp3'));
          bloomPaths.push(path.join(process.resourcesPath, 'app', 'src', 'assets', 'sound', 'Bloom.ogg.mp3'));
        }
        soundPath = bloomPaths.find(p => { try { return fs.existsSync(p); } catch(e) { return false; } }) || null;
      }
      if (soundPath && mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
        log.info('Playing screenshot sound:', soundPath, 'vol:', vol);
        mainWindow.webContents.send('play-alert-sound', { customSoundPath: soundPath, soundVolume: vol });
      } else {
        log.warn('Screenshot sound not found');
      }
    }
  } catch (e) { log.error('Failed to save screenshot:', e); }
});
  ipcMain.on('capture-screenshot', () => takeScreenshot());

  let currentScreenshotAccelerator = null;
  function registerScreenshotKeybind(accelerator) {
    if (currentScreenshotAccelerator) { try { globalShortcut.unregister(currentScreenshotAccelerator); } catch (e) {} currentScreenshotAccelerator = null; }
    if (!accelerator || accelerator.trim() === '') return;
    try {
      const ret = globalShortcut.register(accelerator, () => {
        takeScreenshot();
      });
      if (ret) { currentScreenshotAccelerator = accelerator; log.info('Screenshot keybind registered:', accelerator); }
      else { log.warn('Failed to register screenshot keybind:', accelerator); }
    } catch (e) { log.error('Error registering screenshot keybind:', e); }
  }
  if (appSettings.screenshotKeybind) registerScreenshotKeybind(appSettings.screenshotKeybind);
  ipcMain.on('set-screenshot-keybind', (event, accelerator) => { appSettings.screenshotKeybind = accelerator || ''; saveSettings(); registerScreenshotKeybind(accelerator); });
  ipcMain.handle('get-screenshot-keybind', () => appSettings.screenshotKeybind || '');

  // ── Always-on-top toggle ──────────────────────────────────────────────────
  ipcMain.handle('get-always-on-top', () => !!appSettings.alwaysOnTop);
  ipcMain.on('set-always-on-top', (event, enabled) => {
    appSettings.alwaysOnTop = !!enabled;
    saveSettings();
    applyAlwaysOnTopAll();
  });

  // ── Settings popup ──────────────────────────────────────────────────────────
  ipcMain.on('open-settings-popup', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.focus(); return; }
    const settingsBounds = appSettings.settingsWindow || { width: 600, height: 500 };
    settingsWindow = new BrowserWindow({
      width: settingsBounds.width || 600, height: settingsBounds.height || 500,
      x: settingsBounds.x != null ? settingsBounds.x : undefined, y: settingsBounds.y != null ? settingsBounds.y : undefined,
      autoHideMenuBar: true, webPreferences: { nodeIntegration: true, contextIsolation: false }, title: 'LostKit - Settings'
    });
    settingsWindow.loadFile(path.join(__dirname, 'navitems/stopwatch-settings.html'));
    applyAlwaysOnTop(settingsWindow);
    const saveSettingsBounds = () => {
      if (settingsWindow && !settingsWindow.isDestroyed() && !settingsWindow.isMinimized()) {
        const b = settingsWindow.getBounds();
        appSettings.settingsWindow = { width: b.width, height: b.height, x: b.x, y: b.y }; saveSettings();
      }
    };
    settingsWindow.on('resize', saveSettingsBounds); settingsWindow.on('move', saveSettingsBounds);
    settingsWindow.on('closed', () => { settingsWindow = null; });
    settingsWindow.webContents.on('did-finish-load', () => {
      applyFontToView(settingsWindow.webContents, true); // navitems/ path → isNavitem: true
      settingsWindow.webContents.send('load-settings', {
        adventureCaptureEnabled: appSettings.adventureCaptureEnabled || false,
        screenshotFolder: appSettings.screenshotFolder || '',
        captureInterval: appSettings.captureInterval || 60,
        randomInterval: appSettings.randomInterval || false,
        createAdventureFolder: appSettings.createAdventureFolder !== false,
        screenshotSoundEnabled: appSettings.screenshotSoundEnabled !== false,
        screenshotSoundVolume: appSettings.screenshotSoundVolume !== undefined ? appSettings.screenshotSoundVolume : 80,
        screenshotCustomSoundPath: appSettings.screenshotCustomSoundPath || ''
      });
    });
  });

  ipcMain.on('update-stopwatch-settings', (event, settings) => {
    appSettings.adventureCaptureEnabled = settings.adventureCaptureEnabled;
    appSettings.screenshotFolder = settings.screenshotFolder;
    appSettings.captureInterval = settings.captureInterval;
    appSettings.randomInterval = settings.randomInterval;
    appSettings.createAdventureFolder = settings.createAdventureFolder;
    if (typeof settings.screenshotSoundEnabled === 'boolean') appSettings.screenshotSoundEnabled = settings.screenshotSoundEnabled;
    if (settings.screenshotSoundVolume !== undefined) appSettings.screenshotSoundVolume = settings.screenshotSoundVolume;
    if (settings.screenshotCustomSoundPath !== undefined) appSettings.screenshotCustomSoundPath = settings.screenshotCustomSoundPath;
    saveSettings();
    updateAdventureCapture();
  });

  ipcMain.on('test-screenshot-sound', (event, vol, customPath) => {
    const volume = vol !== undefined ? vol : (appSettings.screenshotSoundVolume !== undefined ? appSettings.screenshotSoundVolume : 80);
    // Prefer passed custom path, then saved custom, then bloom
    let soundPath = null;
    const tryCustom = customPath || appSettings.screenshotCustomSoundPath || '';
    if (tryCustom.trim() !== '') {
      try { if (fs.existsSync(tryCustom)) soundPath = tryCustom; } catch(e) {}
    }
    if (!soundPath) {
      const bloomPaths = [
        path.join(__dirname, 'assets', 'sound', 'Bloom.ogg.mp3'),
        path.join(__dirname, '..', 'assets', 'sound', 'Bloom.ogg.mp3'),
        path.join(__dirname, 'src', 'assets', 'sound', 'Bloom.ogg.mp3'),
      ];
      if (process.resourcesPath) {
        bloomPaths.push(path.join(process.resourcesPath, 'assets', 'sound', 'Bloom.ogg.mp3'));
        bloomPaths.push(path.join(process.resourcesPath, 'app', 'assets', 'sound', 'Bloom.ogg.mp3'));
        bloomPaths.push(path.join(process.resourcesPath, 'app', 'src', 'assets', 'sound', 'Bloom.ogg.mp3'));
      }
      soundPath = bloomPaths.find(p => { try { return fs.existsSync(p); } catch(e) { return false; } }) || null;
    }
    if (soundPath && mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('play-alert-sound', { customSoundPath: soundPath, soundVolume: volume });
      log.info('Test screenshot sound played:', soundPath);
    } else {
      log.warn('Test screenshot sound: no sound file found');
    }
  });

  // Return the shared sounds directory path
  ipcMain.handle('get-sounds-dir', () => {
    return path.join(process.env.APPDATA || path.join(process.env.HOME || process.env.USERPROFILE, '.config'), 'LostKit', 'sounds');
  });

  // ── Adventure Capture ───────────────────────────────────────────────────────
  let adventureCaptureTimer = null;
  function updateAdventureCapture() {
    if (adventureCaptureTimer) { clearTimeout(adventureCaptureTimer); adventureCaptureTimer = null; }
    if (!appSettings.adventureCaptureEnabled || !appSettings.screenshotFolder) return;
    scheduleAdventureCapture();
  }
  function scheduleAdventureCapture() {
    if (!appSettings.adventureCaptureEnabled) return;
    
    // Check if AFK timer is at zero or negative (>= 90 seconds elapsed = 0:00 or negative display)
    // If so, don't schedule adventure capture
    const afkTimerAtZeroOrBelow = (backgroundTimerRunning && backgroundTimerMode === 'afk' && backgroundTimerSeconds >= 90) ||
                                   (gameClickTimerRunning && gameClickTimerSeconds >= 90);
    if (afkTimerAtZeroOrBelow) {
      console.log('AFK timer at zero or negative - pausing adventure capture');
      return;
    }
    
    let delay;
    if (appSettings.randomInterval) {
      const baseInterval = (appSettings.captureInterval || 60) * 1000;
      const minDelay = 10000, maxDelay = Math.max(baseInterval * 3, 300000);
      delay = Math.floor(minDelay + ((Math.random() + Math.random()) / 2) * (maxDelay - minDelay));
    } else { delay = (appSettings.captureInterval || 60) * 1000; }
    adventureCaptureTimer = setTimeout(() => { captureAdventureScreenshot(); scheduleAdventureCapture(); }, delay);
  }
  function captureAdventureScreenshot() {
    // Don't capture if AFK timer is at zero or negative
    const afkTimerAtZeroOrBelow = (backgroundTimerRunning && backgroundTimerMode === 'afk' && backgroundTimerSeconds >= 90) ||
                                   (gameClickTimerRunning && gameClickTimerSeconds >= 90);
    if (afkTimerAtZeroOrBelow) {
      console.log('AFK timer at zero or negative - skipping this capture');
      return;
    }
    const mainPV = primaryViews.find(p => p.id === currentTab);
    if (!mainPV || !mainPV.view || !mainPV.view.webContents) return;
    // Use canvas-based capture via preload so we get only the game canvas
    mainPV.view.webContents.send('request-adventure-screenshot');
  }
  ipcMain.on('save-adventure-screenshot', (event, dataUrl) => {
    if (!dataUrl) return;
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yy = String(now.getFullYear()).slice(-2);
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const dayFolder = `${dd}-${mm}-${yy}`;
    const filename = `${dd}-${mm}-${yy}_${hh}-${min}-${ss}.png`;
    let folderPath = getScreenshotFolder();
    if (appSettings.createAdventureFolder) folderPath = path.join(folderPath, 'Adventure Capture', dayFolder);
    fs.mkdir(folderPath, { recursive: true }, (err) => {
      if (err) { console.error('Error creating adventure capture folder:', err); return; }
      const buf = Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
      fs.writeFile(path.join(folderPath, filename), buf, (err) => {
        if (err) console.error('Error saving adventure screenshot:', err);
        else console.log('Adventure screenshot saved:', filename);
      });
    });
  });

  updateAdventureCapture();

  navView = new WebContentsView({ webPreferences: { nodeIntegration: true, contextIsolation: false } });
  navView.webContents.loadFile(path.join(__dirname, 'nav.html'));
  navView.webContents.on('did-finish-load', () => {
    applyFontToView(navView.webContents, true);
    scheduleWindowManagerReflow();
    // Send nav visibility whenever nav.html loads
    if (currentNavViewName === 'nav' && appSettings.hiddenNavButtons?.length) {
      navView.webContents.send('update-nav-visibility', appSettings.hiddenNavButtons);
    }
    // Send channel state when youtube.html loads
    if (currentNavViewName === 'youtube') {
      navView.webContents.send('creator-channels-from-main', appSettings.creatorChannels || []);
    }
    // Tell the nav view what display mode it should render in
    if (navView && !navView.webContents.isDestroyed()) {
      navView.webContents.send('nav-panel-mode', navPanelMode);
      navView.webContents.send('chat-toggled', chatVisible, chatHeightValue);
    }
  });
  mainWindow.contentView.addChildView(navView);
  startWorldStatusInterval();

  chatView = new WebContentsView({ webPreferences: { webSecurity: false, preload: path.join(__dirname, 'preload-zoom-shared.js') } });
  chatView.webContents.loadURL('https://irc.losthq.rs');
  chatView.webContents.on('did-finish-load', () => scheduleWindowManagerReflow());
  chatView.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  mainWindow.contentView.addChildView(chatView);
  chatView.setVisible(chatVisible);
  if (appSettings.chatZoom && appSettings.chatZoom !== 1) {
    chatView.webContents.once('did-finish-load', () => { try { chatView.webContents.setZoomFactor(appSettings.chatZoom); } catch (e) {} });
  }

  const mainView = new WebContentsView({ webPreferences: { webSecurity: false, preload: path.join(__dirname, 'gameview-preload.js') } });
  const startWorldUrl = tabs[0].url, startWorldTitle = tabs[0].title;
  mainView.webContents.loadURL(startWorldUrl);
  mainView.webContents.on('did-finish-load', () => scheduleWindowManagerReflow());
  mainView.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  mainWindow.contentView.addChildView(mainView);
  primaryViews.push({ id: 'main', view: mainView });
  if (appSettings.zoomFactor && appSettings.zoomFactor !== 1) mainView.webContents.once('did-finish-load', () => { try { mainView.webContents.setZoomFactor(appSettings.zoomFactor); } catch (e) {} });
  if (appSettings.tabZoom && appSettings.tabZoom[startWorldUrl]) mainView.webContents.once('did-finish-load', () => { try { mainView.webContents.setZoomFactor(appSettings.tabZoom[startWorldUrl]); } catch (e) {} });

  // ── AFK input detection - host-level only, nothing injected into the game ──
  // before-input-event fires in the main process before the event reaches the
  // page, so we never need to touch the game's DOM or JS context.
  mainView.webContents.on('before-input-event', (event, input) => {
    // ── Block accidental navigation shortcuts on the game tab ──────────────
    // Suppress Alt+Left, Alt+Right (back/forward), F5, Ctrl+R (refresh),
    // Ctrl+Shift+R (hard refresh), browser history shortcuts.
    if (input.type === 'keyDown') {
      const ctrl  = input.control || input.meta;
      const alt   = input.alt;
      const shift = input.shift;
      const key   = input.key;

      const isNavigation = (
        // Browser back / forward (Alt+Arrow)
        (alt && (key === 'ArrowLeft' || key === 'ArrowRight')) ||
        // Reload shortcuts
        (key === 'F5') ||
        (ctrl && (key === 'r' || key === 'R')) ||
        (ctrl && key === 'F5') ||
        (shift && key === 'F5') ||
        // Dedicated media/browser keys present on many keyboards
        key === 'BrowserBack'    ||
        key === 'BrowserForward' ||
        key === 'BrowserRefresh' ||
        key === 'BrowserStop'
      );

      if (isNavigation) {
        event.preventDefault();
        return;
      }

      // ── Ctrl+0 - reset zoom to 100% ──────────────────────────────────────
      if (ctrl && key === '0') {
        event.preventDefault();
        mainView.webContents.setZoomFactor(1.0);
        appSettings.zoomFactor = 1.0;
        saveSettingsDebounced();
        log.info('Zoom reset to 100%');
        return;
      }
    }

    // ── AFK timer reset on keypress (before-input-event is keyboard only) ────
    if (input.type !== 'keyDown') return;
    if (!afkGameClick || afkInputType !== 'both') return;
    resetGameClickTimer();
    if (navView && navView.webContents) navView.webContents.send('afk-game-click-reset');
  });

  // ── Block ALL page-initiated navigation on the game view ───────────────────
  // This covers: clicking links inside the game page, JavaScript window.location
  // changes, form submits, mouse back/forward button gestures, and any other
  // renderer-side navigation attempt. The ONLY valid way to load a new world is
  // through select-world → webContents.loadURL(), which bypasses will-navigate.
  mainView.webContents.on('will-navigate', (event) => {
    event.preventDefault();
    log.info('Blocked page-initiated navigation on game view');
  });

  // Track history-state navigations (pushState/replaceState) - e.g. fullscreen toggle.
  // We intentionally do NOT reload here: did-navigate-in-page never unloads the page,
  // so there is nothing to "restore". Calling loadURL() here was causing a full page
  // reload whenever the game's fullscreen button fired a pushState URL change.
  // Real cross-origin navigation is already blocked by the will-navigate handler above.
  mainView.webContents.on('did-navigate-in-page', (event, url, isMainFrame) => {
    if (isMainFrame) {
      // Keep the stored URL in sync so future checks use the current URL.
      const mainTabData = tabs.find(t => t.id === 'main');
      if (mainTabData) {
        mainTabData.url = url;
      }
    }
  });

  // ── Game view: no navigation ───────────────────────────────────────────────
  // Only the world switcher may change this view, via loadURL(). Keyboard is
  // handled in before-input-event above; the rest is:
  //   1. history emptied after every load, so there is no entry to go back to
  //   2. app-command, which is how thumb and media buttons arrive (never as key
  //      events, so before-input-event cannot see them)
  //   3. will-frame-navigate, for main-frame attempts will-navigate misses
  const clearGameHistory = () => {
    try {
      const wc = mainView.webContents;
      if (wc.navigationHistory?.clear) wc.navigationHistory.clear();
      else if (wc.clearHistory) wc.clearHistory();
    } catch (e) {}
  };
  mainView.webContents.on('did-finish-load', clearGameHistory);
  mainView.webContents.on('did-navigate', clearGameHistory);

  mainView.webContents.on('will-frame-navigate', (details) => {
    if (details.isMainFrame) {
      details.preventDefault();
      log.info('Blocked frame navigation on game view');
    }
  });

  // ── Suppress right-click context menu on the game view ────────────────────
  // Chromium's default context menu includes Back / Forward / Reload entries.
  // Blocking it entirely prevents accidental navigation via right-click.
  mainView.webContents.on('context-menu', (event) => {
    event.preventDefault();
  });

  // Mouse thumb and media back/forward keys arrive as app-commands, not key
  // events. Swallowed on the game tab, applied to any other tab.
  mainWindow.on('app-command', (event, command) => {
    if (command !== 'browser-backward' && command !== 'browser-forward') return;
    event.preventDefault();                       // never let Chromium act on it
    if (currentTab === 'main') return;            // the game view: swallowed
    navigateTab(currentTab, command === 'browser-backward' ? 'back' : 'forward');
  });

  const saveMainWindowBounds = () => {
    if (mainWindow && !mainWindow.isMinimized() && !mainWindow.isMaximized()) {
      const b = mainWindow.getBounds();
      // Width borrowed for a split is not the player's own size. Subtract it,
      // or quitting while split widens the window again every launch.
      const ownWidth = Math.max(800, b.width - splitGrewWindowBy);
      appSettings.mainWindow = { width: ownWidth, height: b.height, x: b.x, y: b.y };
      saveSettingsDebounced();
    }
  };
  mainWindow.on('resized', saveMainWindowBounds);
  mainWindow.on('moved', saveMainWindowBounds);
  mainWindow.webContents.send('update-active', 'main');
  mainWindow.webContents.send('update-tab-title', 'main', startWorldTitle);
  scheduleWindowManagerReflow();
  mainWindow.webContents.send('chat-toggled', chatVisible, chatHeightValue);
  if (navView && !navView.webContents.isDestroyed()) {
    navView.webContents.send('chat-toggled', chatVisible, chatHeightValue);
  }

  ['resize', 'resized', 'show', 'focus', 'restore', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'].forEach(eventName => {
    mainWindow.on(eventName, () => scheduleWindowManagerReflow());
  });

  const { screen } = require('electron');
  ['display-added', 'display-removed', 'display-metrics-changed'].forEach(eventName => {
    screen.on(eventName, () => scheduleWindowManagerReflow());
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // GAME-CLICK AFK TIMER (legacy - kept for stopwatch panel IPC compatibility)
  // ══════════════════════════════════════════════════════════════════════════════

  function startGameClickTimer() {
    if (gameClickTimerRunning) { console.log('Game-click timer already running, continuing'); return; }
    gameClickTimerRunning = true;
    gameClickTimerSeconds = 0;
    gameClickAlertTriggeredInCycle = false;
    console.log('Starting game-click background timer');
    armGameClickTimer();
    // Only update titlebar if background timer isn't running (avoids conflict)
    if (!backgroundTimerRunning) updateWindowTitleWithTimer(true, 0, 'afk', 90);
  }

  // Arms the ticker without disturbing the current count. Polls sub-second so a
  // boundary is reported promptly; the tick is a no-op until the second changes.
  function armGameClickTimer() {
    if (gameClickTimerInterval) clearInterval(gameClickTimerInterval);
    gameClickTimerStartTime = Date.now() - gameClickTimerSeconds * 1000;
    gameClickTimerInterval = setInterval(tickGameClickTimer, 250);
  }

  function tickGameClickTimer() {
    const elapsed = Math.floor((Date.now() - gameClickTimerStartTime) / 1000);
    if (elapsed <= gameClickTimerSeconds) return;   // same second, nothing to say
    const previous = gameClickTimerSeconds;
    gameClickTimerSeconds = elapsed;
    if (navView && navView.webContents) navView.webContents.send('game-click-timer-tick', gameClickTimerSeconds);

    // FIX: Background timer owns the titlebar when running - prevents the two
    // timers fighting each other and causing the titlebar to drift out of sync
    // with what the stopwatch panel shows.
    if (!backgroundTimerRunning) {
      updateWindowTitleWithTimer(true, gameClickTimerSeconds, 'afk', 90);
    }

    // When game-click timer reaches zero (90 seconds), cancel adventure capture
    if (gameClickTimerSeconds >= 90 && adventureCaptureTimer) {
      clearTimeout(adventureCaptureTimer);
      adventureCaptureTimer = null;
      console.log('Game-click timer reached 0:00 - cancelling pending adventure capture');
    }

    const safeThreshold = Math.max(1, Math.min(89, parseInt(alertThreshold, 10) || 10));
    const thresholdTime = 90 - safeThreshold;
    if (!gameClickAlertTriggeredInCycle && gameClickTimerSeconds >= thresholdTime && gameClickTimerSeconds < 90) {
      gameClickAlertTriggeredInCycle = true;
      console.log('Game-click timer reached threshold, alerting');
      triggerGameClickAlert();
    }
    if (previous < 90 && gameClickTimerSeconds >= 90) console.log('Game-click timer reached 90s, continuing to count for negative display');
  }

  function resetGameClickTimer() {
    if (gameClickTimerRunning) {
      gameClickTimerSeconds = 0;
      gameClickTimerStartTime = Date.now();
      gameClickAlertTriggeredInCycle = false;
      console.log('Game-click timer reset to 0');
      if (navView && navView.webContents) navView.webContents.send('game-click-timer-tick', 0);
      if (!backgroundTimerRunning) updateWindowTitleWithTimer(true, 0, 'afk', 90);
      // Stop alert sound when timer is reset
      stopAlertSound();
      // Resume adventure capture when timer is reset
      updateAdventureCapture();
    } else if (afkGameClick) {
      stopAlertSound();
      startGameClickTimer();
    }
  }

  function stopGameClickTimer() {
    if (gameClickTimerInterval) { clearInterval(gameClickTimerInterval); gameClickTimerInterval = null; }
    gameClickTimerRunning = false;
    gameClickTimerSeconds = 0;
    gameClickAlertTriggeredInCycle = false;
    console.log('Stopped game-click timer');
    if (!backgroundTimerRunning) updateWindowTitleWithTimer(false, 0, 'afk', 90);
  }

  // ── Hover ENTER / UN-IDLE - pause timers, show 1:30 frozen ───────────────
  function pauseTimerForHover() {
    if (!afkGameClick || !afkHover) return;
    stopAlertSound();

    // Stop & reset both timers (do NOT restart yet)
    if (gameClickTimerInterval) { clearInterval(gameClickTimerInterval); gameClickTimerInterval = null; }
    gameClickTimerSeconds = 0;
    gameClickTimerStartTime = Date.now();
    gameClickAlertTriggeredInCycle = false;

    if (backgroundTimerInterval) { clearInterval(backgroundTimerInterval); backgroundTimerInterval = null; }
    backgroundTimerSeconds = 0;
    backgroundTimerStartTime = null;
    backgroundAlertTriggered = false;

    hoverPaused = true;
    console.log('hover: cursor ENTERED/MOVED in game view - timers paused, showing 1:30');

    // Push 0 to stopwatch panel → shows 1:30, paused
    if (navView && navView.webContents) {
      navView.webContents.send('background-timer-tick', { seconds: 0, mode: backgroundTimerMode, countdownTime: backgroundCountdownTime });
      navView.webContents.send('game-click-timer-tick', 0);
      navView.webContents.send('afk-hover-paused');
    }

    updateWindowTitleWithTimer(true, 0, 'afk', 90);
  }

  // ── Hover IDLE - mouse stopped moving inside canvas: reset to 1:30 and START ─
  function idleInCanvas() {
    if (!afkGameClick || !afkHover) return;
    stopAlertSound();

    // Whether paused or not, restart timers fresh from 0
    if (gameClickTimerInterval) clearInterval(gameClickTimerInterval);
    gameClickTimerSeconds = 0;
    gameClickAlertTriggeredInCycle = false;
    gameClickTimerRunning = true;
    armGameClickTimer();

    if (backgroundTimerInterval) clearInterval(backgroundTimerInterval);
    backgroundTimerSeconds = 0;
    backgroundAlertTriggered = false;
    backgroundTimerStartTime = Date.now();
    if (backgroundTimerRunning) {
      backgroundTimerInterval = setInterval(tickBackgroundTimer, 1000);
    }

    hoverPaused = false;
    console.log('hover: cursor IDLE in game view - timers reset & started from 1:30');

    if (navView && navView.webContents) {
      navView.webContents.send('background-timer-tick', { seconds: 0, mode: backgroundTimerMode, countdownTime: backgroundCountdownTime });
      navView.webContents.send('game-click-timer-tick', 0);
      navView.webContents.send('afk-hover-resumed');
    }

    updateWindowTitleWithTimer(true, 0, 'afk', 90);
  }

  // ── Hover LEAVE - mouse left canvas: reset to 1:30 and START countdown ─────
  function resumeTimerFromHover() {
    if (!afkGameClick || !afkHover) return;
    stopAlertSound();
    hoverPaused = false;

    // Reset & restart both timers from 0
    if (gameClickTimerInterval) clearInterval(gameClickTimerInterval);
    gameClickTimerSeconds = 0;
    gameClickAlertTriggeredInCycle = false;
    gameClickTimerRunning = true;
    armGameClickTimer();

    if (backgroundTimerInterval) clearInterval(backgroundTimerInterval);
    backgroundTimerSeconds = 0;
    backgroundAlertTriggered = false;
    backgroundTimerStartTime = Date.now();
    if (backgroundTimerRunning) {
      backgroundTimerInterval = setInterval(tickBackgroundTimer, 1000);
    }

    console.log('hover: cursor LEFT game view - timers reset & started from 1:30');

    if (navView && navView.webContents) {
      navView.webContents.send('background-timer-tick', { seconds: 0, mode: backgroundTimerMode, countdownTime: backgroundCountdownTime });
      navView.webContents.send('game-click-timer-tick', 0);
      navView.webContents.send('afk-hover-resumed');
    }

    updateWindowTitleWithTimer(true, 0, 'afk', 90);
  }

  function triggerGameClickAlert() {
    console.log('Game-click alert triggered - soundAlert:', soundAlert);
    if (!soundAlert) return;
    if (customSoundPath && customSoundPath.trim() !== '') { playCustomAlertSound(customSoundPath); return; }
    playDefaultPackagedSound();
  }

  function stopAlertSound() {
    if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('stop-alert-sound');
    }
    if (navView && navView.webContents && !navView.webContents.isDestroyed()) {
      navView.webContents.send('stop-alert-sound');
    }
  }

  function playDefaultPackagedSound() {
    if (defaultPackagedSoundPath && fs.existsSync(defaultPackagedSoundPath)) {
      if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('play-alert-sound', { customSoundPath: defaultPackagedSoundPath, soundVolume });
        console.log('Sent default packaged sound to renderer:', defaultPackagedSoundPath);
        return;
      }
    }
    console.log('Default packaged sound not available, falling back to beep');
    playDefaultBeep();
  }

  function playCustomAlertSound(filePath, volume = null) {
    try {
      if (!fs.existsSync(filePath)) { console.log('Custom sound file not found:', filePath); return; }
      const useVolume = volume !== null ? volume : soundVolume;
      if (mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('play-alert-sound', { customSoundPath: filePath, soundVolume: useVolume });
      }
    } catch (e) { console.log('Error sending custom alert sound:', e); }
  }

  function playAudioFile(filePath) {
    try {
      const { exec, execFile } = require('child_process');
      if (!fs.existsSync(filePath)) { playDefaultBeep(); return; }
      if (process.platform === 'win32') {
        const psCommand = `Add-Type -AssemblyName presentationCore; $mp = New-Object System.Windows.Media.MediaPlayer; $mp.Volume = ${soundVolume / 100}; $mp.Open([System.Uri]"${filePath.replace(/\\/g, '\\\\')}"); $mp.Play(); Start-Sleep -Seconds 5`;
        exec(`powershell -ExecutionPolicy Bypass -Command "${psCommand}"`, { windowsHide: true }, (err) => {
          if (err) {
            const ps2 = `(New-Object Media.SoundPlayer '${filePath.replace(/'/g, "''")}').PlaySync()`;
            exec(`powershell -ExecutionPolicy Bypass -Command "${ps2}"`, { windowsHide: true }, (err2) => { if (err2) playDefaultBeep(); });
          }
        });
      } else if (process.platform === 'darwin') {
        require('child_process').execFile('afplay', [filePath], (err) => { if (err) playDefaultBeep(); });
      } else {
        require('child_process').execFile('paplay', [filePath], (err) => {
          if (err) require('child_process').execFile('ffplay', ['-nodisp', '-autoexit', filePath], (err2) => { if (err2) playDefaultBeep(); });
        });
      }
    } catch (e) { playDefaultBeep(); }
  }

  function playDefaultBeep() {
    try {
      const { execFile } = require('child_process');
      if (process.platform === 'win32') {
        execFile('powershell.exe', ['-NoProfile', '-Command', '[console]::beep(1000,300)'], { windowsHide: true }, (err) => {
          if (err) execFile('powershell.exe', ['-NoProfile', '-Command', '[System.Media.SystemSounds]::Asterisk.Play()'], { windowsHide: true });
        });
      } else if (process.platform === 'darwin') {
        execFile('afplay', ['/System/Library/Sounds/Ping.aiff']);
      } else {
        execFile('paplay', ['/usr/share/sounds/freedesktop/stereo/complete.oga'], (err) => { if (err) execFile('beep', []); });
      }
    } catch (e) { console.log('Error playing default beep:', e); }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // UNIFIED BACKGROUND TIMER
  // This timer drives the stopwatch panel AND the titlebar.
  // Because tickBackgroundTimer() owns the titlebar update, the panel and
  // titlebar are guaranteed to show the exact same value at all times.
  // ══════════════════════════════════════════════════════════════════════════════

  function startBackgroundTimer(mode, initialSeconds = 0, countdownTime = 90, autoLoop = false) {
    stopBackgroundTimer();
    backgroundTimerMode = mode;
    backgroundTimerSeconds = initialSeconds;
    backgroundCountdownTime = countdownTime;
    backgroundAutoLoop = autoLoop;
    backgroundTimerRunning = true;
    backgroundAlertTriggered = false;
    backgroundTimerStartTime = Date.now() - (initialSeconds * 1000);
    console.log('Starting background timer:', { mode, initialSeconds, countdownTime, autoLoop });
    updateWindowTitleWithTimer(true, backgroundTimerSeconds, backgroundTimerMode, backgroundCountdownTime);
    backgroundTimerInterval = setInterval(tickBackgroundTimer, 1000);
  }

  function tickBackgroundTimer() {
    const elapsed = Math.floor((Date.now() - backgroundTimerStartTime) / 1000);
    if (elapsed <= backgroundTimerSeconds) return;
    backgroundTimerSeconds = elapsed;

    if (navView && navView.webContents) {
      navView.webContents.send('background-timer-tick', {
        seconds: backgroundTimerSeconds,
        mode: backgroundTimerMode,
        countdownTime: backgroundCountdownTime
      });
    }

    // Background timer owns the titlebar - 1:1 sync with stopwatch panel guaranteed
    updateWindowTitleWithTimer(backgroundTimerRunning, backgroundTimerSeconds, backgroundTimerMode, backgroundCountdownTime);

    if (backgroundTimerMode === 'afk') {
      // When AFK timer reaches zero (90 seconds), cancel adventure capture
      if (backgroundTimerSeconds >= 90 && adventureCaptureTimer) {
        clearTimeout(adventureCaptureTimer);
        adventureCaptureTimer = null;
        console.log('AFK timer reached 0:00 - cancelling pending adventure capture');
      }
      const thresholdTime = 90 - alertThreshold;
      if (!backgroundAlertTriggered && backgroundTimerSeconds >= thresholdTime) {
        backgroundAlertTriggered = true;
        console.log('AFK background timer reached threshold, alerting');
        triggerBackgroundAlert();
      }
      // AFK mode: continues counting past 90 for negative display - no auto-loop

    } else if (backgroundTimerMode === 'countdown') {
      const remaining = backgroundCountdownTime - backgroundTimerSeconds;
      const thresholdTime = backgroundCountdownTime - alertThreshold;
      if (!backgroundAlertTriggered && backgroundTimerSeconds >= thresholdTime && remaining > 0) {
        backgroundAlertTriggered = true;
        console.log('Countdown background timer reached threshold, alerting');
        triggerBackgroundAlert();
      }
      if (backgroundTimerSeconds >= backgroundCountdownTime) {
        if (backgroundAutoLoop) {
          backgroundTimerSeconds = 0;
          backgroundTimerStartTime = Date.now();
          backgroundAlertTriggered = false;
          console.log('Countdown background timer looping');
        } else {
          console.log('Countdown background timer finished');
        }
      }

    } else if (backgroundTimerMode === 'stopwatch') {
      // Stopwatch mode: just counts up, no alerts
    }
  }

  function stopBackgroundTimer() {
    if (backgroundTimerInterval) { clearInterval(backgroundTimerInterval); backgroundTimerInterval = null; }
    backgroundTimerRunning = false;
    backgroundTimerStartTime = null;
    console.log('Background timer stopped');
    updateWindowTitleWithTimer(false, 0, backgroundTimerMode, backgroundCountdownTime);
  }

  function pauseBackgroundTimer() {
    if (backgroundTimerInterval) { clearInterval(backgroundTimerInterval); backgroundTimerInterval = null; }
    console.log('Background timer paused at', backgroundTimerSeconds, 'seconds');
    updateWindowTitleWithTimer(false, backgroundTimerSeconds, backgroundTimerMode, backgroundCountdownTime);
  }

  function resumeBackgroundTimer() {
    if (!backgroundTimerRunning) return;
    if (backgroundTimerInterval) return;
    backgroundTimerStartTime = Date.now() - (backgroundTimerSeconds * 1000);
    backgroundTimerInterval = setInterval(tickBackgroundTimer, 1000);
    console.log('Background timer resumed from', backgroundTimerSeconds, 'seconds');
    updateWindowTitleWithTimer(true, backgroundTimerSeconds, backgroundTimerMode, backgroundCountdownTime);
  }

  function resetBackgroundTimer() {
    backgroundTimerSeconds = 0;
    backgroundTimerStartTime = Date.now();
    backgroundAlertTriggered = false;
    console.log('Background timer reset to 0');
    if (navView && navView.webContents) {
      navView.webContents.send('background-timer-tick', { seconds: 0, mode: backgroundTimerMode, countdownTime: backgroundCountdownTime });
    }
    updateWindowTitleWithTimer(backgroundTimerRunning, 0, backgroundTimerMode, backgroundCountdownTime);
    // Stop alert sound when timer is reset
    stopAlertSound();
    // Resume adventure capture when timer is reset (for AFK mode)
    if (backgroundTimerMode === 'afk') {
      updateAdventureCapture();
    }
  }

  function getBackgroundTimerState() {
    return { running: backgroundTimerRunning, seconds: backgroundTimerSeconds, mode: backgroundTimerMode, countdownTime: backgroundCountdownTime, autoLoop: backgroundAutoLoop, alertThreshold };
  }

  function triggerBackgroundAlert() {
    console.log('Background alert triggered - soundAlert:', soundAlert, 'mode:', backgroundTimerMode);
    if (!soundAlert) return;
    if (customSoundPath && customSoundPath.trim() !== '') { playCustomAlertSound(customSoundPath, soundVolume); return; }
    playDefaultPackagedSound();
  }

  // IPC for unified background timer
  ipcMain.handle('get-background-timer-state', () => getBackgroundTimerState());
  ipcMain.on('start-background-timer', (event, data) => startBackgroundTimer(data.mode, data.initialSeconds || 0, data.countdownTime || 90, data.autoLoop || false));
  ipcMain.on('stop-background-timer', () => stopBackgroundTimer());
  ipcMain.on('pause-background-timer', () => pauseBackgroundTimer());
  ipcMain.on('resume-background-timer', () => resumeBackgroundTimer());
  ipcMain.on('reset-background-timer', () => resetBackgroundTimer());
  ipcMain.on('update-background-timer-settings', (event, data) => {
    if (data.countdownTime !== undefined) backgroundCountdownTime = data.countdownTime;
    if (data.autoLoop !== undefined) backgroundAutoLoop = data.autoLoop;
    if (data.alertThreshold !== undefined) alertThreshold = data.alertThreshold;
    console.log('Background timer settings updated:', data);
  });

  // ── Stopwatch panel legacy IPC ──────────────────────────────────────────────
  ipcMain.handle('get-game-click-timer-state', () => ({ running: gameClickTimerRunning, seconds: gameClickTimerSeconds, afkGameClick }));

  ipcMain.on('reset-game-click-timer', () => {
    if (gameClickTimerRunning) {
      gameClickTimerSeconds = 0;
      gameClickTimerStartTime = Date.now();
      gameClickAlertTriggeredInCycle = false;
      console.log('Game-click timer manually reset to 0');
      if (navView && navView.webContents) navView.webContents.send('game-click-timer-tick', 0);
      // Stop alert sound when timer is reset
      stopAlertSound();
    }
  });

  ipcMain.on('pause-game-click-timer', () => {
    if (gameClickTimerRunning && gameClickTimerInterval) {
      clearInterval(gameClickTimerInterval); gameClickTimerInterval = null;
      console.log('Game-click timer paused');
      if (!backgroundTimerRunning) updateWindowTitleWithTimer(true, gameClickTimerSeconds, 'afk', 90);
    }
  });

  ipcMain.on('resume-game-click-timer', () => {
    if (afkGameClick && !gameClickTimerInterval) {
      gameClickTimerRunning = true;
      armGameClickTimer();
      console.log('Game-click timer resumed');
      if (!backgroundTimerRunning) updateWindowTitleWithTimer(true, gameClickTimerSeconds, 'afk', 90);
    }
  });

  ipcMain.on('update-stopwatch-setting', (event, setting, value) => {
    console.log('ipcMain received update-stopwatch-setting', setting, value);
    if (setting === 'afkGameClick') {
      const newValue = !!value;
      if (newValue !== afkGameClick) {
        afkGameClick = newValue;
        console.log('afkGameClick changed to', afkGameClick);
        if (afkGameClick) {
          startGameClickTimer();
        } else {
          if (hoverPaused) hoverPaused = false;
          stopGameClickTimer();
        }
      }
    }
    if (setting === 'afkInputType') {
      afkInputType = (value === 'both') ? 'both' : 'click';
      console.log('afkInputType set to', afkInputType);
    }
    if (setting === 'alertThreshold') { alertThreshold = parseInt(value) || 10; console.log('alertThreshold set to', alertThreshold); }
    if (setting === 'soundAlert') { soundAlert = !!value; console.log('soundAlert set to', soundAlert); }
    if (setting === 'soundVolume') { soundVolume = parseInt(value) || 60; console.log('soundVolume set to', soundVolume); }
    if (setting === 'customSoundPath') { customSoundPath = value || ''; console.log('customSoundPath set to', customSoundPath); }
  });

  // ── Sound file IPC ──────────────────────────────────────────────────────────
  ipcMain.handle('copy-sound-file', async (event, buffer, destPath) => {
    try {
      const fsP = require('fs').promises;
      await fsP.mkdir(path.dirname(destPath), { recursive: true });
      await fsP.writeFile(destPath, buffer);
      console.log('Sound file written:', destPath); return true;
    } catch (e) { console.log('Error writing sound file:', e); return false; }
  });
  ipcMain.handle('list-sound-files', async (event, soundsDir) => {
    try {
      const fsP = require('fs').promises;
      await fsP.mkdir(soundsDir, { recursive: true });
      const files = await fsP.readdir(soundsDir);
      return files.filter(f => /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(f)).sort();
    } catch (e) { return []; }
  });
  ipcMain.handle('delete-sound-file', async (event, filePath) => {
    try { await require('fs').promises.unlink(filePath); return true; } catch (e) { return false; }
  });

  // ── Sound Manager window ────────────────────────────────────────────────────
  ipcMain.handle('open-sound-manager', async () => {
    if (soundManagerWindow && !soundManagerWindow.isDestroyed()) { soundManagerWindow.focus(); return; }
    const smBounds = appSettings.soundManagerWindow || { width: 450, height: 500 };
    soundManagerWindow = new BrowserWindow({
      width: smBounds.width || 450, height: smBounds.height || 500,
      x: smBounds.x != null ? smBounds.x : undefined, y: smBounds.y != null ? smBounds.y : undefined,
      autoHideMenuBar: true, webPreferences: { nodeIntegration: true, contextIsolation: false }, title: 'LostKit - Sound Manager'
    });
    soundManagerWindow.loadFile(path.join(__dirname, 'navitems/sound-manager.html'));
    applyAlwaysOnTop(soundManagerWindow);
    const saveSMBounds = () => {
      if (soundManagerWindow && !soundManagerWindow.isDestroyed() && !soundManagerWindow.isMinimized()) {
        const b = soundManagerWindow.getBounds();
        appSettings.soundManagerWindow = { width: b.width, height: b.height, x: b.x, y: b.y };
        saveSettingsDebounced();
      }
    };
    soundManagerWindow.on('resized', saveSMBounds); soundManagerWindow.on('moved', saveSMBounds);
    soundManagerWindow.on('closed', () => { soundManagerWindow = null; });
    return true;
  });

  ipcMain.handle('get-sounds-config', async () => {
    const soundsDir = path.join(process.env.APPDATA || path.join(process.env.HOME || process.env.USERPROFILE, '.config'), 'LostKit', 'sounds');
    let userVolume = 60, csp = '', sa = false;
    try {
      const configPath = path.join(process.env.APPDATA || process.env.HOME, '.lostkit-stopwatch-config.json');
      const config = JSON.parse(await require('fs').promises.readFile(configPath, 'utf8'));
      userVolume = config.soundVolume || 60; sa = config.soundAlert || false;
      if (config.customSoundFilename) csp = path.normalize(path.join(soundsDir, config.customSoundFilename));
    } catch (e) { console.log('Note: Using default config values'); }
    console.log('get-sounds-config returning:', { soundsDir, customSoundPath: csp, userVolume, soundAlert: sa });
    return { soundsDir, userVolume, customSoundPath: csp, soundAlert: sa };
  });

  ipcMain.on('select-sound', (event, soundPath) => { if (navView && navView.webContents) navView.webContents.send('sound-selected', soundPath); });
  ipcMain.handle('test-sound', async () => { console.log('Test sound requested'); triggerBackgroundAlert(); return true; });

  // ── Notes window ────────────────────────────────────────────────────────────
  ipcMain.handle('open-notes', async () => {
    if (notesWindow && !notesWindow.isDestroyed()) { notesWindow.focus(); return; }
    const notesBounds = appSettings.notesWindow || { width: 500, height: 600 };
    notesWindow = new BrowserWindow({
      width: notesBounds.width || 500, height: notesBounds.height || 600,
      x: notesBounds.x != null ? notesBounds.x : undefined, y: notesBounds.y != null ? notesBounds.y : undefined,
      minWidth: 350, minHeight: 300, autoHideMenuBar: true,
      webPreferences: { nodeIntegration: true, contextIsolation: false }, title: 'LostKit - Notes'
    });
    notesWindow.loadFile(path.join(__dirname, 'navitems/notes.html'));
    applyAlwaysOnTop(notesWindow);
    const saveNotesBounds = () => {
      if (notesWindow && !notesWindow.isDestroyed() && !notesWindow.isMinimized()) {
        const b = notesWindow.getBounds();
        appSettings.notesWindow = { width: b.width, height: b.height, x: b.x, y: b.y };
        saveSettingsDebounced();
      }
    };
    notesWindow.on('resized', saveNotesBounds); notesWindow.on('moved', saveNotesBounds);
    notesWindow.on('resize', () => { const [w, h] = notesWindow.getSize(); notesWindow.webContents.send('window-resized', { width: w, height: h }); });
    notesWindow.on('closed', () => { notesWindow = null; });
    return true;
  });
  ipcMain.on('save-notes-window-size', async (event, { width, height }) => {
    try {
      const notesPath = path.join(process.env.APPDATA || process.env.HOME, '.lostkit-notes.json');
      const fsP = require('fs').promises;
      let data = {};
      try { data = JSON.parse(await fsP.readFile(notesPath, 'utf8')); } catch (e) {}
      data.windowWidth = width; data.windowHeight = height;
      await fsP.writeFile(notesPath, JSON.stringify(data, null, 2));
    } catch (e) { console.log('Error saving notes window size:', e); }
  });
  ipcMain.handle('load-notes', async () => {
    try { return JSON.parse(await require('fs').promises.readFile(path.join(process.env.APPDATA || process.env.HOME, '.lostkit-notes.json'), 'utf8')); }
    catch (e) { return {}; }
  });
  ipcMain.on('save-notes', async (event, notes) => {
    try { await require('fs').promises.writeFile(path.join(process.env.APPDATA || process.env.HOME, '.lostkit-notes.json'), JSON.stringify(notes, null, 2)); }
    catch (e) { console.log('Error saving notes:', e); }
  });

  // ── Game-view input IPC ─────────────────────────────────────────────────────
  // mouse click - always resets when afkGameClick is enabled
  ipcMain.on('game-view-mouse-clicked', () => {
    if (!afkGameClick) return;
    resetGameClickTimer();
    if (navView && navView.webContents) navView.webContents.send('afk-game-click-reset');
  });

  // key press - only resets when input type is 'both'
  ipcMain.on('game-view-key-pressed', () => {
    if (!afkGameClick || afkInputType !== 'both') return;
    resetGameClickTimer();
    if (navView && navView.webContents) navView.webContents.send('afk-game-click-reset');
  });

  // ── Zoom IPC ────────────────────────────────────────────────────────────────
  ipcMain.on('zoom-wheel', (event, data) => {
    try {
      const senderWC = event.sender;
      // External windows persist zoom per URL in their own handler; letting
      // this one run too would apply every wheel tick twice.
      if (senderWC._lkExternalPage) return;
      const pv = primaryViews.find(p => p.view && p.view.webContents && p.view.webContents.id === senderWC.id);
      const targetWC = pv ? pv.view.webContents : senderWC;
      if (!data || typeof data.deltaY !== 'number') return;
      const newFactor = getNextZoomStep(targetWC.getZoomFactor(), data.deltaY < 0);
      targetWC.setZoomFactor(newFactor);
      if (pv && pv.id === 'main') { appSettings.zoomFactor = newFactor; saveSettingsDebounced(); }
      if (pv && pv.id !== 'main') {
        const tab = tabs.find(t => t.id === pv.id);
        if (tab && tab.url) { if (!appSettings.tabZoom) appSettings.tabZoom = {}; appSettings.tabZoom[tab.url] = newFactor; saveSettingsDebounced(); }
      }
      if (chatView && senderWC.id === chatView.webContents.id) { appSettings.chatZoom = newFactor; saveSettingsDebounced(); }
      log.info('Zoom applied:', Math.round(newFactor * 100) + '%');
    } catch (e) { log.error('zoom-wheel handler error:', e); }
  });

  // ── Chat IPC ────────────────────────────────────────────────────────────────
  ipcMain.on('toggle-chat', () => {
    animateChatToggle(!chatVisible);
  });

  // ── Tabs ────────────────────────────────────────────────────────────────────
  let tabIdCounter = 0;

  // ── Tab navigation ────────────────────────────────────────────────────────
  // Toolbar buttons, thumb buttons and keys all land here, and the game view is
  // refused. This is the check that holds even if a renderer misbehaves.
  function navHistory(wc) {
    return wc.navigationHistory || {
      canGoBack: () => wc.canGoBack(), canGoForward: () => wc.canGoForward(),
      goBack: () => wc.goBack(), goForward: () => wc.goForward()
    };
  }

  // The keys a browser would treat as navigation. Read in one place so tabs and
  // torn-off windows agree, and so the game view's blocklist has a counterpart.
  function navKeyAction(input) {
    if (!input || input.type !== 'keyDown') return null;
    const ctrl = input.control || input.meta;
    if (input.key === 'F5' || (ctrl && (input.key === 'r' || input.key === 'R'))) return 'reload';
    if (input.alt && input.key === 'ArrowLeft') return 'back';
    if (input.alt && input.key === 'ArrowRight') return 'forward';
    if (input.key === 'BrowserBack') return 'back';
    if (input.key === 'BrowserForward') return 'forward';
    if (input.key === 'BrowserRefresh') return 'reload';
    return null;
  }

  function navigateTab(id, action) {
    if (id === 'main') return;                       // the game view. never.
    const pv = primaryViews.find(p => p.id === id);
    if (!pv || !pv.view.webContents || pv.view.webContents.isDestroyed()) return;
    navigateWebContents(pv.view.webContents, action);
  }

  // ── Toolbars ──────────────────────────────────────────────────────────────
  // Tabs and torn-off windows share one toolbar implementation. The target page
  // comes from which toolbar sent the message, never from the message itself.
  // The game view is never wired to one.
  function navigateWebContents(wc, action) {
    if (!wc || wc.isDestroyed()) return;
    const hist = navHistory(wc);
    if (action === 'back' && hist.canGoBack()) hist.goBack();
    else if (action === 'forward' && hist.canGoForward()) hist.goForward();
    else if (action === 'reload') wc.reload();
  }

  // ── Find in page ──────────────────────────────────────────────────────────
  // The box lives in the toolbar, so only views with one can be searched. The
  // key is read per view, not registered globally, so Ctrl+F while playing
  // reaches the game untouched.
  function isFindKey(input) {
    if (!input || input.type !== 'keyDown') return false;
    const ctrl = input.control || input.meta;
    return (ctrl && (input.key === 'f' || input.key === 'F')) || input.key === 'F3';
  }

  function openFindBar(toolbarView) {
    if (!toolbarView || toolbarView.webContents.isDestroyed()) return;
    toolbarView.webContents.send('find-open');
    toolbarView.webContents.focus();     // so the box can be typed into at once
  }

  // Reports matches back to the toolbar that asked, and closes the box when the
  // page changes underneath it.
  function wireFind(pageView, toolbarView) {
    pageView.webContents.on('found-in-page', (event, result) => {
      if (toolbarView.webContents.isDestroyed()) return;
      toolbarView.webContents.send('find-result', {
        matches: result.matches,
        active: result.activeMatchOrdinal
      });
    });
    pageView.webContents.on('did-navigate', () => {
      if (!toolbarView.webContents.isDestroyed()) toolbarView.webContents.send('find-reset');
    });
  }

  // Electron's `findNext` means "continues the running session", not "next
  // match":
  //   newly typed query  -> findNext:true   (start a session)
  //   step through hits  -> findNext:false  (continue it)
  // Inverted, typing finds nothing until Enter. The wire field is `advance`.
  ipcMain.on('find-query', (event, opts) => {
    const getPageWC = toolbarTargets.get(event.sender.id);
    const wc = getPageWC && getPageWC();
    if (!wc || wc.isDestroyed() || !opts || !opts.text) return;
    wc.findInPage(String(opts.text), {
      findNext: !opts.advance,          // a fresh query opens a new session
      forward: opts.forward !== false
    });
  });

  ipcMain.on('find-stop', (event) => {
    const getPageWC = toolbarTargets.get(event.sender.id);
    const wc = getPageWC && getPageWC();
    if (wc && !wc.isDestroyed()) wc.stopFindInPage('clearSelection');
  });

  ipcMain.on('find-close', (event) => {
    const getPageWC = toolbarTargets.get(event.sender.id);
    const wc = getPageWC && getPageWC();
    if (!wc || wc.isDestroyed()) return;
    wc.stopFindInPage('clearSelection');
    wc.focus();                          // hand the keyboard back to the page
  });

  function createToolbarView() {
    const view = new WebContentsView({ webPreferences: { nodeIntegration: true, contextIsolation: false } });
    view.webContents.loadFile(path.join(__dirname, 'navitems/window-toolbar.html'));
    return view;
  }

  // getPageWC is a lookup, not a reference, so the wiring survives the page view
  // being replaced. Returns the repaint function for the caller to hook up.
  function wireToolbar(toolbarView, getPageWC, fallbackTitle, getExtra) {
    toolbarTargets.set(toolbarView.webContents.id, getPageWC);
    const push = () => {
      if (toolbarView.webContents.isDestroyed()) return;
      const wc = getPageWC();
      if (!wc || wc.isDestroyed()) return;
      const hist = navHistory(wc);
      toolbarView.webContents.send('window-nav-state', Object.assign({
        title: wc.getTitle() || fallbackTitle || '',
        canGoBack: hist.canGoBack(),
        canGoForward: hist.canGoForward(),
        loading: wc.isLoading()
      }, getExtra ? getExtra() : null));
    };
    toolbarView.webContents.on('did-finish-load', () => {
      applyFontToView(toolbarView.webContents, true);
      push();
    });
    return push;
  }

  function releaseToolbar(toolbarView) {
    if (!toolbarView) return;
    try { toolbarTargets.delete(toolbarView.webContents.id); } catch (e) {}
  }

  // ── Split view ──
  // Press once to put another tab beside this one, again to close it. Every
  // refusal is reported to the toolbar rather than failing silently.
  function toolTabsBesides(excludeId) {
    return tabs.filter(t => t.id !== 'main' && t.id !== excludeId &&
                            primaryViews.some(p => p.id === t.id));
  }

  function toolbarSay(message) {
    const pv = primaryViews.find(p => p.id === currentTab);
    if (pv && pv.toolbar && !pv.toolbar.webContents.isDestroyed())
      pv.toolbar.webContents.send('toolbar-message', message);
  }

  // Widens the window enough for two panes, recording by how much so it can be
  // handed back when the split ends. False if the display is too small.
  function makeRoomForSplit() {
    const [contentWidth] = mainWindow.getContentSize();
    const navWidth = navPanelMode === 'collapsed' ? 0
      : (navPanelMode === 'strip' ? NAV_PANEL_STRIP_WIDTH : NAV_PANEL_WIDTH);
    const needed = SPLIT_MIN_PANE * 2 + SPLIT_DIVIDER;
    const deficit = needed - (contentWidth - navWidth);
    if (deficit <= 0) return true;

    const bounds = mainWindow.getBounds();
    const { screen } = require('electron');
    const wa = screen.getDisplayMatching(bounds).workArea;
    const newWidth = bounds.width + deficit;
    if (newWidth > wa.width) return false;

    let newX = bounds.x;
    if (newX + newWidth > wa.x + wa.width) newX = Math.max(wa.x, wa.x + wa.width - newWidth);
    try { mainWindow.setBounds({ x: newX, y: bounds.y, width: newWidth, height: bounds.height }); }
    catch (e) { return false; }
    splitGrewWindowBy = deficit;
    return true;
  }

  function giveBackSplitWidth() {
    if (!splitGrewWindowBy) return;
    const b = mainWindow.getBounds();
    try { mainWindow.setBounds({ x: b.x, y: b.y, width: Math.max(800, b.width - splitGrewWindowBy), height: b.height }); }
    catch (e) {}
    splitGrewWindowBy = 0;
  }

  function endSplit() {
    splitTabId = null;
    splitOtherId = null;
    splitLocked = false;
    splitLockedPair = null;
    giveBackSplitWidth();
    updateBounds();
    broadcastToolbarStates();
    persistTabs();
    log.info('Split view: off');
  }

  function startSplitWith(partnerId) {
    if (!makeRoomForSplit()) {
      toolbarSay('Not enough screen width for two panes');
      return;
    }
    splitTabId = partnerId;
    splitOtherId = currentTab;      // the tab the split was started from
    updateBounds();
    broadcastToolbarStates();
    persistTabs();
    log.info('Split view: ' + currentTab + ' beside ' + partnerId);
  }

  ipcMain.on('toggle-split', () => {
    if (appSettings.splitViewEnabled === false) return;
    if (splitTabId) { endSplit(); return; }
    if (currentTab === 'main') { toolbarSay('The game tab is never split'); return; }

    // The game can be a partner. It takes the left pane and stays there while
    // you move between tools. Its own tab still has no toolbar.
    const gameTab = tabs.find(t => t.id === 'main');
    const candidates = toolTabsBesides(currentTab);
    if (gameTab) candidates.unshift({ id: 'main', title: 'Game' });

    if (!candidates.length) { toolbarSay('Open another tool tab to split with'); return; }
    if (candidates.length === 1) { startSplitWith(candidates[0].id); return; }

    Menu.buildFromTemplate(
      candidates.map(t => ({ label: t.title || t.url, click: () => startSplitWith(t.id) }))
    ).popup({ window: mainWindow });
  });

  // ── Split view ──
  // Seam drag. splitPanes() clamps the ratio so a pane cannot collapse.
  // ── Split view ──
  // Freezes the pair on screen. Locked, a third tab opens on its own and the
  // pair waits. The split button still closes it.
  ipcMain.on('toggle-split-lock', () => {
    if (!splitTabId) return;
    if (splitLocked) {
      splitLocked = false;
      splitLockedPair = null;
      log.info('Split view: unlocked');
    } else {
      const pair = splitPairIds();
      if (!pair) { toolbarSay('Nothing to lock while the split is not showing'); return; }
      splitLockedPair = { leftId: pair.leftId, rightId: pair.rightId };
      splitLocked = true;
      log.info('Split view: locked ' + pair.leftId + ' | ' + pair.rightId);
    }
    updateBounds();
    broadcastToolbarStates();
    persistTabs();
  });

  ipcMain.on('set-split-ratio', (event, ratio) => {
    if (typeof ratio !== 'number' || !isFinite(ratio)) return;
    appSettings.splitRatio = Math.min(0.9, Math.max(0.1, ratio));
    updateBounds();
  });

  ipcMain.on('commit-split-ratio', () => saveSettingsDebounced());

  function broadcastToolbarStates() {
    primaryViews.forEach(pv => { if (pv.pushToolbar) pv.pushToolbar(); });
  }

  ipcMain.on('window-nav', (event, action) => {
    const getPageWC = toolbarTargets.get(event.sender.id);
    if (!getPageWC) return;
    navigateWebContents(getPageWC(), action);
  });

  // Creates a tab and its view. Returns the new (or existing) tab id.
  // opts.activate - false leaves the current tab in front, used when restoring
  // a saved set of tabs where only one of them should end up active.
  function createTab(url, customTitle, iconPath, opts) {
    const { activate = true } = opts || {};

    const existingId = tabByUrl.get(url);
    if (existingId) {
      const pv = primaryViews.find(pv => pv.id === existingId);
      if (pv) { if (activate) switchToTab(existingId); return existingId; }
      tabByUrl.delete(url);
    }

    const id = 'tab-' + (++tabIdCounter);
    const title = customTitle || url;
    const icon = resolveAssetIcon(iconPath) ? iconPath : null;
    tabs.push({ id, url, title, icon });
    tabByUrl.set(url, id);

    const newView = new WebContentsView({ webPreferences: { webSecurity: false, preload: path.join(__dirname, 'preload-zoom-shared.js') } });
    newView.webContents.loadURL(url);
    newView.webContents.on('did-finish-load', () => scheduleWindowManagerReflow());
    // Mini-browser keys for this tab. The game view gets the exact opposite
    // treatment: there these same keys are swallowed and nothing happens.
    newView.webContents.on('before-input-event', (event, input) => {
      if (isFindKey(input)) { event.preventDefault(); openFindBar(toolbarView); return; }
      const action = navKeyAction(input);
      if (!action) return;
      event.preventDefault();
      navigateTab(id, action);
    });
    newView.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
    mainWindow.contentView.addChildView(newView);

    // Its own toolbar above the page, the same one a torn-off window gets. The
    // game view is the one primary view built without one.
    const toolbarView = createToolbarView();
    mainWindow.contentView.addChildView(toolbarView);
    const pushToolbarState = wireToolbar(
      toolbarView,
      () => {
        const pv = primaryViews.find(p => p.id === id);
        return pv && pv.view.webContents && !pv.view.webContents.isDestroyed() ? pv.view.webContents : null;
      },
      title,
      // ── Split view ── the button is simply on or off.
      () => ({
        canPin: appSettings.splitViewEnabled !== false,
        pinned: !!splitTabId,
        locked: splitLocked
      })
    );
    ['did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading', 'page-title-updated']
      .forEach(ev => newView.webContents.on(ev, pushToolbarState));
    wireFind(newView, toolbarView);

    primaryViews.push({ id, view: newView, toolbar: toolbarView, pushToolbar: pushToolbarState });
    if (appSettings.tabZoom && appSettings.tabZoom[url]) newView.webContents.once('did-finish-load', () => { try { newView.webContents.setZoomFactor(appSettings.tabZoom[url]); } catch (e) {} });
    mainWindow.webContents.send('add-tab', id, title, icon);
    if (!customTitle) newView.webContents.on('page-title-updated', (event, pageTitle) => {
      const t = tabs.find(t => t.id === id);
      if (t) t.title = pageTitle;
      mainWindow.webContents.send('update-tab-title', id, pageTitle);
      persistTabs();
    });
    // A freshly added child view sits on top, so hide it unless it's taking focus.
    if (activate) switchToTab(id);
    else { newView.setVisible(false); toolbarView.setVisible(false); }
    updateBounds();
    persistTabs();
    return id;
  }

  // Snapshot of the tab strip for the next launch. Tab ids are per-run, so the
  // active tab is stored as an index into openTabs (or 'main' for the game view).
  function persistTabs() {
    const open = tabs.filter(t => t.id !== 'main');
    appSettings.openTabs = open.map(t => ({ url: t.url, title: t.title, icon: t.icon || null }));
    const idx = open.findIndex(t => t.id === currentTab);
    appSettings.activeTab = idx === -1 ? 'main' : idx;

    // Record the pair for next launch. Tab ids are fresh each run, so store an
    // index into openTabs (or 'main'), as activeTab does.
    const ref = id => {
      if (!id) return null;
      if (id === 'main') return 'main';
      const at = open.findIndex(t => t.id === id);
      return at === -1 ? null : at;
    };
    appSettings.splitView = splitTabId ? {
      partner:     ref(splitTabId),
      other:       ref(splitOtherId),
      locked:      splitLocked,
      lockedLeft:  splitLocked && splitLockedPair ? ref(splitLockedPair.leftId) : null,
      lockedRight: splitLocked && splitLockedPair ? ref(splitLockedPair.rightId) : null
    } : null;

    saveSettingsDebounced();
  }

  let tabsRestored = false;
  function restoreTabs() {
    if (tabsRestored) return;
    tabsRestored = true;
    const saved = Array.isArray(appSettings.openTabs) ? appSettings.openTabs : [];
    // Read the active tab up front: creating each tab calls persistTabs(),
    // which rewrites appSettings.activeTab from the still-unchanged current tab.
    const savedActive = appSettings.activeTab;
    const savedSplit = appSettings.splitView;   // same reason: createTab rewrites it
    const restoredIds = [];
    saved.forEach(t => {
      if (!t || !t.url) return;
      restoredIds.push(createTab(t.url, t.title, t.icon, { activate: false }));
    });
    const activeId = (typeof savedActive === 'number' && restoredIds[savedActive]) ? restoredIds[savedActive] : 'main';
    switchToTab(activeId);
    if (restoredIds.length) log.info(`Restored ${restoredIds.length} tab(s), active: ${activeId}`);
    restoreSplitView(savedSplit, restoredIds);
  }

  // Puts back last session's pair. Every saved reference must resolve to a tab
  // that came back; otherwise no split, rather than a half-formed one.
  function restoreSplitView(saved, restoredIds) {
    if (!saved || appSettings.splitViewEnabled === false) return;
    const idFor = ref => {
      if (ref === 'main') return 'main';
      if (typeof ref !== 'number') return null;
      return restoredIds[ref] || null;
    };

    const partner = idFor(saved.partner);
    if (!partner) return;
    splitTabId = partner;
    splitOtherId = idFor(saved.other);

    if (saved.locked) {
      const left = idFor(saved.lockedLeft);
      const right = idFor(saved.lockedRight);
      if (left && right) {
        splitLocked = true;
        splitLockedPair = { leftId: left, rightId: right };
      }
    }

    // The borrowed width was given back on close, so take it again or the
    // restored split will not fit.
    if (splitPairIds()) makeRoomForSplit();
    updateBounds();
    broadcastToolbarStates();
    log.info('Restored split view: ' + splitTabId + (splitLocked ? ' (locked)' : ''));
  }

  ipcMain.on('add-tab', (event, url, customTitle, iconPath) => { createTab(url, customTitle, iconPath); });

  // Tears a tab down (view + bookkeeping) and returns its data, or null when the
  // id is unknown or refers to the unclosable game view tab.
  function removeTab(id) {
    if (id === 'main') return null;
    const removedTab = tabs.find(t => t.id === id);
    if (!removedTab) { mainWindow.webContents.send('close-tab', id); return null; }
    tabs = tabs.filter(t => t.id !== id);
    const index = primaryViews.findIndex(pv => pv.id === id);
    if (index !== -1) {
      if (tabByUrl.get(removedTab.url) === id) tabByUrl.delete(removedTab.url);
      mainWindow.contentView.removeChildView(primaryViews[index].view);
      const removedToolbar = primaryViews[index].toolbar;
      if (removedToolbar) {
        releaseToolbar(removedToolbar);
        mainWindow.contentView.removeChildView(removedToolbar);
        try { removedToolbar.webContents.close(); } catch (e) {}
      }
      primaryViews.splice(index, 1);
      // ── Split view ── that pane's tab is gone, so the split goes with it.
      const wasPaired = splitTabId === id ||
        (splitLockedPair && (splitLockedPair.leftId === id || splitLockedPair.rightId === id));
      const wasFollowing = splitOtherId === id;
      if (wasPaired) {
        splitTabId = null;
        splitOtherId = null;
        splitLocked = false;
        splitLockedPair = null;
        giveBackSplitWidth();
      } else if (wasFollowing) {
        splitOtherId = null;   // that side is empty; the next tab you open fills it
      }
    }
    mainWindow.webContents.send('close-tab', id);
    updateBounds();
    if (currentTab === id) switchToTab('main');
    persistTabs();
    return removedTab;
  }

  function switchToTab(id) {
    currentTab = id;
    // ── Split view ── moving to any tab other than the pinned one puts that tab
    // in the following pane, and remembers it for when you click the pinned tab.
    if (splitTabId && id !== splitTabId && id !== 'main') splitOtherId = id;
    // updateBounds() decides what is visible: this tab, and the pinned one too
    // when a split is on and there is room for it.
    updateBounds();
    broadcastToolbarStates();
    mainWindow.webContents.send('update-active', id);
    scheduleWindowManagerReflow();
    persistTabs();
  }

  ipcMain.on('close-tab', (event, id) => { removeTab(id); });

  ipcMain.on('switch-tab', (event, id) => switchToTab(id));

  // Chrome-style drag reorder: the tab strip owns the visual order, this keeps
  // the main-process list in the same order so both sides agree.
  ipcMain.on('reorder-tabs', (event, orderedIds) => {
    if (!Array.isArray(orderedIds)) return;
    const byId = new Map(tabs.map(t => [t.id, t]));
    const reordered = [];
    orderedIds.forEach(id => { const t = byId.get(id); if (t) { reordered.push(t); byId.delete(id); } });
    byId.forEach(t => reordered.push(t)); // anything the renderer didn't mention keeps its place at the end
    // The game view tab is pinned first no matter what order arrives.
    const mainIndex = reordered.findIndex(t => t.id === 'main');
    if (mainIndex > 0) reordered.unshift(reordered.splice(mainIndex, 1)[0]);
    tabs = reordered;
    persistTabs();
  });

  // Dragged out of the tab strip → close the tab and reopen it as its own window
  // at the cursor, carrying the tool icon across.
  ipcMain.on('detach-tab', (event, id, screenX, screenY) => {
    const tab = removeTab(id);
    if (!tab) return;
    openExternalWindow(tab.url, tab.title, tab.icon, { screenX, screenY });
  });

  ipcMain.on('switch-nav-view', (event, view) => {
    currentNavViewName = view || 'nav';

    const builtInToolViews = new Set(['worldswitcher', 'hiscores', 'stopwatch', 'youtube', 'watchlist']);
    if (builtInToolViews.has(view) && navPanelMode === 'strip') {
      // Temporarily expand the panel AND grow the window to the right so
      // the primary view (game canvas) does not shrink.
      navPanelPrevMode = 'strip';
      const bounds = mainWindow.getBounds();
      const { screen } = require('electron');
      const display = screen.getDisplayMatching(bounds);
      const delta = NAV_PANEL_WIDTH - NAV_PANEL_STRIP_WIDTH;
      const newWidth = bounds.width + delta;
      let newX = bounds.x;
      const newRight = bounds.x + newWidth;
      const displayRight = display.workArea.x + display.workArea.width;
      if (newRight > displayRight) {
        // Shift left as needed but prefer to expand to the right
        newX = Math.max(display.workArea.x, bounds.x - (newRight - displayRight));
      }
      try { mainWindow.setBounds({ width: newWidth, height: bounds.height, x: newX, y: bounds.y }); } catch (e) {}
      navPanelMode = 'expanded';
      scheduleWindowManagerReflow();
    } else if (view === 'nav' && navPanelPrevMode === 'strip') {
      // Revert window width back to strip size (shrink from expanded)
      const bounds = mainWindow.getBounds();
      const { screen } = require('electron');
      const display = screen.getDisplayMatching(bounds);
      const delta = NAV_PANEL_WIDTH - NAV_PANEL_STRIP_WIDTH;
      const newWidth = Math.max(800, bounds.width - delta);
      let newX = bounds.x;
      const newRight = newX + newWidth;
      const displayRight = display.workArea.x + display.workArea.width;
      if (newRight > displayRight) {
        newX = Math.max(display.workArea.x, bounds.x - (newRight - displayRight));
      }
      try { mainWindow.setBounds({ width: newWidth, height: bounds.height, x: newX, y: bounds.y }); } catch (e) {}
      navPanelMode = 'strip';
      navPanelPrevMode = null;
      scheduleWindowManagerReflow();
    }

    switch (view) {
      case 'worldswitcher': navView.webContents.loadFile(path.join(__dirname, '/navitems/worldswitcher.html')); break;
      case 'hiscores':      navView.webContents.loadFile(path.join(__dirname, '/navitems/hiscores.html')); break;
      case 'stopwatch':     navView.webContents.loadFile(path.join(__dirname, '/navitems/stopwatch.html')); break;
      case 'watchlist':     navView.webContents.loadFile(path.join(__dirname, '/navitems/watchlist.html')); break;
      case 'youtube':       navView.webContents.loadFile(path.join(__dirname, 'youtube.html')); break;
      case 'nav':           navView.webContents.loadFile(path.join(__dirname, 'nav.html')); break;
      default:              navView.webContents.loadFile(path.join(__dirname, 'nav.html')); break;
    }
  });

  // ── YouTube / Creators IPC ───────────────────────────────────────────────────

  // Open embedded stream popup window
  // Open YouTube live chat in its own window (avoids embed domain restrictions)
  ipcMain.on('open-youtube-chat', (event, { videoId, title }) => {
    const chatWin = new BrowserWindow({
      width: 380,
      height: 650,
      minWidth: 300,
      minHeight: 400,
      title: `Chat - ${title || 'Stream'}`,
      backgroundColor: '#0f0f0f',
      webPreferences: { webSecurity: false },
      autoHideMenuBar: true,
    });
    chatWin._isCreatorWindow = true; // creators window, excluded from global always-on-top
    chatWin.loadURL(`https://www.youtube.com/live_chat?v=${videoId}`);
    chatWin.on('close', () => chatWin.destroy());
  });

  // Close stream window safely without triggering window-all-closed
  ipcMain.on('close-stream-window', (event) => {
    const win = require('electron').BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.close();
  });

  // Return current stream window bounds (used before collapsing video pane)
  ipcMain.handle('get-stream-bounds', (event) => {
    const win = require('electron').BrowserWindow.fromWebContents(event.sender);
    return (win && !win.isDestroyed()) ? win.getBounds() : null;
  });

  // Resize stream window for audio-only (hide video) / restore video
  ipcMain.on('set-stream-video-hidden', (event, { hidden, restoreWidth }) => {
    const win = require('electron').BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    if (hidden) {
      win.setMinimumSize(300, 200);
      win.setBounds({ x: b.x, y: b.y, width: 340, height: b.height });
      appSettings.streamWindow = { ...(appSettings.streamWindow||{}), videoHidden: true, prevWinWidth: restoreWidth || appSettings.streamWindow?.prevWinWidth || 960 };
    } else {
      win.setMinimumSize(480, 360);
      win.setBounds({ x: b.x, y: b.y, width: restoreWidth || 960, height: b.height });
      appSettings.streamWindow = { ...(appSettings.streamWindow||{}), videoHidden: false };
    }
    saveSettingsDebounced();
  });

  // Pin stream window above all other windows
  ipcMain.on('set-stream-always-on-top', (event, val) => {
    const win = require('electron').BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(val, 'screen-saver');
      if (val) win.moveTop();
    }
    appSettings.streamWindow = { ...(appSettings.streamWindow||{}), pinned: val };
    saveSettingsDebounced();
  });

  // Save chat open/closed state from stream window
  ipcMain.on('set-stream-chat-open', (event, val) => {
    appSettings.streamWindow = { ...(appSettings.streamWindow||{}), chatOpen: val };
    saveSettingsDebounced();
  });

  // Provide saved stream prefs to the stream window on load
  ipcMain.handle('get-stream-prefs', () => appSettings.streamWindow || {});

  ipcMain.on('open-youtube-stream', (event, { videoId, title, mode, isLive, chatOnly }) => {
    const sw = appSettings.streamWindow || {};
    const streamWin = new BrowserWindow({
      width:  chatOnly ? 340 : (sw.width  || 960),
      height: sw.height || 600,
      x: sw.x != null ? sw.x : undefined,
      y: sw.y != null ? sw.y : undefined,
      minWidth: chatOnly ? 300 : 480,
      minHeight: 360,
      title: title || 'Stream',
      backgroundColor: '#000000',
      webPreferences: { nodeIntegration: true, contextIsolation: false, webviewTag: true },
      autoHideMenuBar: true,
      frame: false,
    });
    streamWin._isCreatorWindow = true; // self-manages its own pin/always-on-top
    // Restore always-on-top if it was pinned
    if (sw.pinned) {
      streamWin.setAlwaysOnTop(true, 'screen-saver');
    }
    const encodedTitle = encodeURIComponent(title || '');
    streamWin.loadFile(path.join(__dirname, 'youtube-stream.html'), {
      query: { v: videoId, title: encodedTitle, mode: mode || 'stream', live: isLive ? '1' : '0', chatOnly: chatOnly ? '1' : '0' }
    });
    // Save bounds on move/resize
    const saveStreamBounds = () => {
      if (streamWin && !streamWin.isDestroyed() && !streamWin.isMinimized()) {
        const b = streamWin.getBounds();
        appSettings.streamWindow = { ...(appSettings.streamWindow||{}), width: b.width, height: b.height, x: b.x, y: b.y };
        saveSettingsDebounced();
      }
    };
    streamWin.on('resize', saveStreamBounds);
    streamWin.on('move',   saveStreamBounds);
    // Prevent stream window close from triggering window-all-closed → app.quit()
    streamWin.on('close', () => {
      saveStreamBounds();
      streamWin.destroy();
    });
  });

  // Fetch a URL from main process (used for @handle → channel ID resolution fallback)
  ipcMain.handle('fetch-url-for-channel-id', async (event, url) => {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LostKit)' }
      });
      if (!response.ok) return null;
      return await response.text();
    } catch (e) {
      log.warn('fetch-url-for-channel-id failed:', e.message);
      return null;
    }
  });

  // Desktop notification when a creator goes live or posts a new video
  ipcMain.on('show-notification', (event, { title, body, videoId }) => {
    const { Notification } = require('electron');
    if (!Notification.isSupported()) return;
    const notif = new Notification({ title, body, silent: false });
    notif.on('click', () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
      if (videoId) {
        const streamWin = new BrowserWindow({
          width: 960, height: 600, minWidth: 480, minHeight: 360,
          title: title || 'Stream',
          backgroundColor: '#000000',
          webPreferences: { nodeIntegration: true, contextIsolation: false },
          autoHideMenuBar: true,
          frame: false,
        });
        streamWin._isCreatorWindow = true; // self-manages its own pin/always-on-top
        streamWin.loadFile(path.join(__dirname, 'youtube-stream.html'), {
          query: { v: videoId, title: encodeURIComponent(title || ''), mode: 'both' }
        });
      }
    });
    notif.show();
  });

  // ── Creators channel sync ─────────────────────────────────────────────────
  ipcMain.handle('get-creator-channels', () => appSettings.creatorChannels || []);
  ipcMain.on('update-creator-channels', (event, channels) => {
    appSettings.creatorChannels = channels;
    saveSettingsDebounced();
  });

  // ── Creator notification settings ─────────────────────────────────────────
  ipcMain.handle('get-creator-notif-settings', () =>
    appSettings.creatorNotifSettings || { notifLive: true, notifVideo: true, pollIntervalMs: 300000 }
  );
  ipcMain.on('update-creator-notif-settings', (event, settings) => {
    appSettings.creatorNotifSettings = { ...(appSettings.creatorNotifSettings||{}), ...settings };
    saveSettingsDebounced();
    startCreatorPolling(); // restart with new interval
  });

  // ── Market watchlist IPC ──────────────────────────────────────────────────
  // Requests are proxied through main: the panel is a file:// page, so a direct
  // fetch to markets.lostcity.rs would be a cross-origin request.
  ipcMain.handle('market-search-items', async (event, query) => {
    const q = (query || '').trim();
    if (q.length < 2) return [];
    try {
      const res = await fetch(`${MARKET_ORIGIN}/api/items?q=${encodeURIComponent(q)}`, {
        headers: { 'User-Agent': MARKET_UA, 'Accept': 'application/json' }
      });
      if (!res.ok) return [];
      const items = await res.json();
      return (Array.isArray(items) ? items : []).slice(0, 12)
        .map(i => ({ id: i.id, name: i.name, slug: i.slug, cost: i.cost }));
    } catch (e) { log.warn('Market item search failed:', e.message); return []; }
  });

  // ── Hiscores lookup + Compare window ──────────────────────────────────────
  // Proxied through the main process on purpose: the hiscores API answers with
  // access-control-allow-origin: https://2004.lostcity.rs, so a fetch from a
  // file:// page is blocked by CORS. Main has no such restriction. It is also
  // rate limited (429), which is reported back plainly rather than as a crash.
  // ── Hiscores ──────────────────────────────────────────────────────────────
  // One route for every hiscores lookup, single or compare. The API rate limits
  // hard, and a comparison is two lookups back to back - the surest way to trip
  // it. Three cheap measures keep that from happening:
  //   · a short cache, so looking the same player up twice costs one request
  //   · a minimum gap between requests, so two in a row are not simultaneous
  //   · one retry after a pause, because the limit clears in about a second
  const hiscoresCache = new Map();          // lowercased name -> { at, result }
  const HISCORES_TTL = 60000;
  const HISCORES_GAP = 400;                 // ms between consecutive requests
  const HISCORES_RETRY_WAIT = 1500;
  let hiscoresLastFetch = 0;

  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  async function fetchHiscores(player) {
    const gap = HISCORES_GAP - (Date.now() - hiscoresLastFetch);
    if (gap > 0) await wait(gap);
    hiscoresLastFetch = Date.now();
    return fetch(
      `https://2004.lostcity.rs/api/hiscores/player/${encodeURIComponent(player)}`,
      { headers: { 'User-Agent': MARKET_UA, 'Accept': 'application/json' } }
    );
  }

  ipcMain.handle('hiscores-lookup', async (event, name) => {
    const player = (name || '').trim();
    if (!player) return { ok: false, error: 'empty' };

    const key = player.toLowerCase();
    const hit = hiscoresCache.get(key);
    if (hit && Date.now() - hit.at < HISCORES_TTL) return hit.result;

    try {
      let res = await fetchHiscores(player);
      if (res.status === 429) {
        await wait(HISCORES_RETRY_WAIT);
        res = await fetchHiscores(player);
      }
      if (res.status === 429) return { ok: false, error: 'ratelimited' };
      if (!res.ok) return { ok: false, error: 'notfound' };
      const stats = await res.json();
      if (!Array.isArray(stats) || !stats.length) return { ok: false, error: 'notfound' };
      // Only successes are cached: a miss or a rate limit should be retried,
      // not remembered for a minute.
      const result = { ok: true, name: player, stats };
      hiscoresCache.set(key, { at: Date.now(), result });
      return result;
    } catch (e) {
      log.warn('Hiscores lookup failed:', player, e.message);
      return { ok: false, error: 'network' };
    }
  });

  ipcMain.on('open-compare-window', (event, names) => {
    if (compareWindow && !compareWindow.isDestroyed()) {
      compareWindow.focus();
      if (names) compareWindow.webContents.send('compare-prefill', names);
      return;
    }
    const saved = appSettings.compareWindow || { width: 760, height: 660 };
    compareWindow = new BrowserWindow({
      width: saved.width || 760, height: saved.height || 660,
      x: saved.x != null ? saved.x : undefined, y: saved.y != null ? saved.y : undefined,
      minWidth: 560, minHeight: 400,
      autoHideMenuBar: true, backgroundColor: '#222222',
      title: 'LostKit - Hiscores Compare',
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    compareWindow.loadFile(path.join(__dirname, 'navitems/compare.html'));
    applyAlwaysOnTop(compareWindow);
    applyWindowIcon(compareWindow, 'assets/hiscores.png');
    compareWindow.webContents.on('did-finish-load', () => {
      applyFontToView(compareWindow.webContents, true);
      if (names) compareWindow.webContents.send('compare-prefill', names);
    });
    const saveBounds = () => {
      if (compareWindow && !compareWindow.isDestroyed() && !compareWindow.isMinimized()) {
        const b = compareWindow.getBounds();
        appSettings.compareWindow = { width: b.width, height: b.height, x: b.x, y: b.y };
        saveSettingsDebounced();
      }
    };
    compareWindow.on('resized', saveBounds);
    compareWindow.on('moved', saveBounds);
    compareWindow.on('closed', () => { compareWindow = null; });
  });

  ipcMain.handle('get-market-watches', () => appSettings.marketWatches || []);
  ipcMain.handle('get-market-default-deviation', () =>
    Number.isFinite(appSettings.marketDefaultDeviation) ? appSettings.marketDefaultDeviation : 20);

  // Same panel, its own window - so it can be browsed while the nav column is
  // doing something else. Both copies stay live off the same broadcast.
  ipcMain.on('open-watchlist-window', () => {
    if (watchlistWindow && !watchlistWindow.isDestroyed()) { watchlistWindow.focus(); return; }
    const saved = appSettings.watchlistWindow || { width: 340, height: 620 };
    watchlistWindow = new BrowserWindow({
      width: saved.width || 340, height: saved.height || 620,
      x: saved.x != null ? saved.x : undefined, y: saved.y != null ? saved.y : undefined,
      minWidth: 280, minHeight: 320,
      autoHideMenuBar: true, backgroundColor: '#222222',
      title: 'LostKit - Price Watch',
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    watchlistWindow.loadFile(path.join(__dirname, 'navitems/watchlist.html'), { query: { window: '1' } });
    applyAlwaysOnTop(watchlistWindow);
    applyWindowIcon(watchlistWindow, 'assets/Marketwatch.png');
    watchlistWindow.webContents.on('did-finish-load', () => applyFontToView(watchlistWindow.webContents, true));
    const saveBounds = () => {
      if (watchlistWindow && !watchlistWindow.isDestroyed() && !watchlistWindow.isMinimized()) {
        const b = watchlistWindow.getBounds();
        appSettings.watchlistWindow = { width: b.width, height: b.height, x: b.x, y: b.y };
        saveSettingsDebounced();
      }
    };
    watchlistWindow.on('resized', saveBounds);
    watchlistWindow.on('moved', saveBounds);
    watchlistWindow.on('closed', () => { watchlistWindow = null; });
  });
  ipcMain.handle('get-market-notify-enabled', () => appSettings.marketNotifyEnabled !== false);
  ipcMain.on('set-market-notify-enabled', (event, enabled) => {
    appSettings.marketNotifyEnabled = !!enabled;
    saveSettingsDebounced();
  });

  ipcMain.handle('add-market-watch', async (event, watch) => {
    if (!watch || !watch.slug) return appSettings.marketWatches || [];
    if (!appSettings.marketWatches) appSettings.marketWatches = [];
    const entry = {
      id: 'w' + Date.now(),
      itemId: watch.itemId || null,
      slug: watch.slug,
      name: watch.name || watch.slug,
      direction: watch.direction === 'sell' ? 'sell' : 'buy',
      min: Number.isFinite(watch.min) ? watch.min : null,
      max: Number.isFinite(watch.max) ? watch.max : null,
      deviation: Number.isFinite(watch.deviation) ? Math.max(0, watch.deviation) : 20,
      listings: [], matches: [], notifiedListingIds: [], best: null, barterCount: 0, farCount: 0
    };
    appSettings.marketWatches.push(entry);
    appSettings.marketDefaultDeviation = entry.deviation;   // remembered for the next one
    // First refresh is silent: everything already listed would otherwise fire at once.
    try { await refreshMarketWatch(entry); entry.notifiedListingIds = entry.matches.map(m => m.id); }
    catch (e) { entry.error = e.message; }
    saveSettingsDebounced();
    broadcastMarketWatches();   // keep the other copy of the panel in step
    return appSettings.marketWatches;
  });

  // Edit a watch in place - changing the price you care about should not mean
  // deleting and re-adding it.
  ipcMain.handle('update-market-watch', async (event, id, patch) => {
    const w = (appSettings.marketWatches || []).find(x => x.id === id);
    if (!w || !patch) return appSettings.marketWatches || [];
    if (patch.direction) w.direction = patch.direction === 'sell' ? 'sell' : 'buy';
    w.min = Number.isFinite(patch.min) ? patch.min : null;
    w.max = Number.isFinite(patch.max) ? patch.max : null;
    if (Number.isFinite(patch.deviation)) {
      w.deviation = Math.max(0, patch.deviation);
      appSettings.marketDefaultDeviation = w.deviation;
    }
    // Re-check straight away, and treat whatever now matches as already seen so
    // widening a range doesn't fire a burst of notifications for old listings.
    try { await refreshMarketWatch(w); w.notifiedListingIds = w.matches.map(m => m.id); }
    catch (e) { w.error = e.message; }
    saveSettingsDebounced();
    broadcastMarketWatches();
    return appSettings.marketWatches;
  });

  // Completed trades for an item, oldest first - the basis of the price graph.
  //
  // Real trades are often not a clean pile of coins: high value items go for
  // "340m + a santa hat + a d chain". Dropping those left barter-heavy items
  // looking like they had never traded, so each sale is classified instead:
  //   coins - a single coins offer, an exact price
  //   mixed - coins plus other items, so the coin part is only a FLOOR
  //   items - no coins at all, no gp value can be claimed
  function classifySoldTrade(l) {
    const offer = l.offers && l.offers[0];
    const empty = { kind: 'none', price: null, extras: 0, text: 'no offer' };
    if (!offer || !Array.isArray(offer.items) || !offer.items.length) return empty;

    const coins = offer.items.filter(i => i.item && i.item.slug === 'coins');
    const others = offer.items.filter(i => !i.item || i.item.slug !== 'coins');
    const perEach = /each/i.test(offer.title || '');
    const qty = Math.max(1, l.quantity || 1);
    const coinTotal = coins.reduce((sum, i) => sum + i.quantity, 0);
    const price = coins.length ? perUnitPrice(coinTotal, perEach, qty) : null;
    const text = offer.items
      .map(i => `${i.quantity.toLocaleString()} ${i.item ? i.item.name : '?'}`).join(' + ');
    // Structured side of the offer, so the non-coin half can be valued later.
    const parts = others.map(i => ({
      slug: i.item ? i.item.slug : null,
      name: i.item ? i.item.name : '?',
      quantity: i.quantity,
      cost: i.item ? i.item.cost : null
    }));
    const base = { price, extras: others.length, text, parts, coins: coinTotal, perEach, lotQty: qty };

    if (coins.length && !others.length) return { ...base, kind: 'coins' };
    if (coins.length && others.length)  return { ...base, kind: 'mixed' };
    return { ...base, kind: 'items', price: null };
  }

  // ── Valuing the non-coin half of an offer ─────────────────────────────────
  // "340m + a santa hat + a d chain" is not 340m. Each item is valued from its
  // own completed sales around the date of the trade, falling back to what it
  // currently goes for, and only then to its shop cost. One network trip per
  // distinct item, cached for the session.
  const itemPriceCache = new Map();   // slug -> { sales:[{price,t}], current, cost }

  const medianOf = (prices) => {
    if (!prices.length) return null;
    const sorted = [...prices].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];   // median resists one silly listing
  };

  async function getItemPriceData(slug) {
    if (itemPriceCache.has(slug)) return itemPriceCache.get(slug);
    const data = { sales: [], current: null, cost: null };
    try {
      const page = await marketFetchPage(`/items/${encodeURIComponent(slug)}`);
      const props = page.props || {};
      if (props.item) data.cost = props.item.cost != null ? props.item.cost : null;

      const sold = (props.soldListings && props.soldListings.data) || [];
      const raw = [];
      sold.forEach(l => {
        const c = classifySoldTrade(l);
        // Only clean coin sales are trustworthy enough to value other things with.
        if (c.kind === 'coins' && c.price != null && l.soldAt) {
          raw.push({ price: c.price, t: new Date(l.soldAt).getTime(), notes: l.notes });
        }
      });
      // A placeholder price is just as poisonous here: it would pull the average
      // this item is valued at down toward nothing.
      const soldRef = referencePrice(raw.map(r => r.price));
      raw.forEach(r => {
        const screened = screenPrice(r.price, r.notes, soldRef);
        if (screened.source !== 'suspect') data.sales.push({ price: screened.price, t: r.t });
      });

      const live = ((props.listings && props.listings.data) || []).filter(isListingLive);
      const liveRef = referencePrice(live.map(listingUnitPrice), soldRef);
      data.current = medianOf(live
        .map(l => screenPrice(listingUnitPrice(l), l.notes, liveRef))
        .filter(s => s.source !== 'suspect' && s.price != null)
        .map(s => s.price));

      // An item page defaults to the buy side. Rare things often have nobody
      // bidding but somebody asking - a Gilded kiteshield had 0 buy listings
      // and one sell listing at 30m - so check the other side before giving up.
      if (!data.sales.length && data.current == null) {
        const sellPage = await marketFetchPage(`/items/${encodeURIComponent(slug)}?type=sell`);
        const asks = ((sellPage.props && sellPage.props.listings && sellPage.props.listings.data) || [])
          .filter(isListingLive);
        const askRef = referencePrice(asks.map(listingUnitPrice));
        data.current = medianOf(asks
          .map(l => screenPrice(listingUnitPrice(l), l.notes, askRef))
          .filter(s => s.source !== 'suspect' && s.price != null)
          .map(s => s.price));
      }
    } catch (e) {
      log.warn('Item valuation lookup failed:', slug, e.message);
    }
    itemPriceCache.set(slug, data);
    return data;
  }

  const WINDOW_MS = 14 * 86400000;

  function valueFromData(data, atTime) {
    if (data.sales.length) {
      const near = data.sales.filter(s => Math.abs(s.t - atTime) <= WINDOW_MS);
      if (near.length) {
        return { unit: Math.round(near.reduce((s, x) => s + x.price, 0) / near.length),
                 source: `avg of ${near.length} sale${near.length > 1 ? 's' : ''} near that date` };
      }
      // Nothing close in time - use the sales nearest to it instead of a blind average.
      const sorted = [...data.sales].sort((a, b) => Math.abs(a.t - atTime) - Math.abs(b.t - atTime)).slice(0, 5);
      return { unit: Math.round(sorted.reduce((s, x) => s + x.price, 0) / sorted.length),
               source: `avg of ${sorted.length} nearest sale${sorted.length > 1 ? 's' : ''}` };
    }
    if (data.current) return { unit: data.current, source: 'current market price' };
    // A zero shop value is not a valuation - treating it as one lets an item
    // contribute nothing to a total and quietly drags the trade toward 0.
    if (data.cost) return { unit: data.cost, source: 'shop value only' };
    return { unit: null, source: 'no data' };
  }

  // What a standing offer paid in items is worth in gp, valued at today's
  // prices. A santa hat wanted for "1 Halloween mask + 1 Halloween mask + 1
  // Santa hat" is a real offer with a real value, and dropping it because no
  // coins changed hands threw away half the book on the rare items - exactly
  // the ones where a price check matters most.
  async function valueOfferNow(classified) {
    if (!classified || !classified.parts || !classified.parts.length) return null;
    let total = classified.coins || 0;
    for (const part of classified.parts) {
      if (!part.slug) return null;
      const value = valueFromData(await getItemPriceData(part.slug), Date.now());
      if (value.unit == null) return null;      // one unknown item voids the lot
      total += value.unit * part.quantity;
    }
    return perUnitPrice(total, classified.perEach, classified.lotQty);
  }

  // Values a batch of offers in one call. Capped so a cracker trade with a
  // dozen odds and ends cannot turn into a dozen page loads every time.
  ipcMain.handle('market-value-offers', async (event, requests) => {
    if (!Array.isArray(requests) || !requests.length) return {};
    const slugs = new Set();
    requests.forEach(r => (r.parts || []).forEach(p => { if (p.slug) slugs.add(p.slug); }));
    // A single easter egg trade can name 28 different items, so a tight cap
    // silently left the tail "not valued" and killed the whole trade's value.
    // Everything is cached for the session, so this is paid once per item.
    const capped = [...slugs].slice(0, 80);
    const queue = [...capped];
    const worker = async () => { while (queue.length) await getItemPriceData(queue.shift()); };
    await Promise.all([worker(), worker(), worker(), worker()]);   // 4 at a time

    const out = {};
    for (const req of requests) {
      const atTime = new Date(req.soldAt).getTime();
      let total = req.coins || 0;
      let missing = 0;
      const parts = [];
      for (const p of (req.parts || [])) {
        const data = p.slug && itemPriceCache.has(p.slug) ? itemPriceCache.get(p.slug) : null;
        const v = data ? valueFromData(data, atTime) : { unit: null, source: 'not looked up' };
        if (v.unit == null) missing++;
        else total += v.unit * p.quantity;
        parts.push({ name: p.name, quantity: p.quantity, unit: v.unit, source: v.source });
      }
      const complete = missing === 0;
      const lot = Math.max(1, req.lotQty || 1);
      // Ratio offers ("3 nature runes for 4 essence") give fractional unit
      // values, so cheap items keep two decimals instead of rounding to zero.
      const raw = total / (req.perEach ? 1 : lot);

      // Only a complete valuation is safe to plot. If any item could not be
      // priced the remainder is not a "low estimate" - it is a number missing
      // its largest term. "105k raw sharks for an easter egg" with the sharks
      // unpriced comes out as 0, which is not a cheap trade, it is no answer.
      out[req.id] = complete && total > 0
        ? { total, unit: raw < 10 ? Math.round(raw * 100) / 100 : Math.round(raw), complete: true, parts }
        : { total: null, unit: null, complete: false, missing, parts };
    }
    return out;
  });

  // `days` asks for enough pages to actually cover that window - without it a
  // busy item returns ten pages of one week and a "3 months" view has nothing
  // older to show.
  ipcMain.handle('market-price-history', async (event, slug, opts) => {
    if (!slug) return { trades: [], total: 0 };
    const days = (opts && Number(opts.days)) || 0;
    const cutoff = days ? Date.now() - days * 86400000 : null;
    const MAX_PAGES = days ? 12 : 3;   // 12 pages ≈ 120 trades, still polite
    try {
      const rows = [];
      let total = 0;
      let complete = false;
      for (let p = 1; p <= MAX_PAGES; p++) {
        const page = await marketFetchPage(`/items/${encodeURIComponent(slug)}?sold_page=${p}`);
        const sold = page.props && page.props.soldListings;
        if (!sold || !Array.isArray(sold.data) || !sold.data.length) { complete = true; break; }
        rows.push(...sold.data);
        if (sold.meta) {
          total = sold.meta.total || rows.length;
          if (!sold.meta.next_page_url || p >= sold.meta.last_page) { complete = true; break; }
        } else { complete = true; break; }
        // Stop as soon as we hold something older than the window asked for.
        if (cutoff) {
          const oldest = Math.min(...rows.filter(l => l.soldAt).map(l => new Date(l.soldAt).getTime()));
          if (Number.isFinite(oldest) && oldest < cutoff) break;
        }
      }
      const classified = rows.filter(l => l.soldAt).map(l => ({ l, c: classifySoldTrade(l) }));
      // A placeholder price is even more obvious on a chart than in a list: one
      // sale recorded as 169gp plots on the floor and drags the line down with
      // it. Judged against the item's own sales, which is the best sample we
      // will ever have of what it really goes for.
      const reference = referencePrice(classified.filter(x => x.c.kind === 'coins').map(x => x.c.price));
      const trades = classified
        .map(({ l, c }) => {
          // Only pure coin sales are screened. In a mixed offer the coin figure
          // is openly a floor with items stacked on top - "4m + a ranger set" is
          // meant to look small next to the going rate, and calling that a
          // placeholder would flag half the high-value trades on the site.
          const screened = c.kind === 'coins' && c.price != null
            ? screenPrice(c.price, l.notes, reference)
            : { price: c.price, source: 'ok' };
          const suspect = screened.source === 'suspect';
          return { id: l.id, kind: c.kind,
                   // Suspect sales carry no price at all, which keeps them off
                   // the chart while still listing them below it.
                   price: suspect ? null : screened.price,
                   // What was actually written down, kept whenever it is not
                   // what we ended up using - including suspects, where the
                   // listed number is the whole point of the explanation.
                   listedPrice: suspect || screened.price !== c.price ? c.price : null,
                   suspect,
                   priceFromNotes: screened.source === 'notes',
                   notes: l.notes || '',
                   extras: c.extras, offer: c.text,
                   parts: c.parts, coins: c.coins, perEach: c.perEach, lotQty: c.lotQty,
                   soldAt: l.soldAt, type: l.type, quantity: l.quantity, username: l.username };
        })
        .sort((a, b) => new Date(a.soldAt) - new Date(b.soldAt));
      const oldest = trades.length ? new Date(trades[0].soldAt).getTime() : null;
      return { trades, total: total || trades.length, oldest, complete };
    } catch (e) {
      log.warn('Price history failed:', slug, e.message);
      return { trades: [], total: 0, error: e.message };
    }
  });

  ipcMain.handle('get-market-poll-interval', () => appSettings.marketPollIntervalMs || 300000);

  // What an item is going for right now, both sides of the book. Completed
  // trades say what it went for; this says what it would cost today.
  ipcMain.handle('market-live-prices', async (event, slug) => {
    if (!slug) return null;
    const fetchSide = async (type) => {
      const page = await marketFetchPage(`/items/${encodeURIComponent(slug)}?type=${type}`);
      return ((page.props && page.props.listings && page.props.listings.data) || []).filter(isListingLive);
    };

    // Valuing item offers costs a page load per distinct item, so a busy book
    // is capped - the point is to stop throwing the offers away, not to price
    // every last one.
    const MAX_VALUED = 12;

    const summarise = async (rows, reference) => {
      // Every offer that survives screening is returned, not just the summary:
      // for an item offer the gp figure is our own estimate, so who is offering
      // and what they are actually putting up has to be visible.
      const offers = [];
      let suspect = 0, fromNotes = 0, valued = 0, unvalued = 0, budget = MAX_VALUED;
      for (const l of rows) {
        const entry = { username: l.username, quantity: l.quantity,
                        offer: describeOffer(l), notes: l.notes || '', updatedAt: l.updatedAt };
        const raw = listingUnitPrice(l);
        if (raw != null) {
          const screened = screenPrice(raw, l.notes, reference);
          if (screened.source === 'suspect') { suspect++; continue; }
          if (screened.source === 'notes') fromNotes++;
          offers.push({ ...entry, price: screened.price, fromNotes: screened.source === 'notes', valued: false });
          continue;
        }
        // Paid in items rather than coins.
        if (budget <= 0) { unvalued++; continue; }
        budget--;
        const worth = await valueOfferNow(classifySoldTrade(l));
        // An item offer valued at a fraction of the going rate is the same kind
        // of noise as a placeholder, so it is held to the same standard.
        if (worth != null && (reference == null ||
            (worth >= reference / OUTLIER_FACTOR && worth <= reference * OUTLIER_FACTOR))) {
          offers.push({ ...entry, price: worth, fromNotes: false, valued: true });
          valued++;
        } else {
          unvalued++;
        }
      }
      const prices = offers.map(o => o.price).sort((a, b) => a - b);
      const base = { count: rows.length, barter: unvalued, suspect, fromNotes, valued, offers };
      if (!prices.length) return { ...base, min: null, max: null, avg: null, median: null };
      return {
        ...base,
        min: prices[0],
        max: prices[prices.length - 1],
        avg: Math.round(prices.reduce((s, p) => s + p, 0) / prices.length),
        median: prices[Math.floor(prices.length / 2)]
      };
    };

    try {
      const [sellRows, buyRows] = await Promise.all([fetchSide('sell'), fetchSide('buy')]);
      // Both sides judged against one reference drawn from both. A side often
      // holds a single listing - the santa hat buy side held exactly one, for
      // "169 Coins" - and a lone listing has nothing of its own to be measured
      // against. The other side of the book does.
      const reference = referencePrice([...sellRows, ...buyRows].map(listingUnitPrice));
      return {
        sell: await summarise(sellRows, reference),
        buy: await summarise(buyRows, reference),
        asOf: Date.now()
      };
    } catch (e) {
      log.warn('Live price lookup failed:', slug, e.message);
      return null;
    }
  });

  // The chart needs room to say anything, so it gets a window rather than a
  // 226px slot in the nav column. One window, reused for whichever item you ask
  // for next.
  // An empty slug is valid: it opens the window as a blank price checker.
  ipcMain.on('open-price-history-window', (event, itemInfo) => {
    if (!itemInfo) return;
    if (priceHistoryWindow && !priceHistoryWindow.isDestroyed()) {
      if (!itemInfo.slug) { priceHistoryWindow.show(); priceHistoryWindow.focus(); return; }
      priceHistoryWindow.webContents.send('price-history-item', itemInfo);
      priceHistoryWindow.show();
      priceHistoryWindow.focus();
      return;
    }
    const saved = appSettings.priceHistoryWindow || { width: 780, height: 600 };
    priceHistoryWindow = new BrowserWindow({
      width: saved.width || 780, height: saved.height || 600,
      x: saved.x != null ? saved.x : undefined, y: saved.y != null ? saved.y : undefined,
      minWidth: 520, minHeight: 380,
      autoHideMenuBar: true, backgroundColor: '#222222',
      title: 'LostKit - Price History',
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    priceHistoryWindow.loadFile(path.join(__dirname, 'navitems/pricehistory.html'), {
      query: { slug: itemInfo.slug, name: itemInfo.name || itemInfo.slug }
    });
    applyAlwaysOnTop(priceHistoryWindow);
    applyWindowIcon(priceHistoryWindow, 'assets/Pricecheck.png');
    priceHistoryWindow.webContents.on('did-finish-load', () => applyFontToView(priceHistoryWindow.webContents, true));
    const saveBounds = () => {
      if (priceHistoryWindow && !priceHistoryWindow.isDestroyed() && !priceHistoryWindow.isMinimized()) {
        const b = priceHistoryWindow.getBounds();
        appSettings.priceHistoryWindow = { width: b.width, height: b.height, x: b.x, y: b.y };
        saveSettingsDebounced();
      }
    };
    priceHistoryWindow.on('resized', saveBounds);
    priceHistoryWindow.on('moved', saveBounds);
    priceHistoryWindow.on('closed', () => { priceHistoryWindow = null; });
  });

  ipcMain.handle('remove-market-watch', (event, id) => {
    appSettings.marketWatches = (appSettings.marketWatches || []).filter(w => w.id !== id);
    saveSettingsDebounced();
    broadcastMarketWatches();
    return appSettings.marketWatches;
  });

  ipcMain.handle('refresh-market-watches', async () => {
    await pollMarketWatches({ notify: false });
    return appSettings.marketWatches || [];
  });

  ipcMain.on('open-market-item', (event, slug) => {
    createTab(`${MARKET_ORIGIN}/items/${slug}`, 'Markets', 'assets/market.png');
  });


  // ── Custom tools ──────────────────────────────────────────────────────────
  // Nav panel and settings both read the list from here, so they cannot differ.
  ipcMain.handle('get-custom-tools', () => customToolsForRenderer());

  // Adds a tool and grabs the site's own icon, the one its browser tab shows.
  // Returns { ok, tool } or { ok: false, error } for the add dialog to render.
  ipcMain.handle('add-custom-tool', async (event, input) => {
    const url = normalizeToolUrl(input && input.url);
    if (!url) return { ok: false, error: 'That does not look like a web address.' };

    const tools = getCustomTools();
    if (tools.some(t => t.url === url)) return { ok: false, error: 'That tool is already in your list.' };
    if (tools.length >= 30) return { ok: false, error: 'You have reached the limit of 30 custom tools.' };

    const id = 'tool-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
    let title = String((input && input.title) || '').trim();

    const meta = await fetchSiteMeta(url);
    if (!title) title = (meta.title || '').trim();
    if (!title) { try { title = new URL(url).hostname.replace(/^www\./, ''); } catch (e) { title = url; } }
    title = title.slice(0, 40);

    const icon = await captureToolIcon(url, id, meta.iconUrl);

    tools.push({ id, url, title, icon });
    saveSettings();
    broadcastCustomTools();
    log.info('Added custom tool:', title, url, icon ? '(icon captured)' : '(no icon)');
    return { ok: true, tool: customToolsForRenderer().find(t => t.id === id) };
  });

  // Rename, or repoint at a different address (which re-grabs the icon).
  ipcMain.handle('update-custom-tool', async (event, id, patch) => {
    const tool = getCustomTools().find(t => t.id === id);
    if (!tool) return { ok: false, error: 'That tool no longer exists.' };

    if (patch && typeof patch.title === 'string') {
      const title = patch.title.trim().slice(0, 40);
      if (title) tool.title = title;
    }
    if (patch && typeof patch.url === 'string' && patch.url.trim()) {
      const url = normalizeToolUrl(patch.url);
      if (!url) return { ok: false, error: 'That does not look like a web address.' };
      if (url !== tool.url) {
        tool.url = url;
        const meta = await fetchSiteMeta(url);
        tool.icon = await captureToolIcon(url, tool.id, meta.iconUrl);
      }
    }
    saveSettings();
    broadcastCustomTools();
    return { ok: true, tool: customToolsForRenderer().find(t => t.id === id) };
  });

  // For when a site changes its icon, or the grab came up empty first time.
  ipcMain.handle('refresh-custom-tool-icon', async (event, id) => {
    const tool = getCustomTools().find(t => t.id === id);
    if (!tool) return { ok: false, error: 'That tool no longer exists.' };
    const meta = await fetchSiteMeta(tool.url);
    tool.icon = await captureToolIcon(tool.url, tool.id, meta.iconUrl);
    saveSettings();
    broadcastCustomTools();
    return { ok: !!tool.icon, tool: customToolsForRenderer().find(t => t.id === id) };
  });

  // Removing is meant to be as easy as adding: the entry and its icon file go,
  // nothing else in the app is touched.
  ipcMain.handle('remove-custom-tool', (event, id) => {
    const tools = getCustomTools();
    const idx = tools.findIndex(t => t.id === id);
    if (idx === -1) return { ok: false };
    const [removed] = tools.splice(idx, 1);
    removeToolIconFiles(removed.id);
    forgetHiddenNavButton(removed.id);
    saveSettings();
    broadcastCustomTools();
    log.info('Removed custom tool:', removed.title);
    return { ok: true };
  });

  // ── Add-tool dialog ───────────────────────────────────────────────────────
  ipcMain.on('open-add-tool-window', (event, presetId) => {
    if (addToolWindow && !addToolWindow.isDestroyed()) {
      addToolWindow.focus();
      addToolWindow.webContents.send('edit-tool', presetId || null);
      return;
    }
    addToolWindow = new BrowserWindow({
      width: 460, height: 430, resizable: false, autoHideMenuBar: true,
      parent: mainWindow, title: 'LostKit - Add Tool',
      webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    addToolWindow.loadFile(path.join(__dirname, 'navitems/add-tool.html'));
    applyAlwaysOnTop(addToolWindow);
    addToolWindow.webContents.on('did-finish-load', () => {
      applyFontToView(addToolWindow.webContents, true);
      if (presetId) addToolWindow.webContents.send('edit-tool', presetId);
    });
    addToolWindow.on('closed', () => { addToolWindow = null; });
  });

  ipcMain.on('close-add-tool-window', () => {
    if (addToolWindow && !addToolWindow.isDestroyed()) addToolWindow.close();
  });

  // Right-clicking a custom tool in the nav panel manages it in place - no trip
  // through settings to rename one or take it back off the list.
  ipcMain.on('custom-tool-menu', (event, id) => {
    const tool = getCustomTools().find(t => t.id === id);
    if (!tool) return;
    const rendered = customToolsForRenderer().find(t => t.id === id);

    Menu.buildFromTemplate([
      { label: tool.title, enabled: false },
      { type: 'separator' },
      { label: 'Open in tab', click: () => createTab(tool.url, tool.title, rendered.icon) },
      { label: 'Open in window', click: () => openExternalWindow(tool.url, tool.title, rendered.icon) },
      { type: 'separator' },
      { label: 'Edit…', click: () => ipcMain.emit('open-add-tool-window', null, id) },
      {
        label: 'Refresh icon',
        click: async () => {
          const meta = await fetchSiteMeta(tool.url);
          tool.icon = await captureToolIcon(tool.url, tool.id, meta.iconUrl);
          saveSettings();
          broadcastCustomTools();
        }
      },
      { type: 'separator' },
      {
        label: 'Remove',
        click: () => {
          const choice = dialog.showMessageBoxSync(mainWindow, {
            type: 'question', buttons: ['Remove', 'Cancel'], defaultId: 1, cancelId: 1,
            title: 'Remove tool',
            message: `Remove "${tool.title}" from your tools?`,
            detail: 'You can add it again at any time.'
          });
          if (choice !== 0) return;
          const tools = getCustomTools();
          const idx = tools.findIndex(t => t.id === id);
          if (idx === -1) return;
          removeToolIconFiles(id);
          forgetHiddenNavButton(id);
          tools.splice(idx, 1);
          saveSettings();
          broadcastCustomTools();
          log.info('Removed custom tool:', tool.title);
        }
      }
    ]).popup({ window: mainWindow });
  });

  // ── Split view ──
  // Master switch. Off clears any pair and hides the button in every toolbar.
  ipcMain.handle('get-split-view-enabled', () => appSettings.splitViewEnabled !== false);
  ipcMain.on('set-split-view-enabled', (event, enabled) => {
    appSettings.splitViewEnabled = !!enabled;
    if (!enabled) { splitTabId = null; splitOtherId = null; splitLocked = false; splitLockedPair = null; giveBackSplitWidth(); }
    saveSettingsDebounced();
    updateBounds();
    broadcastToolbarStates();
    persistTabs();
  });

  // ── Nav button visibility ─────────────────────────────────────────────────
  ipcMain.handle('get-hidden-nav-buttons', () => appSettings.hiddenNavButtons || []);
  ipcMain.on('set-hidden-nav-buttons', (event, hiddenIds) => {
    appSettings.hiddenNavButtons = hiddenIds;
    saveSettingsDebounced();
    if (navView && !navView.webContents.isDestroyed())
      navView.webContents.send('update-nav-visibility', hiddenIds);
  });

  // Always targets the game view. Acting on the active tab meant a world could
  // load into a tool, which the split view made easy to hit.
  ipcMain.on('select-world', (event, url, title) => {
    const gameTab = tabs.find(t => t.id === 'main');
    if (!gameTab || gameTab.url === url) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning', buttons: ['Cancel', 'Continue'], defaultId: 1,
      title: 'Switch World', message: 'Make sure you are logged out before switching worlds!'
    });
    if (choice !== 1) return;

    tabByUrl.delete(gameTab.url);
    gameTab.url = url; gameTab.title = title; tabByUrl.set(url, 'main');
    const cv = primaryViews.find(pv => pv.id === 'main');
    if (cv) {
      cv.view.webContents.loadURL(url);
      // Clear navigation history so back/forward buttons/gestures lead nowhere
      const wc = cv.view.webContents; if (wc.navigationHistory?.clear) wc.navigationHistory.clear(); else wc.clearHistory();
    }
    appSettings.lastWorld = { url, title }; saveSettingsDebounced();
    mainWindow.webContents.send('update-tab-title', 'main', title);
    persistTabs();
    ipcMain.emit('switch-nav-view', null, 'nav');
    refreshLatency();

    // Bring the game forward if it is not already on screen - otherwise you
    // would have just switched a world you cannot see.
    const pair = splitPairIds();
    const gameShowing = currentTab === 'main' ||
      (pair && (pair.leftId === 'main' || pair.rightId === 'main'));
    if (!gameShowing) switchToTab('main');
  });

  mainWindow.on('close', () => {
    BrowserWindow.getAllWindows().forEach(win => {
      try { if (win !== mainWindow && !win.isDestroyed()) win.destroy(); } catch (e) {}
    });
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  ipcMain.on('set-chat-height', (event, height) => { chatHeightValue = Math.max(200, Math.min(height, 800)); appSettings.chatHeight = chatHeightValue; saveSettingsDebounced(); updateBounds(); });
  ipcMain.on('update-chat-height', (event, height) => { chatHeightValue = Math.max(200, Math.min(800, height)); appSettings.chatHeight = chatHeightValue; saveSettingsDebounced(); updateBounds(); });

  // Opens a URL in its own window. Several windows may be open for the same URL
  // at once; each one saves its size/position/zoom under that URL, so the window
  // closed last is the one whose adjustments are restored next time.
  // `spawnAt.screenX/screenY` places the window at a drop point (tab tear-off).
  function openExternalWindow(url, title, iconPath, spawnAt) {
    if (!url) return null;
    const saved = (appSettings.externalWindows && appSettings.externalWindows[url]) || {};
    const width  = saved.width  || 1000;
    const height = saved.height || 700;

    let x = saved.x != null ? saved.x : undefined;
    let y = saved.y != null ? saved.y : undefined;

    const openForUrl = externalWindowsByUrl.get(url);
    const openCount = openForUrl ? openForUrl.size : 0;

    if (spawnAt && typeof spawnAt.screenX === 'number' && typeof spawnAt.screenY === 'number') {
      // Drop point: put the titlebar roughly under the cursor grab point.
      x = Math.round(spawnAt.screenX - Math.min(120, width / 2));
      y = Math.round(spawnAt.screenY - 16);
    } else if (openCount > 0 && x != null && y != null) {
      // Cascade extra windows of the same URL so they don't stack exactly.
      x += openCount * 30;
      y += openCount * 30;
    }

    // Keep the window on a visible display.
    if (x != null && y != null) {
      try {
        const { screen } = require('electron');
        const wa = screen.getDisplayNearestPoint({ x, y }).workArea;
        x = Math.max(wa.x, Math.min(x, wa.x + wa.width  - Math.min(width, wa.width)));
        y = Math.max(wa.y, Math.min(y, wa.y + wa.height - Math.min(height, wa.height)));
      } catch (e) {}
    }

    const win = new BrowserWindow({
      width, height,
      x: x != null ? x : undefined, y: y != null ? y : undefined,
      title: title || url, backgroundColor: '#141414'
    });
    win.setMenuBarVisibility(false);

    // Toolbar across the top, page beneath it in its own view. The page being a
    // child view is what lets the toolbar drive it from outside the page.
    const pageView = new WebContentsView({ webPreferences: { webSecurity: false, preload: path.join(__dirname, 'preload-zoom-shared.js') } });
    const toolbarView = createToolbarView();
    win.contentView.addChildView(pageView);
    win.contentView.addChildView(toolbarView);
    pageView.webContents.loadURL(url);
    // Zoom for this page is persisted per URL below; tell the shared handler to
    // leave it alone so a wheel tick is not applied twice.
    pageView.webContents._lkExternalPage = true;
    win._lkPage = pageView;

    const layoutExternalWindow = () => {
      if (win.isDestroyed()) return;
      const [w, h] = win.getContentSize();
      toolbarView.setBounds({ x: 0, y: 0, width: w, height: TOOLBAR_HEIGHT });
      pageView.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: w, height: Math.max(0, h - TOOLBAR_HEIGHT) });
    };
    layoutExternalWindow();
    ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore']
      .forEach(ev => win.on(ev, layoutExternalWindow));

    const pushToolbarState = wireToolbar(
      toolbarView,
      () => (win.isDestroyed() || pageView.webContents.isDestroyed() ? null : pageView.webContents),
      title || url,
      () => ({ canPin: false })   // ── Split view ── windows are already separate
    );
    ['did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading', 'page-title-updated']
      .forEach(ev => pageView.webContents.on(ev, pushToolbarState));
    wireFind(pageView, toolbarView);

    pageView.webContents.on('before-input-event', (event, input) => {
      if (isFindKey(input)) { event.preventDefault(); openFindBar(toolbarView); return; }
      const action = navKeyAction(input);
      if (!action) return;
      event.preventDefault();
      navigateExternalWindow(win, action);
    });

    // Mouse thumb buttons work here exactly as they do in a browser. (The game
    // view is the one place they are swallowed instead.)
    win.on('app-command', (event, command) => {
      if (command !== 'browser-backward' && command !== 'browser-forward') return;
      event.preventDefault();
      navigateExternalWindow(win, command === 'browser-backward' ? 'back' : 'forward');
    });
    applyAlwaysOnTop(win);
    applyWindowIcon(win, iconPath);
    // What this window would need to become a tab again.
    win._lkUrl = url; win._lkTitle = title; win._lkIcon = iconPath;

    // Right-click anywhere in the window → dock it back into the tab strip.
    pageView.webContents.on('context-menu', (event, params) => {
      const hist = navHistory(pageView.webContents);
      const template = [
        { label: 'Dock back into tabs', click: () => dockWindowIntoTabs(win) },
        { type: 'separator' },
        { label: 'Back', enabled: hist.canGoBack(), click: () => navigateExternalWindow(win, 'back') },
        { label: 'Forward', enabled: hist.canGoForward(), click: () => navigateExternalWindow(win, 'forward') },
        { label: 'Reload', click: () => navigateExternalWindow(win, 'reload') }
      ];
      if (params.selectionText) template.push({ label: 'Copy', role: 'copy' });
      Menu.buildFromTemplate(template).popup({ window: win });
    });

    // Drag the window over the tab strip and let go → dock it back. 'move' fires
    // throughout the drag, 'moved' once when it is released.
    win.on('move', () => { if (!win.isDestroyed()) setTabStripDropTarget(isCursorOverTabStrip()); });
    win.on('moved', () => {
      if (win.isDestroyed()) return;
      const overStrip = isCursorOverTabStrip();
      setTabStripDropTarget(false);
      // Let the native drag loop finish before closing the window out from under it.
      if (overStrip) setTimeout(() => dockWindowIntoTabs(win), 0);
    });

    if (!openForUrl) externalWindowsByUrl.set(url, new Set([win]));
    else openForUrl.add(win);

    if (!appSettings.externalWindows) appSettings.externalWindows = {};
    if (appSettings.externalZoom && appSettings.externalZoom[url]) pageView.webContents.once('did-finish-load', () => { try { pageView.webContents.setZoomFactor(appSettings.externalZoom[url]); } catch (e) {} });

    const saveExtBounds = () => {
      if (win && !win.isDestroyed() && !win.isMinimized()) {
        const b = win.getBounds();
        appSettings.externalWindows[url] = { width: b.width, height: b.height, x: b.x, y: b.y };
        saveSettingsDebounced();
      }
    };
    win.on('resized', saveExtBounds); win.on('moved', saveExtBounds);

    // Last one closed wins: write this window's final state as the stored one.
    win.on('close', () => {
      try {
        if (!win.isDestroyed() && !win.isMinimized()) {
          const b = win.getBounds();
          appSettings.externalWindows[url] = { width: b.width, height: b.height, x: b.x, y: b.y };
        }
        if (!win.isDestroyed() && !pageView.webContents.isDestroyed()) {
          if (!appSettings.externalZoom) appSettings.externalZoom = {};
          appSettings.externalZoom[url] = pageView.webContents.getZoomFactor();
        }
        saveSettings();
      } catch (e) { log.warn('Failed to save external window state:', e.message); }
    });
    win.on('closed', () => {
      releaseToolbar(toolbarView);
      const set = externalWindowsByUrl.get(url);
      if (set) { set.delete(win); if (set.size === 0) externalWindowsByUrl.delete(url); }
    });

    pageView.webContents.on('ipc-message', (event, channel, data) => {
      if (channel === 'zoom-wheel' && data && typeof data.deltaY === 'number') {
        const newFactor = getNextZoomStep(pageView.webContents.getZoomFactor(), data.deltaY < 0);
        pageView.webContents.setZoomFactor(newFactor);
        if (!appSettings.externalZoom) appSettings.externalZoom = {};
        appSettings.externalZoom[url] = newFactor; saveSettingsDebounced();
      }
    });
    return win;
  }

  // Back / forward / reload for a torn-off window's page.
  function navigateExternalWindow(win, action) {
    if (!win || win.isDestroyed() || !win._lkPage) return;
    navigateWebContents(win._lkPage.webContents, action);
  }

  // The mirror of tear-off. The window already knows its url, title and icon -
  // exactly what createTab() needs - so docking is close-window + make-tab.
  // Closing normally (rather than destroying) lets the window save its bounds
  // and zoom on the way out, so tearing it off again restores how it was.
  function dockWindowIntoTabs(win) {
    if (!win || win.isDestroyed() || !win._lkUrl) return;
    const { _lkUrl: url, _lkTitle: title, _lkIcon: icon } = win;
    setTabStripDropTarget(false);
    win.close();
    createTab(url, title, icon);
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
    log.info('Docked window back into tabs:', title || url);
  }

  ipcMain.on('open-external', (event, url, title, iconPath) => {
    openExternalWindow(url, title, iconPath);
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

app.on('will-quit', () => {
  flushSettings();
  BrowserWindow.getAllWindows().forEach(win => {
    try { if (!win.isDestroyed()) win.destroy(); } catch (e) {}
  });
  globalShortcut.unregisterAll();
});
