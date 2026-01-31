const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell } = require('electron');
const log = require('electron-log');
const path = require('path');
const fs = require('fs');
const version = require('../package.json').version;

// Settings persistence
const settingsPath = path.join(process.env.APPDATA || process.env.HOME || '.', '.lostkit-settings.json');
let appSettings = {
  mainWindow: { width: 1100, height: 920, x: null, y: null },
  zoomFactor: 1,
  chatHeight: 300,
  chatVisible: true,
  zoomInvert: false,
  lastWorld: { url: 'https://w2-2004.lostcity.rs/rs2.cgi?plugin=0&world=2&lowmem=0', title: 'W2 HD' },
  soundManagerWindow: { width: 450, height: 500 },
  notesWindow: { width: 500, height: 600 },
  externalWindows: {}
};

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf8');
      const loaded = JSON.parse(data);
      appSettings = { ...appSettings, ...loaded };
      log.info('Settings loaded from', settingsPath);
    }
  } catch (e) {
    log.error('Failed to load settings:', e);
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(appSettings, null, 2), 'utf8');
  } catch (e) {
    log.error('Failed to save settings:', e);
  }
}

function saveSettingsDebounced() {
  if (saveSettingsDebounced.timer) clearTimeout(saveSettingsDebounced.timer);
  saveSettingsDebounced.timer = setTimeout(saveSettings, 500);
}

// Configure logging
log.transports.file.level = 'info';

// Version check URL (raw GitHub - no rate limits, with cache busting)
const VERSION_CHECK_URL = 'https://raw.githubusercontent.com/LostHQ/LostKit-Electron/main/version.json';

async function checkForUpdates() {
  try {
    log.info('Checking for updates...');
    // Add timestamp to bust GitHub's CDN cache
    const response = await fetch(VERSION_CHECK_URL + '?t=' + Date.now());
    if (!response.ok) {
      log.info('Version check failed: server returned', response.status);
      return;
    }
    const data = await response.json();
    const latestVersion = data.version;
    const downloadUrl = data.url || 'https://github.com/LostHQ/LostKit-Electron/releases';
    
    if (latestVersion && compareVersions(latestVersion, version) > 0) {
      log.info('New version available:', latestVersion);
      // Show update notification
      if (mainWindow) {
        const choice = dialog.showMessageBoxSync(mainWindow, {
          type: 'info',
          buttons: ['Later', 'Download Now'],
          defaultId: 1,
          cancelId: 0,
          title: 'Update Available',
          message: `A new version (v${latestVersion}) is available!`,
          detail: `You are currently using v${version}. Click "Download Now" to get the latest version.`
        });
        
        if (choice === 1) {
          shell.openExternal(downloadUrl);
        }
      }
    } else {
      log.info('App is up to date. Current:', version);
    }
  } catch (e) {
    log.error('Version check failed:', e.message);
  }
}

// Simple version comparison (returns 1 if a > b, -1 if a < b, 0 if equal)
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

// Handle Squirrel installer events on Windows (for electron-forge compatibility)
if (require('electron-squirrel-startup')) {
  app.quit();
}

let mainWindow;
let afkAuto = false;
let zoomInvert = false; // allow flipping wheel direction if device reports inverted deltas
let soundAlert = false;
let soundVolume = 60;
let customSoundPath = '';
let afkTimerRunning = false;
let afkTimerInterval = null;
let afkTimerSeconds = 0;
let primaryViews = [];
let navView;
let chatView;
let soundManagerWindow = null;
let notesWindow = null;

// Default world - will be overridden by saved settings
const defaultWorldUrl = 'https://w2-2004.lostcity.rs/rs2.cgi?plugin=0&world=2&lowmem=0';
const defaultWorldTitle = 'W2 HD';
let tabs = [{ id: 'main', url: defaultWorldUrl, title: defaultWorldTitle }];
let tabByUrl = new Map([[defaultWorldUrl, 'main']]);
let externalWindowsByUrl = new Map();
let currentTab = 'main';
let chatVisible = true;
let chatHeightValue = 300;

// Load settings early
loadSettings();
chatHeightValue = appSettings.chatHeight || 300;
chatVisible = appSettings.chatVisible !== false;
zoomInvert = appSettings.zoomInvert || false;

