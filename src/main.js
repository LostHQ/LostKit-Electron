const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell, globalShortcut } = require('electron');
const mousecam = require('./native-mousecam');
const hover = require('./native-hover');
const log = require('electron-log');
const path = require('path');
const fs = require('fs');
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
let navPanelCollapsed = false;
let navPanelPrevX = null;

log.transports.file.level = 'info';

const VERSION_CHECK_URL = 'https://raw.githubusercontent.com/LostHQ/LostKit-Electron/main/version.json';

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

async function checkForUpdates() {
  try {
    log.info('Checking for updates...');
    const response = await fetch(VERSION_CHECK_URL + '?t=' + Date.now());
    if (!response.ok) { log.info('Version check failed:', response.status); return; }
    const data = await response.json();
    const latestVersion = data.version;
    const downloadUrl = data.url || 'https://github.com/LostHQ/LostKit-Electron/releases';
    if (latestVersion && compareVersions(latestVersion, version) > 0) {
      log.info('New version available:', latestVersion);
      if (mainWindow) {
        const choice = dialog.showMessageBoxSync(mainWindow, {
          type: 'info', buttons: ['Later', 'Download Now'], defaultId: 1, cancelId: 0,
          title: 'Update Available',
          message: `A new version (v${latestVersion}) is available!`,
          detail: `You are currently using v${version}. Click "Download Now" to get the latest version.`
        });
        if (choice === 1) shell.openExternal(downloadUrl);
      }
    } else {
      log.info('App is up to date. Current:', version);
    }
  } catch (e) {
    log.error('Version check failed:', e.message);
  }
}

const settingsPath = path.join(process.env.APPDATA || process.env.HOME || '.', '.lostkit-settings.json');
let appSettings = {
  mainWindow: { width: 1100, height: 920, x: null, y: null },
  zoomFactor: 1, tabZoom: {}, externalZoom: {}, chatZoom: 1,
  chatHeight: 300, chatVisible: true,
  lastWorld: { url: 'https://w2-2004.lostcity.rs/rs2.cgi?plugin=0&world=2&lowmem=0', title: 'W2 HD' },
  soundManagerWindow: { width: 450, height: 500 }, notesWindow: { width: 500, height: 600 },
  screenshotFolder: '', screenshotKeybind: '', mousecamEnabled: false,
  screenshotSoundEnabled: true, screenshotSoundVolume: 80, screenshotCustomSoundPath: ''
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
  } catch (e) { log.error('Failed to load settings:', e); }
}

function saveSettings() {
  try { fs.writeFileSync(settingsPath, JSON.stringify(appSettings, null, 2), 'utf8'); }
  catch (e) { log.error('Failed to save settings:', e); }
}

function saveSettingsDebounced() {
  if (saveSettingsDebounced.timer) clearTimeout(saveSettingsDebounced.timer);
  saveSettingsDebounced.timer = setTimeout(saveSettings, 500);
}

if (require('electron-squirrel-startup')) app.quit();

let mainWindow;
let afkGameClick = false;
let afkInputType = 'hover'; // always hover — mouse/keyboard options removed
let afkHover = true;
let hoverPaused = false;
let soundAlert = false;
let soundVolume = 60;
let customSoundPath = '';
let defaultPackagedSoundPath = '';

// Game-click AFK timer (legacy — kept for stopwatch panel IPC compatibility)
let gameClickTimerRunning = false;
let gameClickTimerInterval = null;
let gameClickTimerSeconds = 0;
let gameClickAlertTriggeredInCycle = false;
let alertThreshold = 10;

// Unified background timer — drives the stopwatch panel display AND the titlebar
let backgroundTimerInterval = null;
let backgroundTimerSeconds = 0;
let backgroundTimerMode = 'afk';
let backgroundTimerRunning = false;
let backgroundCountdownTime = 90;
let backgroundAlertTriggered = false;
let backgroundAutoLoop = false;
let backgroundTimerStartTime = null;

const baseWindowTitle = `LostKit 2 v${version} - by LostHQ Team`;

