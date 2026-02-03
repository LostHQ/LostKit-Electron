const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell } = require('electron');
const log = require('electron-log');
const path = require('path');
const fs = require('fs');
const version = require('../package.json').version;

// Configure logging
log.transports.file.level = 'info';

// Version check URL (raw GitHub - no rate limits, with cache busting)
const VERSION_CHECK_URL = 'https://raw.githubusercontent.com/LostHQ/LostKit-Electron/main/version.json';

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

// Settings persistence
const settingsPath = path.join(process.env.APPDATA || process.env.HOME || '.', '.lostkit-settings.json');
let appSettings = {
  mainWindow: { width: 1100, height: 920, x: null, y: null },
  zoomFactor: 1,
  chatHeight: 300,
  chatVisible: true,
  lastWorld: { url: 'https://w2-2004.lostcity.rs/rs2.cgi?plugin=0&world=2&lowmem=0', title: 'W2 HD' },
  soundManagerWindow: { width: 450, height: 500 },
  notesWindow: { width: 500, height: 600 }
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

// Handle Squirrel installer events on Windows
if (require('electron-squirrel-startup')) {
  app.quit();
}

let mainWindow;
let afkGameClick = false; // Reset AFK timer when clicking on game tab
let soundAlert = false; // Whether sound alerts are enabled
let soundVolume = 60; // Sound volume level
let customSoundPath = ''; // Path to custom sound file
// Game-click AFK timer (runs in background, independent of stopwatch panel)
let gameClickTimerRunning = false;
let gameClickTimerInterval = null;
let gameClickTimerSeconds = 0;
let alertThreshold = 10; // Seconds before 90 to alert
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
      preload: path.join(__dirname, 'gameview-preload.js')
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

  // Restore zoom factor if saved
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

  // Game-click background timer functions
  function startGameClickTimer() {
    if (gameClickTimerRunning) {
      // Already running, don't reset - just continue
      console.log('Game-click timer already running, continuing');
      return;
    }
    gameClickTimerRunning = true;
    gameClickTimerSeconds = 0;
    console.log('Starting game-click background timer');

    gameClickTimerInterval = setInterval(() => {
      gameClickTimerSeconds++;
      
      // Send update to stopwatch view if it's active
      if (navView && navView.webContents) {
        navView.webContents.send('game-click-timer-tick', gameClickTimerSeconds);
      }

      // At threshold (e.g., 80 seconds = 90 - 10), trigger alert
      const thresholdTime = 90 - alertThreshold;
      if (gameClickTimerSeconds === thresholdTime) {
        console.log('Game-click timer reached threshold, alerting');
        triggerGameClickAlert();
      }

      // At 90 seconds, reset and loop
      if (gameClickTimerSeconds >= 90) {
        console.log('Game-click timer reached 90s, looping');
        gameClickTimerSeconds = 0;
      }
    }, 1000);
  }

  function resetGameClickTimer() {
    if (gameClickTimerRunning) {
      gameClickTimerSeconds = 0;
      console.log('Game-click timer reset to 0');
      if (navView && navView.webContents) {
        navView.webContents.send('game-click-timer-tick', gameClickTimerSeconds);
      }
    } else if (afkGameClick) {
      // Start the timer if feature is enabled
      startGameClickTimer();
    }
  }

  function stopGameClickTimer() {
    if (gameClickTimerInterval) {
      clearInterval(gameClickTimerInterval);
      gameClickTimerInterval = null;
    }
    gameClickTimerRunning = false;
    gameClickTimerSeconds = 0;
    console.log('Stopped game-click timer');
  }

  function triggerGameClickAlert() {
    console.log('Game-click alert triggered - soundAlert:', soundAlert);
    if (!soundAlert) return;

    // Send alert to main window to play sound (always loaded, supports OGG via HTML5 Audio)
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('play-alert-sound', {
        customSoundPath: customSoundPath,
        soundVolume: soundVolume
      });
    }
  }

  function playAudioFile(filePath) {
    try {
      const { exec, execFile } = require('child_process');
      const path = require('path');
      const fs = require('fs');
      
      if (process.platform === 'win32') {
        // On Windows, use PowerShell with Windows Media Player COM object - much more reliable
        const psCommand = `
          Add-Type -AssemblyName presentationCore
          $mediaPlayer = New-Object System.Windows.Media.MediaPlayer
          $mediaPlayer.Volume = ${soundVolume / 100}
          $mediaPlayer.Open([System.Uri]"${filePath.replace(/\\/g, '\\\\')}")
          $mediaPlayer.Play()
          Start-Sleep -Seconds 5
        `;
        
        exec(`powershell -ExecutionPolicy Bypass -Command "${psCommand.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { windowsHide: true }, (err) => {
          if (err) {
            console.log('PowerShell audio play failed:', err.message);
            // Fallback: try with Windows built-in SoundPlayer
            const psCommand2 = `(New-Object Media.SoundPlayer '${filePath.replace(/'/g, "''")}').PlaySync()`;
            exec(`powershell -ExecutionPolicy Bypass -Command "${psCommand2}"`, { windowsHide: true }, (err2) => {
              if (err2) {
                console.log('SoundPlayer fallback also failed:', err2.message);
              } else {
                console.log('Audio played via SoundPlayer:', filePath);
              }
            });
          } else {
            console.log('Audio played via PowerShell:', filePath);
          }
        });
      } else if (process.platform === 'darwin') {
        // macOS - use afplay
        execFile('afplay', [filePath], (err) => {
          if (err) {
            console.log('afplay failed:', err.message);
            playDefaultBeep();
          } else {
            console.log('Audio played via afplay:', filePath);
          }
        });
      } else {
        // Linux - try paplay first, then ffplay
        execFile('paplay', [filePath], (err) => {
          if (err) {
            console.log('paplay failed, trying ffplay');
            execFile('ffplay', ['-nodisp', '-autoexit', filePath], (err2) => {
              if (err2) {
                console.log('ffplay failed:', err2.message);
                playDefaultBeep();
              } else {
                console.log('Audio played via ffplay:', filePath);
              }
            });
          } else {
            console.log('Audio played via paplay:', filePath);
          }
        });
      }
    } catch (e) {
      console.log('Error playing audio file:', e);
      playDefaultBeep();
    }
  }

  function playDefaultBeep() {
    try {
      const { execFile } = require('child_process');
      console.log('Playing default beep on platform:', process.platform);
      
      if (process.platform === 'win32') {
        // Windows - try multiple methods
        // Method 1: Using wmic to access system sounds
        execFile('cmd.exe', ['/c', 'echo ^G'], (err) => {
          if (err) {
            console.log('System beep attempt failed');
          } else {
            console.log('System beep played');
          }
        });
      } else if (process.platform === 'darwin') {
        // macOS - use afplay
        execFile('afplay', ['/System/Library/Sounds/Ping.aiff'], (err) => {
          if (err) console.log('afplay beep failed:', err.message);
          else console.log('Beep played via afplay');
        });
      } else {
        // Linux - try multiple methods
        execFile('paplay', ['/usr/share/sounds/freedesktop/stereo/complete.oga'], (err) => {
          if (err) {
            console.log('paplay beep failed, trying beep command');
            execFile('beep', [], (err2) => {
              if (err2) console.log('beep command failed');
              else console.log('Beep played via beep command');
            });
          } else {
            console.log('Beep played via paplay');
          }
        });
      }
    } catch (e) {
      console.log('Error playing default beep:', e);
    }
  }

  // Stopwatch IPC handlers
  
  // Handler for stopwatch panel to get current timer state on load
  ipcMain.handle('get-game-click-timer-state', () => {
    return {
      running: gameClickTimerRunning,
      seconds: gameClickTimerSeconds,
      afkGameClick: afkGameClick
    };
  });

  // Handler for stopwatch panel to reset the background timer
  ipcMain.on('reset-game-click-timer', () => {
    if (gameClickTimerRunning) {
      gameClickTimerSeconds = 0;
      console.log('Game-click timer manually reset to 0');
      if (navView && navView.webContents) {
        navView.webContents.send('game-click-timer-tick', gameClickTimerSeconds);
      }
    }
  });

  ipcMain.on('update-stopwatch-setting', (event, setting, value) => {
    console.log('ipcMain received update-stopwatch-setting', setting, value);
    if (setting === 'afkGameClick') {
      const newValue = !!value;
      // Only act if the value actually changed
      if (newValue !== afkGameClick) {
        afkGameClick = newValue;
        console.log('afkGameClick changed to', afkGameClick);
        if (afkGameClick) {
          startGameClickTimer();
        } else {
          stopGameClickTimer();
        }
      }
    }
    if (setting === 'alertThreshold') {
      alertThreshold = parseInt(value) || 10;
      console.log('alertThreshold set to', alertThreshold);
    }
    if (setting === 'soundAlert') {
      soundAlert = !!value;
      console.log('soundAlert set to', soundAlert);
    }
    if (setting === 'soundVolume') {
      soundVolume = parseInt(value) || 60;
      console.log('soundVolume set to', soundVolume);
    }
    if (setting === 'customSoundPath') {
      customSoundPath = value || '';
      console.log('customSoundPath set to', customSoundPath);
    }
  });

  // Handle sound file copying
  ipcMain.handle('copy-sound-file', async (event, buffer, destPath) => {
    try {
      const fs = require('fs');
      const fsPromises = fs.promises;
      const dir = path.dirname(destPath);
      // Ensure directory exists
      await fsPromises.mkdir(dir, { recursive: true });
      await fsPromises.writeFile(destPath, buffer);
      console.log('Sound file written:', destPath);
      return true;
    } catch (e) {
      console.log('Error writing sound file:', e);
      return false;
    }
  });

  // Handle listing sound files
  ipcMain.handle('list-sound-files', async (event, soundsDir) => {
    try {
      const fs = require('fs');
      const fsPromises = fs.promises;
      // Ensure directory exists
      await fsPromises.mkdir(soundsDir, { recursive: true });
      const files = await fsPromises.readdir(soundsDir);
      // Filter audio files and sort
      const audioFiles = files.filter(f => /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(f)).sort();
      console.log('Sound files found:', audioFiles);
      return audioFiles;
    } catch (e) {
      console.log('Error listing sound files:', e);
      return [];
    }
  });

  // Handle deleting sound files
  ipcMain.handle('delete-sound-file', async (event, filePath) => {
    try {
      const fs = require('fs');
      const fsPromises = fs.promises;
      await fsPromises.unlink(filePath);
      console.log('Sound file deleted:', filePath);
      return true;
    } catch (e) {
      console.log('Error deleting sound file:', e);
      return false;
    }
  });

  // Handle opening sound manager window
  ipcMain.handle('open-sound-manager', async (event) => {
    if (soundManagerWindow && !soundManagerWindow.isDestroyed()) {
      soundManagerWindow.focus();
      return;
    }

    soundManagerWindow = new BrowserWindow({
      width: 450,
      height: 500,
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      },
      title: 'LostKit - Sound Manager'
    });

    soundManagerWindow.loadFile(path.join(__dirname, 'navitems/sound-manager.html'));

    soundManagerWindow.on('closed', () => {
      soundManagerWindow = null;
    });

    return true;
  });

  // Handle getting sounds config
  ipcMain.handle('get-sounds-config', async (event) => {
    const soundsDir = path.join(process.env.APPDATA || path.join(process.env.HOME || process.env.USERPROFILE, '.config'), 'LostKit', 'sounds');
    
    // Load settings from config file
    let userVolume = 60; // default
    let customSoundPath = ''; // default
    let soundAlert = false; // default
    try {
      const configPath = path.join(process.env.APPDATA || process.env.HOME, '.lostkit-stopwatch-config.json');
      const fsPromises = require('fs').promises;
      const configData = await fsPromises.readFile(configPath, 'utf8');
      const config = JSON.parse(configData);
      userVolume = config.soundVolume || 60;
      soundAlert = config.soundAlert || false;
      // Reconstruct customSoundPath from saved filename
      if (config.customSoundFilename) {
        customSoundPath = path.normalize(path.join(soundsDir, config.customSoundFilename));
      }
    } catch (e) {
      // Config not found or error reading, use defaults
      console.log('Note: Using default config values');
    }
    
    console.log('get-sounds-config returning:', {soundsDir, customSoundPath, userVolume, soundAlert});
    return { soundsDir, userVolume, customSoundPath, soundAlert };
  });

  // Handle sound selection from sound manager window
  ipcMain.on('select-sound', (event, soundPath) => {
    // Send update to stopwatch view
    if (navView && navView.webContents) {
      navView.webContents.send('sound-selected', soundPath);
    }
  });

  // Test sound playback handler
  ipcMain.handle('test-sound', async (event) => {
    console.log('Test sound requested');
    triggerBackgroundAfkAlert();
    return true;
  });

  // Notes window handler
  ipcMain.handle('open-notes', async (event) => {
    if (notesWindow && !notesWindow.isDestroyed()) {
      notesWindow.focus();
      return;
    }

    const notesBounds = appSettings.notesWindow || { width: 500, height: 600 };
    let windowWidth = notesBounds.width || 500;
    let windowHeight = notesBounds.height || 600;

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
      console.log('Error saving notes window size:', e);
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
      console.log('Error saving notes:', e);
    }
  });

  // Handle game view clicks for AFK timer reset - ONLY from main game view
  ipcMain.on('game-view-clicked', (event) => {
    // Only respond to clicks from the main game view (id: 'main')
    const mainPV = primaryViews.find(pv => pv.id === 'main');
    if (!mainPV || !mainPV.view || !mainPV.view.webContents) return;
    
    // Check if the sender is the main game view
    if (event.sender.id !== mainPV.view.webContents.id) {
      return; // Ignore clicks from other windows/views
    }
    
    if (afkGameClick) {
      console.log('Main game view clicked, resetting background AFK timer');
      resetGameClickTimer();
      // Also notify stopwatch panel if visible
      if (navView && navView.webContents) {
        navView.webContents.send('afk-game-click-reset');
      }
    }
  });

  // Receive wheel events from preload and zoom the originating view
  ipcMain.on('zoom-wheel', (event, data) => {
    try {
      const senderWC = event.sender;
      const pv = primaryViews.find(p => p.view && p.view.webContents && p.view.webContents.id === senderWC.id);
      const targetWC = pv ? pv.view.webContents : senderWC;
      if (!data || typeof data.deltaY !== 'number') return;
      const deltaY = data.deltaY;
      const zoomIn = deltaY < 0;
      const cur = targetWC.getZoomFactor();
      const newFactor = Math.max(0.5, Math.min(3, zoomIn ? cur * 1.1 : cur / 1.1));
      targetWC.setZoomFactor(newFactor);
      // Save zoom factor for main game view
      if (pv && pv.id === 'main') {
        appSettings.zoomFactor = newFactor;
        saveSettingsDebounced();
      }
      log.info('Zoom applied:', newFactor);
    } catch (e) {
      log.error('zoom-wheel handler error:', e);
    }
  });

  ipcMain.on('toggle-chat', () => {
    chatVisible = !chatVisible;
    chatView.setVisible(chatVisible);
    appSettings.chatVisible = chatVisible;
    saveSettingsDebounced();
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
      webPreferences: { webSecurity: false }
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
    appSettings.chatHeight = chatHeightValue;
    saveSettingsDebounced();
    updateBounds();
  });

  ipcMain.on('open-external', (event, url, title) => {
    const existing = externalWindowsByUrl.get(url);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return;
    }
    const win = new BrowserWindow({
      width: 1000, height: 700,
      title: title || url,
      webPreferences: { webSecurity: false }
    });
    win.loadURL(url);
    win.setMenuBarVisibility(false);
    externalWindowsByUrl.set(url, win);
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