// Apply saved last world
if (appSettings.lastWorld && appSettings.lastWorld.url) {
  tabs[0].url = appSettings.lastWorld.url;
  tabs[0].title = appSettings.lastWorld.title || 'World';
  tabByUrl.clear();
  tabByUrl.set(tabs[0].url, 'main');
}

function updateBounds() {
  const contentBounds = mainWindow.getContentBounds();
  const width = contentBounds.width;
  const height = contentBounds.height;
  const navWidth = 250;
  const tabHeight = 28;
  const chatHeight = chatVisible ? chatHeightValue : 0;
  const dividerHeight = chatVisible ? 3 : 0;
  const primaryWidth = width - navWidth;
  const primaryHeight = height - tabHeight - chatHeight - dividerHeight;

  primaryViews.forEach(({ view }) => {
    view.setBounds({ x: 0, y: tabHeight, width: primaryWidth, height: primaryHeight });
  });
  navView.setBounds({ x: primaryWidth, y: 0, width: navWidth, height: height });
  chatView.setBounds({ x: 0, y: height - chatHeight, width: primaryWidth, height: chatHeight });
  mainWindow.webContents.send('update-resizer', chatHeight);
}

app.whenReady().then(() => {
  const savedBounds = appSettings.mainWindow || {};
  mainWindow = new BrowserWindow({
    width: savedBounds.width || 1100,
    height: savedBounds.height || 920,
    x: savedBounds.x != null ? savedBounds.x : undefined,
    y: savedBounds.y != null ? savedBounds.y : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    title: `LostKit 2 v${version} - by LostHQ Team`
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Check for updates after app starts (lightweight version check)
  setTimeout(() => {
    checkForUpdates();
  }, 3000); // Wait 3 seconds after startup

  navView = new WebContentsView({
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // Small toast helper to show temporary messages on the main window
  function showToast(text) {
    try {
      const toast = new BrowserWindow({
        width: 300,
        height: 48,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        focusable: false,
        parent: mainWindow,
        webPreferences: { contextIsolation: true }
      });
      const html = `<!doctype html><html><head><style>body{margin:0;background:rgba(0,0,0,0);display:flex;align-items:center;justify-content:center;height:100%}#box{background:rgba(0,0,0,0.8);color:#fff;padding:8px 12px;border-radius:6px;font-family:Arial,Helvetica,sans-serif;font-size:13px;box-shadow:0 2px 6px rgba(0,0,0,0.6)}</style></head><body><div id="box">${text}</div></body></html>`;
      toast.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      const bw = mainWindow.getBounds();
      toast.setPosition(bw.x + Math.round((bw.width - 300) / 2), bw.y + 20);
      setTimeout(() => { try { if (!toast.isDestroyed()) toast.close(); } catch (e) {} }, 1200);
    } catch (e) {
      log.error('showToast error:', e);
    }
  }
  navView.webContents.loadFile(path.join(__dirname, 'nav.html'));
  mainWindow.contentView.addChildView(navView);

  chatView = new WebContentsView({
    webPreferences: {
      webSecurity: false
    }
  });
  chatView.webContents.loadURL('https://irc.losthq.rs');
  chatView.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.contentView.addChildView(chatView);
  chatView.setVisible(true);

  const mainView = new WebContentsView({
    webPreferences: {
      webSecurity: false,
      preload: path.join(__dirname, 'preload-zoom.js')
    }
  });
  // Load saved world or default
  const startWorldUrl = tabs[0].url;
  const startWorldTitle = tabs[0].title;
  mainView.webContents.loadURL(startWorldUrl);
  mainView.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.contentView.addChildView(mainView);
  primaryViews.push({ id: 'main', view: mainView });

  // Apply saved zoom factor
  if (appSettings.zoomFactor && appSettings.zoomFactor !== 1) {
    mainView.webContents.once('did-finish-load', () => {
      try { mainView.webContents.setZoomFactor(appSettings.zoomFactor); } catch (e) {}
    });
  }

  // Save main window bounds on resize/move
  const saveMainWindowBounds = () => {
    if (mainWindow && !mainWindow.isMinimized() && !mainWindow.isMaximized()) {
      const bounds = mainWindow.getBounds();
      appSettings.mainWindow = { width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y };
      saveSettingsDebounced();
    }
  };
  mainWindow.on('resized', saveMainWindowBounds);
  mainWindow.on('moved', saveMainWindowBounds);

  mainWindow.webContents.send('update-active', 'main');
  mainWindow.webContents.send('update-tab-title', 'main', startWorldTitle);

  updateBounds();
  mainWindow.webContents.send('chat-toggled', chatVisible, chatHeightValue);

  mainWindow.on('resize', () => {
    updateBounds();
  });

  // Allow toggling wheel-direction inversion at runtime: Ctrl+Shift+Z
  mainWindow.webContents.on('before-input-event', (event, input) => {
    try {
      if (input && input.key && input.key.toUpperCase() === 'Z' && input.control && input.shift) {
        zoomInvert = !zoomInvert;
        appSettings.zoomInvert = zoomInvert;
        saveSettingsDebounced();
        log.info('zoomInvert toggled', zoomInvert);
        showToast('Zoom invert: ' + (zoomInvert ? 'ON' : 'OFF'));
        event.preventDefault();
        return;
      }
      
      // Keyboard zoom controls: Ctrl + + / - / 0
      if (input && input.control) {
        const k = input.key || '';
        const code = (input.code || '').toLowerCase();
        const curView = primaryViews.find(pv => pv.id === currentTab);
        if (curView && curView.view && curView.view.webContents) {
          const wc = curView.view.webContents;
          let changed = false;
          if (k === '+' || k === '=' || code.includes('equal') || code.includes('add')) {
            const cur = wc.getZoomFactor();
            const nf = Math.min(3, cur * 1.1);
            wc.setZoomFactor(nf);
            appSettings.zoomFactor = nf;
            saveSettingsDebounced();
            showToast('Zoom: ' + nf.toFixed(2));
            changed = true;
          } else if (k === '-' || k === '_' || code.includes('minus') || code.includes('subtract')) {
            const cur = wc.getZoomFactor();
            const nf = Math.max(0.5, cur / 1.1);
            wc.setZoomFactor(nf);
            appSettings.zoomFactor = nf;
            saveSettingsDebounced();
            showToast('Zoom: ' + nf.toFixed(2));
            changed = true;
          } else if (k === '0' || code.includes('digit0') || code.includes('numpad0')) {
            wc.setZoomFactor(1);
            appSettings.zoomFactor = 1;
            saveSettingsDebounced();
            showToast('Zoom reset');
            changed = true;
          }
          if (changed) { event.preventDefault(); return; }
        }
      }
    } catch (e) {
      log.error('before-input-event error:', e);
    }
  });

  

  // Background AFK timer management functions
  function startBackgroundAfkTimer() {
    if (afkTimerRunning) return;
    afkTimerRunning = true;
    afkTimerSeconds = 0;
    log.info('Starting background AFK timer');

    afkTimerInterval = setInterval(() => {
      afkTimerSeconds++;

      if (navView && navView.webContents) {
        navView.webContents.send('background-afk-tick', afkTimerSeconds);
      }

      if (afkTimerSeconds >= 90) {
        triggerBackgroundAfkAlert();
        afkTimerSeconds = 0;
      }
    }, 1000);
  }

  function stopBackgroundAfkTimer() {
    if (afkTimerInterval) {
      clearInterval(afkTimerInterval);
      afkTimerInterval = null;
    }
    afkTimerRunning = false;
    afkTimerSeconds = 0;
    log.info('Stopped background AFK timer');
  }

  function triggerBackgroundAfkAlert() {
    log.info('Background AFK alert triggered - soundAlert:', soundAlert);
    if (!soundAlert) return;

    if (customSoundPath) {
      try {
        const fs = require('fs');
        if (fs.existsSync(customSoundPath)) {
          playAudioFile(customSoundPath);
          return;
        }
      } catch (e) {
        log.error('Error checking custom sound file:', e);
      }
    }

    playDefaultBeep();
  }

  function playAudioFile(filePath) {
    try {
      const { execFile } = require('child_process');
      const fs = require('fs');
      
      if (process.platform === 'win32') {
        const vbsScript = `
Set objPPT = CreateObject("wscript.shell")
Set objPPT2 = CreateObject("InternetExplorer.Application")
objPPT2.Visible = False
objPPT2.Navigate "about:blank"
Do While objPPT2.Busy
  WScript.Sleep 100
Loop
objPPT2.Document.Body.InnerHTML = "<bgsound src='" & WScript.Arguments(0) & "' autostart='true'>"
WScript.Sleep 3000
objPPT2.Quit
`;
        const tmpFile = require('os').tmpdir() + '/playsound_' + Date.now() + '.vbs';
        fs.writeFileSync(tmpFile, vbsScript);
        
        execFile('cscript.exe', [tmpFile, filePath], { windowsHide: true }, (err) => {
          fs.unlink(tmpFile, () => {});
          if (err) {
            log.error('VBS audio play failed:', err.message);
            playDefaultBeep();
          } else {
            log.info('Audio played via VBS:', filePath);
          }
        });
      } else if (process.platform === 'darwin') {
        execFile('afplay', [filePath], (err) => {
          if (err) {
            log.error('afplay failed:', err.message);
            playDefaultBeep();
          } else {
            log.info('Audio played via afplay:', filePath);
          }
        });
      } else {
        execFile('paplay', [filePath], (err) => {
          if (err) {
            execFile('ffplay', ['-nodisp', '-autoexit', filePath], (err2) => {
              if (err2) {
                log.error('ffplay failed:', err2.message);
                playDefaultBeep();
              } else {
                log.info('Audio played via ffplay:', filePath);
              }
            });
          } else {
            log.info('Audio played via paplay:', filePath);
          }
        });
      }
    } catch (e) {
      log.error('Error playing audio file:', e);
      playDefaultBeep();
    }
  }

  function playDefaultBeep() {
    try {
      const { execFile } = require('child_process');
      
      if (process.platform === 'win32') {
        execFile('cmd.exe', ['/c', 'echo ^G'], (err) => {
          if (err) log.error('System beep attempt failed');
          else log.info('System beep played');
        });
      } else if (process.platform === 'darwin') {
        execFile('afplay', ['/System/Library/Sounds/Ping.aiff'], (err) => {
          if (err) log.error('afplay beep failed:', err.message);
          else log.info('Beep played via afplay');
        });
      } else {
        execFile('paplay', ['/usr/share/sounds/freedesktop/stereo/complete.oga'], (err) => {
          if (err) {
            execFile('beep', [], (err2) => {
              if (err2) log.error('beep command failed');
              else log.info('Beep played via beep command');
            });
          } else {
            log.info('Beep played via paplay');
          }
        });
      }
    } catch (e) {
      log.error('Error playing default beep:', e);
    }
  }

  // Stopwatch IPC handlers
  ipcMain.on('update-stopwatch-setting', (event, setting, value) => {
    if (setting === 'afkAuto') afkAuto = !!value;
    if (setting === 'soundAlert') soundAlert = !!value;
    if (setting === 'soundVolume') soundVolume = parseInt(value) || 60;
    if (setting === 'customSoundPath') customSoundPath = value || '';
  });

  ipcMain.handle('copy-sound-file', async (event, buffer, destPath) => {
    try {
      const fs = require('fs');
      const fsPromises = fs.promises;
      const dir = path.dirname(destPath);
      await fsPromises.mkdir(dir, { recursive: true });
      await fsPromises.writeFile(destPath, buffer);
      return true;
    } catch (e) {
      log.error('Error writing sound file:', e);
      return false;
    }
  });

  ipcMain.handle('list-sound-files', async (event, soundsDir) => {
    try {
      const fs = require('fs');
      const fsPromises = fs.promises;
      await fsPromises.mkdir(soundsDir, { recursive: true });
      const files = await fsPromises.readdir(soundsDir);
      const audioFiles = files.filter(f => /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(f)).sort();
      return audioFiles;
    } catch (e) {
      log.error('Error listing sound files:', e);
      return [];
    }
  });

  ipcMain.handle('delete-sound-file', async (event, filePath) => {
    try {
      const fs = require('fs');
      const fsPromises = fs.promises;
      await fsPromises.unlink(filePath);
      return true;
    } catch (e) {
      log.error('Error deleting sound file:', e);
      return false;
    }
  });

  ipcMain.handle('open-sound-manager', async (event) => {
    if (soundManagerWindow && !soundManagerWindow.isDestroyed()) {
      soundManagerWindow.focus();
      return;
    }

    const smBounds = appSettings.soundManagerWindow || { width: 450, height: 500 };
    soundManagerWindow = new BrowserWindow({
      width: smBounds.width || 450,
      height: smBounds.height || 500,
      x: smBounds.x != null ? smBounds.x : undefined,
      y: smBounds.y != null ? smBounds.y : undefined,
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      },
      title: 'LostKit - Sound Manager'
    });

    soundManagerWindow.loadFile(path.join(__dirname, 'navitems/sound-manager.html'));

    const saveSMBounds = () => {
      if (soundManagerWindow && !soundManagerWindow.isDestroyed() && !soundManagerWindow.isMinimized()) {
        const bounds = soundManagerWindow.getBounds();
        appSettings.soundManagerWindow = { width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y };
        saveSettingsDebounced();
      }
    };
    soundManagerWindow.on('resized', saveSMBounds);
    soundManagerWindow.on('moved', saveSMBounds);

    soundManagerWindow.on('closed', () => {
      soundManagerWindow = null;
    });

    return true;
  });

  ipcMain.handle('open-notes', async (event) => {
    if (notesWindow && !notesWindow.isDestroyed()) {
      notesWindow.focus();
      return;
    }

    const notesBounds = appSettings.notesWindow || { width: 500, height: 600 };
    let windowWidth = notesBounds.width || 500;
    let windowHeight = notesBounds.height || 600;
    // Also try to read from old notes file for backwards compatibility
    try {
      const notesPath = path.join(process.env.APPDATA || process.env.HOME, '.lostkit-notes.json');
      const fsPromises = require('fs').promises;
      const notesData = await fsPromises.readFile(notesPath, 'utf8');
      const parsed = JSON.parse(notesData);
      if (parsed.windowWidth && !notesBounds.width) windowWidth = parsed.windowWidth;
      if (parsed.windowHeight && !notesBounds.height) windowHeight = parsed.windowHeight;
    } catch (e) {
      // Use defaults
    }

    notesWindow = new BrowserWindow({
      width: windowWidth,
      height: windowHeight,
      x: notesBounds.x != null ? notesBounds.x : undefined,
      y: notesBounds.y != null ? notesBounds.y : undefined,
      minWidth: 350,
      minHeight: 300,
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      },
      title: 'LostKit - Notes'
    });

    notesWindow.loadFile(path.join(__dirname, 'navitems/notes.html'));

    const saveNotesBounds = () => {
      if (notesWindow && !notesWindow.isDestroyed() && !notesWindow.isMinimized()) {
        const bounds = notesWindow.getBounds();
        appSettings.notesWindow = { width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y };
        saveSettingsDebounced();
      }
    };
    notesWindow.on('resized', saveNotesBounds);
    notesWindow.on('moved', saveNotesBounds);

    notesWindow.on('resize', () => {
      const [width, height] = notesWindow.getSize();
      notesWindow.webContents.send('window-resized', { width, height });
    });

    notesWindow.on('closed', () => {
      notesWindow = null;
    });

    return true;
  });

  ipcMain.on('save-notes-window-size', async (event, { width, height }) => {
    try {
      const notesPath = path.join(process.env.APPDATA || process.env.HOME, '.lostkit-notes.json');
      const fsPromises = require('fs').promises;
      let data = {};
      try {
        const existing = await fsPromises.readFile(notesPath, 'utf8');
        data = JSON.parse(existing);
      } catch (e) {}
      data.windowWidth = width;
      data.windowHeight = height;
      await fsPromises.writeFile(notesPath, JSON.stringify(data, null, 2));
    } catch (e) {
      log.error('Error saving notes window size:', e);
    }
  });

  ipcMain.handle('load-notes', async (event) => {
    try {
      const notesPath = path.join(process.env.APPDATA || process.env.HOME, '.lostkit-notes.json');
      const fsPromises = require('fs').promises;
      const notesData = await fsPromises.readFile(notesPath, 'utf8');
      return JSON.parse(notesData);
    } catch (e) {
      return {};
    }
  });

  ipcMain.on('save-notes', async (event, notes) => {
    try {
      const notesPath = path.join(process.env.APPDATA || process.env.HOME, '.lostkit-notes.json');
      const fsPromises = require('fs').promises;
      await fsPromises.writeFile(notesPath, JSON.stringify(notes, null, 2));
    } catch (e) {
      log.error('Error saving notes:', e);
    }
  });

  ipcMain.handle('get-sounds-config', async (event) => {
    const soundsDir = path.join(process.env.APPDATA || path.join(process.env.HOME || process.env.USERPROFILE, '.config'), 'LostKit', 'sounds');
    
    let userVolume = 60;
    let customSoundPath = '';
    let soundAlert = false;
    try {
      const configPath = path.join(process.env.APPDATA || process.env.HOME, '.lostkit-stopwatch-config.json');
      const fsPromises = require('fs').promises;
      const configData = await fsPromises.readFile(configPath, 'utf8');
      const config = JSON.parse(configData);
      userVolume = config.soundVolume || 60;
      soundAlert = config.soundAlert || false;
      if (config.customSoundFilename) {
        customSoundPath = path.normalize(path.join(soundsDir, config.customSoundFilename));
      }
    } catch (e) {}
    
    return { soundsDir, userVolume, customSoundPath, soundAlert };
  });

  ipcMain.on('select-sound', (event, soundPath) => {
    if (navView && navView.webContents) {
      navView.webContents.send('sound-selected', soundPath);
    }
  });

  ipcMain.handle('test-sound', async (event) => {
    triggerBackgroundAfkAlert();
    return true;
  });

  mainWindow.on('focus', () => {
    stopBackgroundAfkTimer();
    if (afkAuto && navView && navView.webContents) {
      navView.webContents.send('afk-auto-stop');
    }
  });

  mainWindow.on('blur', () => {
    if (afkAuto) {
      if (navView && navView.webContents) {
        navView.webContents.send('afk-auto-start');
      }
    }
  });

  mainWindow.on('minimize', () => {
    if (afkAuto) {
      if (navView && navView.webContents) {
        navView.webContents.send('afk-auto-start');
      }
    }
  });

  mainWindow.on('restore', () => {});

  ipcMain.on('toggle-chat', () => {
    chatVisible = !chatVisible;
    appSettings.chatVisible = chatVisible;
    saveSettingsDebounced();
    chatView.setVisible(chatVisible);
    updateBounds();
    mainWindow.webContents.send('chat-toggled', chatVisible, chatHeightValue);
  });

  ipcMain.on('add-tab', (event, url, customTitle) => {
    const existingId = tabByUrl.get(url);
    if (existingId) {
      const pv = primaryViews.find(pv => pv.id === existingId);
      if (pv) {
        primaryViews.forEach(({ view }) => view.setVisible(false));
        pv.view.setVisible(true);
        currentTab = existingId;
        mainWindow.webContents.send('update-active', existingId);
        return;
      } else {
        tabByUrl.delete(url);
      }
    }
    const id = Date.now().toString();
    const title = customTitle || url;
    tabs.push({ id, url, title });
    tabByUrl.set(url, id);
    const newView = new WebContentsView({
      webPreferences: { webSecurity: false, preload: path.join(__dirname, 'preload-zoom.js') }
    });
    newView.webContents.loadURL(url);
    newView.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });
    mainWindow.contentView.addChildView(newView);
    primaryViews.push({ id, view: newView });

    primaryViews.forEach(({ view }) => view.setVisible(false));
    newView.setVisible(true);
    currentTab = id;

    mainWindow.webContents.send('add-tab', id, title);
    mainWindow.webContents.send('update-active', id);

    if (!customTitle) {
      newView.webContents.on('page-title-updated', (event, pageTitle) => {
        const t = tabs.find(t => t.id === id);
        if (t) t.title = pageTitle;
        mainWindow.webContents.send('update-tab-title', id, pageTitle);
      });
    }
    updateBounds();
  });

  ipcMain.on('close-tab', (event, id) => {
    if (id !== 'main') {
      const removedTab = tabs.find(t => t.id === id);
      tabs = tabs.filter(t => t.id !== id);
      const index = primaryViews.findIndex(pv => pv.id === id);
      if (index !== -1) {
        if (removedTab && tabByUrl.get(removedTab.url) === id) {
          tabByUrl.delete(removedTab.url);
        }
        mainWindow.contentView.removeChildView(primaryViews[index].view);
        primaryViews.splice(index, 1);
      }
      mainWindow.webContents.send('close-tab', id);
      updateBounds();
      if (currentTab === id) {
        ipcMain.emit('switch-tab', event, 'main');
      }
    }
  });

  ipcMain.on('switch-tab', (event, id) => {
    currentTab = id;
    primaryViews.forEach(({ view }) => view.setVisible(false));
    const currentView = primaryViews.find(pv => pv.id === id);
    if (currentView) currentView.view.setVisible(true);
    mainWindow.webContents.send('update-active', id);
  });

  // Receive wheel events from preload and zoom the originating view
  ipcMain.on('zoom-wheel', (event, data) => {
    try {
      const senderWC = event.sender; // the webContents that sent the event
      const pv = primaryViews.find(p => p.view && p.view.webContents && p.view.webContents.id === senderWC.id);
      const targetWC = pv ? pv.view.webContents : senderWC;
      if (!data || typeof data.deltaY !== 'number') return;
      const deltaY = data.deltaY;
      // apply inversion flag if set
      const zoomIn = (deltaY < 0) !== !!zoomInvert;
      const cur = targetWC.getZoomFactor();
      const newFactor = Math.max(0.5, Math.min(3, zoomIn ? cur * 1.1 : cur / 1.1));
      targetWC.setZoomFactor(newFactor);
      // Save zoom factor
      appSettings.zoomFactor = newFactor;
      saveSettingsDebounced();
      try { log.info('zoom-wheel-raw', { deltaY, zoomInvert: !!zoomInvert, cur, newFactor }); } catch (e) {}
    } catch (e) {
      log.error('zoom-wheel handler error:', e);
    }
  });

  ipcMain.on('switch-nav-view', (event, view) => {
    switch (view) {
      case 'worldswitcher':
        navView.webContents.loadFile(path.join(__dirname, '/navitems/worldswitcher.html'));
        break;
      case 'hiscores':
        navView.webContents.loadFile(path.join(__dirname, '/navitems/hiscores.html'));
        break;
      case 'stopwatch':
        navView.webContents.loadFile(path.join(__dirname, '/navitems/stopwatch.html'));
        break;
      case 'nav':
      default:
        navView.webContents.loadFile(path.join(__dirname, 'nav.html'));
        break;
    }
  });

  ipcMain.on('select-world', (event, url, title) => {
    const currentTabData = tabs.find(t => t.id === currentTab);
    if (currentTabData.url === url) {
      return;
    }
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Continue'],
      defaultId: 1,
      title: 'Switch World',
      message: 'Make sure you are logged out before switching worlds!'
    });
    if (choice === 1) {
      tabByUrl.delete(currentTabData.url);
      currentTabData.url = url;
      currentTabData.title = title;
      tabByUrl.set(url, currentTab);
      const currentView = primaryViews.find(pv => pv.id === currentTab);
      if (currentView) {
        currentView.view.webContents.loadURL(url);
      }
      // Save last world for the main tab
      if (currentTab === 'main') {
        appSettings.lastWorld = { url, title };
        saveSettingsDebounced();
      }
      mainWindow.webContents.send('update-tab-title', currentTab, title);
      ipcMain.emit('switch-nav-view', null, 'nav');
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  ipcMain.on('set-chat-height', (event, height) => {
    chatHeightValue = Math.max(200, Math.min(height, 800));
    appSettings.chatHeight = chatHeightValue;
    saveSettingsDebounced();
    updateBounds();
  });

  ipcMain.on('update-chat-height', (event, height) => {
    chatHeightValue = Math.max(200, Math.min(800, height));
    updateBounds();
  });

  ipcMain.on('open-external', (event, url, title) => {
    const existing = externalWindowsByUrl.get(url);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return;
    }
    // Use saved bounds for this URL if available
    const extBounds = (appSettings.externalWindows && appSettings.externalWindows[url]) || { width: 1000, height: 700 };
    const win = new BrowserWindow({
      width: extBounds.width || 1000,
      height: extBounds.height || 700,
      x: extBounds.x != null ? extBounds.x : undefined,
      y: extBounds.y != null ? extBounds.y : undefined,
      title: title || url,
      webPreferences: { webSecurity: false }
    });
    win.loadURL(url);
    win.setMenuBarVisibility(false);
    externalWindowsByUrl.set(url, win);

    const saveExtBounds = () => {
      if (win && !win.isDestroyed() && !win.isMinimized()) {
        const bounds = win.getBounds();
        if (!appSettings.externalWindows) appSettings.externalWindows = {};
        appSettings.externalWindows[url] = { width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y };
        saveSettingsDebounced();
      }
    };
    win.on('resized', saveExtBounds);
    win.on('moved', saveExtBounds);

    win.on('closed', () => {
      if (externalWindowsByUrl.get(url) === win) externalWindowsByUrl.delete(url);
    });
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