function formatWindowTitleTime(totalSeconds) {
  const mins = Math.floor(Math.abs(totalSeconds) / 60);
  const secs = Math.abs(totalSeconds) % 60;
  const sign = totalSeconds < 0 ? '-' : '';
  return `${sign}${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function updateWindowTitleWithTimer(running, seconds, mode, countdownTime) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!running) { mainWindow.setTitle(baseWindowTitle); return; }
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
  mainWindow.setTitle(`${baseWindowTitle}  |  ${modeLabel}: ${displayValue}`);
}

let primaryViews = [];
let navView, chatView;
let soundManagerWindow = null, notesWindow = null;

const defaultWorldUrl = 'https://w2-2004.lostcity.rs/rs2.cgi?plugin=0&world=2&lowmem=0';
const defaultWorldTitle = 'W2 HD';
let tabs = [{ id: 'main', url: defaultWorldUrl, title: defaultWorldTitle }];
let tabByUrl = new Map([[defaultWorldUrl, 'main']]);
let externalWindowsByUrl = new Map();
let currentTab = 'main';
let chatVisible = true;
let chatHeightValue = 300;

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

function updateBounds() {
  const contentBounds = mainWindow.getContentBounds();
  const width = contentBounds.width, height = contentBounds.height;
  const navWidth = navPanelCollapsed ? 0 : NAV_PANEL_WIDTH;
  const tabHeight = 28;
  const chatHeight = chatVisible ? chatHeightValue : 0;
  const dividerHeight = chatVisible ? 3 : 0;
  const primaryWidth = width - navWidth;
  const primaryHeight = height - tabHeight - chatHeight - dividerHeight;
  primaryViews.forEach(({ view }) => view.setBounds({ x: 0, y: tabHeight, width: primaryWidth, height: primaryHeight }));
  if (!navPanelCollapsed) { navView.setVisible(true); navView.setBounds({ x: primaryWidth, y: 0, width: navWidth, height: height }); }
  else { navView.setVisible(false); }
  chatView.setBounds({ x: 0, y: height - chatHeight, width: primaryWidth, height: chatHeight });
  mainWindow.webContents.send('update-resizer', chatHeight);
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

  if (typeof appSettings.navPanelCollapsed === 'boolean') navPanelCollapsed = appSettings.navPanelCollapsed;

  ipcMain.on('toggle-nav-panel', () => {
    navPanelCollapsed = !navPanelCollapsed;
    appSettings.navPanelCollapsed = navPanelCollapsed;
    saveSettingsDebounced();
    const bounds = mainWindow.getBounds();
    const { screen } = require('electron');
    const display = screen.getDisplayMatching(bounds);
    const displayRight = display.workArea.x + display.workArea.width;
    log.info('--- NAV PANEL TOGGLE ---');
    log.info('Window bounds:', bounds);
    log.info('Display workArea:', display.workArea);
    if (navPanelCollapsed) {
      let restoreX = bounds.x;
      if (navPanelPrevX !== null) { restoreX = navPanelPrevX; navPanelPrevX = null; }
      mainWindow.setBounds({ width: Math.max(bounds.width - NAV_PANEL_WIDTH, 800), height: bounds.height, x: restoreX, y: bounds.y });
    } else {
      let newX = bounds.x;
      const expandedRight = bounds.x + bounds.width + NAV_PANEL_WIDTH;
      if (expandedRight > displayRight) { navPanelPrevX = bounds.x; newX = bounds.x - (expandedRight - displayRight); }
      else { navPanelPrevX = null; }
      mainWindow.setBounds({ width: bounds.width + NAV_PANEL_WIDTH, height: bounds.height, x: newX, y: bounds.y });
    }
    updateBounds();
    navView.webContents.send('nav-panel-collapsed', navPanelCollapsed);
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
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

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
  function takeScreenshot() {
    const mainPV = primaryViews.find(p => p.id === currentTab);
    if (!mainPV || !mainPV.view || !mainPV.view.webContents) return;
    mainPV.view.webContents.capturePage().then((image) => {
      const folder = getScreenshotFolder();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filepath = path.join(folder, `screenshot-${timestamp}.png`);
      try {
        fs.writeFileSync(filepath, image.toPNG());
        log.info('Screenshot saved:', filepath);
        // Play screenshot sound if enabled
        if (appSettings.screenshotSoundEnabled !== false) {
          const vol = appSettings.screenshotSoundVolume !== undefined ? appSettings.screenshotSoundVolume : 80;
          const custom = appSettings.screenshotCustomSoundPath;
          // Use custom sound if set and exists, otherwise fall back to bloom
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
          } else if (!soundPath) {
            log.warn('Screenshot sound not found');
          }
        }
      } catch (e) { log.error('Failed to save screenshot:', e); }
    }).catch(e => log.error('capturePage failed:', e));
  }
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

  // ── Settings popup ──────────────────────────────────────────────────────────
  let settingsWindow = null;
  ipcMain.on('open-settings-popup', () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.focus(); return; }
    const settingsBounds = appSettings.settingsWindow || { width: 600, height: 500 };
    settingsWindow = new BrowserWindow({
      width: settingsBounds.width || 600, height: settingsBounds.height || 500,
      x: settingsBounds.x != null ? settingsBounds.x : undefined, y: settingsBounds.y != null ? settingsBounds.y : undefined,
      autoHideMenuBar: true, webPreferences: { nodeIntegration: true, contextIsolation: false }, title: 'LostKit - Settings'
    });
    settingsWindow.loadFile(path.join(__dirname, 'navitems/stopwatch-settings.html'));
    const saveSettingsBounds = () => {
      if (settingsWindow && !settingsWindow.isDestroyed() && !settingsWindow.isMinimized()) {
        const b = settingsWindow.getBounds();
        appSettings.settingsWindow = { width: b.width, height: b.height, x: b.x, y: b.y }; saveSettings();
      }
    };
    settingsWindow.on('resize', saveSettingsBounds); settingsWindow.on('move', saveSettingsBounds);
    settingsWindow.on('closed', () => { settingsWindow = null; });
    settingsWindow.webContents.on('did-finish-load', () => {
      settingsWindow.webContents.send('load-settings', {
        adventureCaptureEnabled: appSettings.adventureCaptureEnabled || false,
        screenshotFolder: appSettings.screenshotFolder || '',
        captureInterval: appSettings.captureInterval || 60,
        randomInterval: appSettings.randomInterval || false,
        createAdventureFolder: appSettings.createAdventureFolder !== false,
        mousecamEnabled: appSettings.mousecamEnabled || false,
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
    if (typeof settings.mousecamEnabled === 'boolean') {
      const wasEnabled = appSettings.mousecamEnabled;
      appSettings.mousecamEnabled = settings.mousecamEnabled;
      if (settings.mousecamEnabled && !wasEnabled) mousecam.start();
      else if (!settings.mousecamEnabled && wasEnabled) mousecam.stop();
    }
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
    let delay;
    if (appSettings.randomInterval) {
      const baseInterval = (appSettings.captureInterval || 60) * 1000;
      const minDelay = 10000, maxDelay = Math.max(baseInterval * 3, 300000);
      delay = Math.floor(minDelay + ((Math.random() + Math.random()) / 2) * (maxDelay - minDelay));
    } else { delay = (appSettings.captureInterval || 60) * 1000; }
    adventureCaptureTimer = setTimeout(() => { captureAdventureScreenshot(); scheduleAdventureCapture(); }, delay);
  }
  function captureAdventureScreenshot() {
    const mainPV = primaryViews.find(p => p.id === currentTab);
    if (!mainPV || !mainPV.view || !mainPV.view.webContents) return;
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yy = String(now.getFullYear()).slice(-2);
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const dayFolder = `${dd}-${mm}-${yy}`;
    const filename = `${dd}-${mm}-${yy}_${hh}-${min}-${ss}.png`;

    mainPV.view.webContents.capturePage().then((image) => {
      let folderPath = getScreenshotFolder();
      if (appSettings.createAdventureFolder) folderPath = path.join(folderPath, 'Adventure Capture', dayFolder);
      fs.mkdir(folderPath, { recursive: true }, (err) => {
        if (err) { console.error('Error creating adventure capture folder:', err); return; }
        fs.writeFile(path.join(folderPath, filename), image.toPNG(), (err) => {
          if (err) console.error('Error saving adventure screenshot:', err);
          else console.log('Adventure screenshot saved:', filename);
        });
      });
    }).catch(e => console.error('Adventure capturePage failed:', e));
  }
  ipcMain.on('save-screenshot', (event, dataUrl) => {
    if (!dataUrl) return;
    const folder = getScreenshotFolder();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filepath = path.join(folder, `screenshot-${timestamp}.png`);
    try { fs.writeFileSync(filepath, dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'); log.info('Screenshot saved:', filepath); }
    catch (e) { log.error('Failed to save screenshot:', e); }
  });

  setTimeout(() => checkForUpdates(), 3000);
  updateAdventureCapture();

  navView = new WebContentsView({ webPreferences: { nodeIntegration: true, contextIsolation: false } });
  navView.webContents.loadFile(path.join(__dirname, 'nav.html'));
  mainWindow.contentView.addChildView(navView);

  chatView = new WebContentsView({ webPreferences: { webSecurity: false, preload: path.join(__dirname, 'preload-zoom-shared.js') } });
  chatView.webContents.loadURL('https://irc.losthq.rs');
  chatView.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  mainWindow.contentView.addChildView(chatView);
  chatView.setVisible(true);
  if (appSettings.chatZoom && appSettings.chatZoom !== 1) {
    chatView.webContents.once('did-finish-load', () => { try { chatView.webContents.setZoomFactor(appSettings.chatZoom); } catch (e) {} });
  }

  const mainView = new WebContentsView({ webPreferences: { webSecurity: false, preload: path.join(__dirname, 'gameview-preload.js') } });
  const startWorldUrl = tabs[0].url, startWorldTitle = tabs[0].title;
  mainView.webContents.loadURL(startWorldUrl);
  mainView.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  mainWindow.contentView.addChildView(mainView);
  primaryViews.push({ id: 'main', view: mainView });
  if (appSettings.zoomFactor && appSettings.zoomFactor !== 1) mainView.webContents.once('did-finish-load', () => { try { mainView.webContents.setZoomFactor(appSettings.zoomFactor); } catch (e) {} });
  if (appSettings.tabZoom && appSettings.tabZoom[startWorldUrl]) mainView.webContents.once('did-finish-load', () => { try { mainView.webContents.setZoomFactor(appSettings.tabZoom[startWorldUrl]); } catch (e) {} });

  // ── AFK input detection — host-level only, nothing injected into the game ──
  // before-input-event fires in the main process before the event reaches the
  // page, so we never need to touch the game's DOM or JS context.
  mainView.webContents.on('before-input-event', (event, input) => {
    // ── Block accidental navigation shortcuts on the game tab ──────────────
    // Suppress Alt+Left, Alt+Right (back/forward), F5, Ctrl+R (refresh),
    // Ctrl+Shift+R (hard refresh), Backspace (back), Alt+F4 handled by OS.
    if (input.type === 'keyDown') {
      const ctrl  = input.control || input.meta;
      const alt   = input.alt;
      const shift = input.shift;
      const key   = input.key;

      const isNavigation = (
        (alt && (key === 'ArrowLeft' || key === 'ArrowRight')) ||
        (key === 'F5') ||
        (ctrl && !shift && key === 'r') ||
        (ctrl && shift && key === 'r') ||
        (ctrl && shift && key === 'R')
      );

      if (isNavigation) {
        event.preventDefault();
        return;
      }

      // ── Ctrl+0 — reset zoom to 100% ──────────────────────────────────────
      if (ctrl && key === '0') {
        event.preventDefault();
        mainView.webContents.setZoomFactor(1.0);
        appSettings.zoomFactor = 1.0;
        saveSettingsDebounced();
        log.info('Zoom reset to 100%');
        return;
      }
    }

    // ── AFK timer reset on click/keypress ────────────────────────────────
    if (input.type !== 'mouseDown' && input.type !== 'keyDown') return;
    if (!afkGameClick || afkHover) return;
    if (input.type === 'mouseDown') {
      resetGameClickTimer();
      if (navView && navView.webContents) navView.webContents.send('afk-game-click-reset');
    } else if (input.type === 'keyDown' && afkInputType === 'both') {
      resetGameClickTimer();
      if (navView && navView.webContents) navView.webContents.send('afk-game-click-reset');
    }
  });

  const saveMainWindowBounds = () => {
    if (mainWindow && !mainWindow.isMinimized() && !mainWindow.isMaximized()) {
      const b = mainWindow.getBounds();
      appSettings.mainWindow = { width: b.width, height: b.height, x: b.x, y: b.y };
      saveSettingsDebounced();
    }
  };
  mainWindow.on('resized', saveMainWindowBounds);
  mainWindow.on('moved', saveMainWindowBounds);
  mainWindow.webContents.send('update-active', 'main');
  mainWindow.webContents.send('update-tab-title', 'main', startWorldTitle);
  updateBounds();
  mainWindow.webContents.send('chat-toggled', chatVisible, chatHeightValue);
  if (appSettings.mousecamEnabled) mousecam.start();
  mainWindow.on('resize', () => updateBounds());

  // ══════════════════════════════════════════════════════════════════════════════
  // GAME-CLICK AFK TIMER (legacy — kept for stopwatch panel IPC compatibility)
  // ══════════════════════════════════════════════════════════════════════════════

  function startGameClickTimer() {
    if (gameClickTimerRunning) { console.log('Game-click timer already running, continuing'); return; }
    gameClickTimerRunning = true;
    gameClickTimerSeconds = 0;
    gameClickAlertTriggeredInCycle = false;
    console.log('Starting game-click background timer');
    gameClickTimerInterval = setInterval(tickGameClickTimer, 1000);
    // Only update titlebar if background timer isn't running (avoids conflict)
    if (!backgroundTimerRunning) updateWindowTitleWithTimer(true, 0, 'afk', 90);
  }

  function tickGameClickTimer() {
    gameClickTimerSeconds++;
    if (navView && navView.webContents) navView.webContents.send('game-click-timer-tick', gameClickTimerSeconds);

    // FIX: Background timer owns the titlebar when running — prevents the two
    // timers fighting each other and causing the titlebar to drift out of sync
    // with what the stopwatch panel shows.
    if (!backgroundTimerRunning) {
      updateWindowTitleWithTimer(true, gameClickTimerSeconds, 'afk', 90);
    }

    const safeThreshold = Math.max(1, Math.min(89, parseInt(alertThreshold, 10) || 10));
    const thresholdTime = 90 - safeThreshold;
    if (!gameClickAlertTriggeredInCycle && gameClickTimerSeconds >= thresholdTime && gameClickTimerSeconds < 90) {
      gameClickAlertTriggeredInCycle = true;
      console.log('Game-click timer reached threshold, alerting');
      triggerGameClickAlert();
    }
    if (gameClickTimerSeconds === 90) console.log('Game-click timer reached 90s, continuing to count for negative display');
  }

  function resetGameClickTimer() {
    if (gameClickTimerRunning) {
      gameClickTimerSeconds = 0;
      gameClickAlertTriggeredInCycle = false;
      console.log('Game-click timer reset to 0');
      if (navView && navView.webContents) navView.webContents.send('game-click-timer-tick', 0);
      if (!backgroundTimerRunning) updateWindowTitleWithTimer(true, 0, 'afk', 90);
    } else if (afkGameClick) {
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

  // ── Hover ENTER / UN-IDLE — pause timers, show 1:30 frozen ───────────────
  function pauseTimerForHover() {
    if (!afkGameClick || !afkHover) return;

    // Stop & reset both timers (do NOT restart yet)
    if (gameClickTimerInterval) { clearInterval(gameClickTimerInterval); gameClickTimerInterval = null; }
    gameClickTimerSeconds = 0;
    gameClickAlertTriggeredInCycle = false;

    if (backgroundTimerInterval) { clearInterval(backgroundTimerInterval); backgroundTimerInterval = null; }
    backgroundTimerSeconds = 0;
    backgroundTimerStartTime = null;
    backgroundAlertTriggered = false;

    hoverPaused = true;
    console.log('hover: cursor ENTERED/MOVED in game view — timers paused, showing 1:30');

    // Push 0 to stopwatch panel → shows 1:30, paused
    if (navView && navView.webContents) {
      navView.webContents.send('background-timer-tick', { seconds: 0, mode: backgroundTimerMode, countdownTime: backgroundCountdownTime });
      navView.webContents.send('game-click-timer-tick', 0);
      navView.webContents.send('afk-hover-paused');
    }

    updateWindowTitleWithTimer(true, 0, 'afk', 90);
  }

  // ── Hover IDLE — mouse stopped moving inside canvas: reset to 1:30 and START ─
  function idleInCanvas() {
    if (!afkGameClick || !afkHover) return;
    // Whether paused or not, restart timers fresh from 0
    if (gameClickTimerInterval) clearInterval(gameClickTimerInterval);
    gameClickTimerSeconds = 0;
    gameClickAlertTriggeredInCycle = false;
    gameClickTimerRunning = true;
    gameClickTimerInterval = setInterval(tickGameClickTimer, 1000);

    if (backgroundTimerInterval) clearInterval(backgroundTimerInterval);
    backgroundTimerSeconds = 0;
    backgroundAlertTriggered = false;
    backgroundTimerStartTime = Date.now();
    if (backgroundTimerRunning) {
      backgroundTimerInterval = setInterval(tickBackgroundTimer, 1000);
    }

    hoverPaused = false;
    console.log('hover: cursor IDLE in game view — timers reset & started from 1:30');

    if (navView && navView.webContents) {
      navView.webContents.send('background-timer-tick', { seconds: 0, mode: backgroundTimerMode, countdownTime: backgroundCountdownTime });
      navView.webContents.send('game-click-timer-tick', 0);
      navView.webContents.send('afk-hover-resumed');
    }

    updateWindowTitleWithTimer(true, 0, 'afk', 90);
  }

  // ── Hover LEAVE — mouse left canvas: reset to 1:30 and START countdown ─────
  function resumeTimerFromHover() {
    if (!afkGameClick || !afkHover) return;
    hoverPaused = false;

    // Reset & restart both timers from 0
    if (gameClickTimerInterval) clearInterval(gameClickTimerInterval);
    gameClickTimerSeconds = 0;
    gameClickAlertTriggeredInCycle = false;
    gameClickTimerRunning = true;
    gameClickTimerInterval = setInterval(tickGameClickTimer, 1000);

    if (backgroundTimerInterval) clearInterval(backgroundTimerInterval);
    backgroundTimerSeconds = 0;
    backgroundAlertTriggered = false;
    backgroundTimerStartTime = Date.now();
    if (backgroundTimerRunning) {
      backgroundTimerInterval = setInterval(tickBackgroundTimer, 1000);
    }

    console.log('hover: cursor LEFT game view — timers reset & started from 1:30');

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

    // Background timer owns the titlebar — 1:1 sync with stopwatch panel guaranteed
    updateWindowTitleWithTimer(backgroundTimerRunning, backgroundTimerSeconds, backgroundTimerMode, backgroundCountdownTime);

    if (backgroundTimerMode === 'afk') {
      const thresholdTime = 90 - alertThreshold;
      if (!backgroundAlertTriggered && backgroundTimerSeconds >= thresholdTime) {
        backgroundAlertTriggered = true;
        console.log('AFK background timer reached threshold, alerting');
        triggerBackgroundAlert();
      }
      // AFK mode: continues counting past 90 for negative display — no auto-loop

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
      gameClickAlertTriggeredInCycle = false;
      console.log('Game-click timer manually reset to 0');
      if (navView && navView.webContents) navView.webContents.send('game-click-timer-tick', 0);
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
      gameClickTimerInterval = setInterval(tickGameClickTimer, 1000);
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
          if (afkHover) hover.start(() => getGameViewAbsoluteBounds(), pauseTimerForHover, resumeTimerFromHover, idleInCanvas, 2000);
        } else {
          if (hoverPaused) hoverPaused = false;
          stopGameClickTimer();
          if (afkHover) hover.stop();
        }
      }
    }
    if (setting === 'afkInputType') {
      // always hover — other modes removed
      afkInputType = 'hover';
      afkHover = true;
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
  // ── Zoom IPC ────────────────────────────────────────────────────────────────
  ipcMain.on('zoom-wheel', (event, data) => {
    try {
      const senderWC = event.sender;
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
    chatVisible = !chatVisible;
    chatView.setVisible(chatVisible);
    appSettings.chatVisible = chatVisible;
    saveSettingsDebounced();
    updateBounds();
    mainWindow.webContents.send('chat-toggled', chatVisible, chatHeightValue);
  });

  // ── Tab IPC ─────────────────────────────────────────────────────────────────
  ipcMain.on('add-tab', (event, url, customTitle) => {
    const existingId = tabByUrl.get(url);
    if (existingId) {
      const pv = primaryViews.find(pv => pv.id === existingId);
      if (pv) { primaryViews.forEach(({ view }) => view.setVisible(false)); pv.view.setVisible(true); currentTab = existingId; mainWindow.webContents.send('update-active', existingId); return; }
      else { tabByUrl.delete(url); }
    }
    const id = Date.now().toString(), title = customTitle || url;
    tabs.push({ id, url, title }); tabByUrl.set(url, id);
    const newView = new WebContentsView({ webPreferences: { webSecurity: false, preload: path.join(__dirname, 'preload-zoom-shared.js') } });
    newView.webContents.loadURL(url);
    newView.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
    mainWindow.contentView.addChildView(newView);
    primaryViews.push({ id, view: newView });
    if (appSettings.tabZoom && appSettings.tabZoom[url]) newView.webContents.once('did-finish-load', () => { try { newView.webContents.setZoomFactor(appSettings.tabZoom[url]); } catch (e) {} });
    primaryViews.forEach(({ view }) => view.setVisible(false));
    newView.setVisible(true); currentTab = id;
    mainWindow.webContents.send('add-tab', id, title);
    mainWindow.webContents.send('update-active', id);
    if (!customTitle) newView.webContents.on('page-title-updated', (event, pageTitle) => { const t = tabs.find(t => t.id === id); if (t) t.title = pageTitle; mainWindow.webContents.send('update-tab-title', id, pageTitle); });
    updateBounds();
  });

  ipcMain.on('close-tab', (event, id) => {
    if (id !== 'main') {
      const removedTab = tabs.find(t => t.id === id);
      tabs = tabs.filter(t => t.id !== id);
      const index = primaryViews.findIndex(pv => pv.id === id);
      if (index !== -1) {
        if (removedTab && tabByUrl.get(removedTab.url) === id) tabByUrl.delete(removedTab.url);
        mainWindow.contentView.removeChildView(primaryViews[index].view);
        primaryViews.splice(index, 1);
      }
      mainWindow.webContents.send('close-tab', id);
      updateBounds();
      if (currentTab === id) ipcMain.emit('switch-tab', event, 'main');
    }
  });

  ipcMain.on('switch-tab', (event, id) => {
    currentTab = id;
    primaryViews.forEach(({ view }) => view.setVisible(false));
    const cv = primaryViews.find(pv => pv.id === id);
    if (cv) cv.view.setVisible(true);
    mainWindow.webContents.send('update-active', id);
  });

  ipcMain.on('switch-nav-view', (event, view) => {
    switch (view) {
      case 'worldswitcher': navView.webContents.loadFile(path.join(__dirname, '/navitems/worldswitcher.html')); break;
      case 'hiscores':      navView.webContents.loadFile(path.join(__dirname, '/navitems/hiscores.html')); break;
      case 'stopwatch':     navView.webContents.loadFile(path.join(__dirname, '/navitems/stopwatch.html')); break;
      default:              navView.webContents.loadFile(path.join(__dirname, 'nav.html')); break;
    }
  });

  ipcMain.on('select-world', (event, url, title) => {
    const currentTabData = tabs.find(t => t.id === currentTab);
    if (currentTabData.url === url) return;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning', buttons: ['Cancel', 'Continue'], defaultId: 1,
      title: 'Switch World', message: 'Make sure you are logged out before switching worlds!'
    });
    if (choice === 1) {
      tabByUrl.delete(currentTabData.url);
      currentTabData.url = url; currentTabData.title = title; tabByUrl.set(url, currentTab);
      const cv = primaryViews.find(pv => pv.id === currentTab);
      if (cv) cv.view.webContents.loadURL(url);
      if (currentTab === 'main') { appSettings.lastWorld = { url, title }; saveSettingsDebounced(); }
      mainWindow.webContents.send('update-tab-title', currentTab, title);
      ipcMain.emit('switch-nav-view', null, 'nav');
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  ipcMain.on('set-chat-height', (event, height) => { chatHeightValue = Math.max(200, Math.min(height, 800)); appSettings.chatHeight = chatHeightValue; saveSettingsDebounced(); updateBounds(); });
  ipcMain.on('update-chat-height', (event, height) => { chatHeightValue = Math.max(200, Math.min(800, height)); appSettings.chatHeight = chatHeightValue; saveSettingsDebounced(); updateBounds(); });

  ipcMain.on('open-external', (event, url, title) => {
    const existing = externalWindowsByUrl.get(url);
    if (existing && !existing.isDestroyed()) { existing.focus(); return; }
    const extBounds = appSettings.externalWindows && appSettings.externalWindows[url] ? appSettings.externalWindows[url] : { width: 1000, height: 700 };
    const win = new BrowserWindow({
      width: extBounds.width || 1000, height: extBounds.height || 700,
      x: extBounds.x != null ? extBounds.x : undefined, y: extBounds.y != null ? extBounds.y : undefined,
      title: title || url, webPreferences: { webSecurity: false, preload: path.join(__dirname, 'preload-zoom-shared.js') }
    });
    win.loadURL(url); win.setMenuBarVisibility(false);
    externalWindowsByUrl.set(url, win);
    if (!appSettings.externalWindows) appSettings.externalWindows = {};
    if (appSettings.externalZoom && appSettings.externalZoom[url]) win.webContents.once('did-finish-load', () => { try { win.webContents.setZoomFactor(appSettings.externalZoom[url]); } catch (e) {} });
    const saveExtBounds = () => {
      if (win && !win.isDestroyed() && !win.isMinimized()) {
        const b = win.getBounds();
        appSettings.externalWindows[url] = { width: b.width, height: b.height, x: b.x, y: b.y };
        saveSettingsDebounced();
      }
    };
    win.on('resized', saveExtBounds); win.on('moved', saveExtBounds);
    win.on('closed', () => { if (externalWindowsByUrl.get(url) === win) externalWindowsByUrl.delete(url); });
    win.webContents.on('ipc-message', (event, channel, data) => {
      if (channel === 'zoom-wheel' && data && typeof data.deltaY === 'number') {
        const newFactor = getNextZoomStep(win.webContents.getZoomFactor(), data.deltaY < 0);
        win.webContents.setZoomFactor(newFactor);
        if (!appSettings.externalZoom) appSettings.externalZoom = {};
        appSettings.externalZoom[url] = newFactor; saveSettingsDebounced();
      }
    });
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

app.on('will-quit', () => {
  mousecam.destroy();
  hover.destroy();
  globalShortcut.unregisterAll();
});
