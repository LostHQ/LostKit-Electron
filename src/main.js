const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell } = require('electron');
const path = require('path');

let mainWindow;
let stopwatchWindow = null;
let afkAuto = false;
let overlayMinimized = false;
let overlayInteracting = false;
let primaryViews = [];
let navView;
let chatView;
let tabs = [{ id: 'main', url: 'https://w2-2004.lostcity.rs/rs2.cgi?plugin=0&world=2&lowmem=0', title: 'W2 HD' }];
let tabByUrl = new Map([['https://w2-2004.lostcity.rs/rs2.cgi?plugin=0&world=2&lowmem=0','main']]);
let externalWindowsByUrl = new Map();
let currentTab = 'main';
let chatVisible = true;
let chatHeightValue = 300;

function updateBounds() {
  const contentBounds = mainWindow.getContentBounds();
  const width = contentBounds.width;
  const height = contentBounds.height;
  const navWidth = 250;
  const tabHeight = 30;
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

function createStopwatchWindow() {
  if (stopwatchWindow && !stopwatchWindow.isDestroyed()) {
    if (stopwatchWindow.isMinimized && stopwatchWindow.isMinimized()) {
      stopwatchWindow.restore();
    }
    stopwatchWindow.focus();
    return;
  }

  // Get game view bounds
  const contentBounds = mainWindow.getContentBounds();
  const navWidth = 250;
  const tabHeight = 30;
  const primaryWidth = contentBounds.width - navWidth;
  
  stopwatchWindow = new BrowserWindow({
    width: 250,
    height: 120,
    x: contentBounds.x + 20,
    y: contentBounds.y + tabHeight + 20,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    // Do not set `parent` so the overlay remains visible when the main window is minimized
    parent: null,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  const stopwatchPath = path.join(__dirname, 'stopwatch-overlay.html');
  console.log('Loading stopwatch from:', stopwatchPath);
  
  stopwatchWindow.loadFile(stopwatchPath).catch(err => {
    console.error('Failed to load stopwatch-overlay.html:', err);
  });
  
  stopwatchWindow.setIgnoreMouseEvents(false);
  
  stopwatchWindow.on('closed', () => {
    stopwatchWindow = null;
    overlayMinimized = false;
    if (navView && navView.webContents) {
      navView.webContents.send('stopwatch-overlay-closed');
    }
  });

  stopwatchWindow.on('minimize', () => {
    overlayMinimized = true;
    if (navView && navView.webContents) {
      navView.webContents.send('stopwatch-overlay-state', false);
    }
  });

  stopwatchWindow.on('restore', () => {
    overlayMinimized = false;
    if (navView && navView.webContents) {
      navView.webContents.send('stopwatch-overlay-state', true);
    }
  });
}

app.whenReady().then(() => {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 920,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

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
      webSecurity: false
    }
  });
  mainView.webContents.loadURL('https://w2-2004.lostcity.rs/rs2.cgi?plugin=0&world=2&lowmem=0');
  mainView.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.contentView.addChildView(mainView);
  primaryViews.push({ id: 'main', view: mainView });

  mainWindow.webContents.send('update-active', 'main');
  mainWindow.webContents.send('update-tab-title', 'main', 'W2 HD');

  updateBounds();
  mainWindow.webContents.send('chat-toggled', chatVisible, chatHeightValue);

  mainWindow.on('resize', () => {
    updateBounds();
  });

  // Stopwatch IPC handlers
  ipcMain.on('toggle-stopwatch-overlay', (event, shouldOpen) => {
    console.log('Toggle overlay:', shouldOpen);
    if (shouldOpen) {
      // Manual open request should always open (user intent)
      overlayMinimized = false;
      createStopwatchWindow();
      if (navView && navView.webContents) {
        navView.webContents.send('stopwatch-overlay-state', true);
      }
    } else {
      if (stopwatchWindow && !stopwatchWindow.isDestroyed()) {
        stopwatchWindow.close();
      }
    }
  });

  // Track when the stopwatch window is minimized/restored so auto-open logic respects user's minimize
  ipcMain.on('stopwatch-minimized', () => {
    overlayMinimized = true;
    overlayInteracting = false;
  });

  ipcMain.on('stopwatch-restored', () => {
    overlayMinimized = false;
    overlayInteracting = false;
  });

  ipcMain.on('overlay-interacting', (event, val) => {
    overlayInteracting = !!val;
    // Small log for debugging
    console.log('overlay-interacting ->', overlayInteracting);
  });

  ipcMain.on('check-stopwatch-overlay-state', (event) => {
    const isOpen = stopwatchWindow && !stopwatchWindow.isDestroyed();
    event.sender.send('stopwatch-overlay-state', isOpen);
  });

  ipcMain.on('update-stopwatch-mode', (event, mode, countdownTime) => {
    if (stopwatchWindow && !stopwatchWindow.isDestroyed()) {
      stopwatchWindow.webContents.send('update-mode', mode, countdownTime);
    }
  });

  ipcMain.on('update-stopwatch-setting', (event, setting, value) => {
    // Track afkAuto in main so we can auto-open overlay on blur/minimize
    console.log('ipcMain received update-stopwatch-setting', setting, value);
    if (setting === 'afkAuto') {
      afkAuto = !!value;
      console.log('afkAuto set to', afkAuto);
    }
    if (stopwatchWindow && !stopwatchWindow.isDestroyed()) {
      stopwatchWindow.webContents.send('update-setting', setting, value);
    }
  });

  ipcMain.on('resize-stopwatch-window', (event, width, height) => {
    if (stopwatchWindow && !stopwatchWindow.isDestroyed()) {
      stopwatchWindow.setSize(width, height);
    }
  });

  ipcMain.on('overlay-log', (event, msg) => {
    console.log('overlay:', msg);
  });

  mainWindow.on('focus', () => {
    console.log('mainWindow focused — afkAuto:', afkAuto, 'overlayMinimized:', overlayMinimized);
    if (stopwatchWindow && !stopwatchWindow.isDestroyed()) {
      stopwatchWindow.webContents.send('main-window-focused', true);
    }
    if (navView && navView.webContents) {
      navView.webContents.send('main-window-focused', true);
    }
    // When LostKit regains focus, set overlay to AFK 1:30 but don't start it
    if (stopwatchWindow && !stopwatchWindow.isDestroyed()) {
      stopwatchWindow.webContents.send('update-mode', 'afk', 90);
    }
  });

  mainWindow.on('blur', () => {
    console.log('mainWindow blurred — afkAuto:', afkAuto, 'overlayMinimized:', overlayMinimized);
    // If blur was caused by focusing the stopwatch overlay, or the overlay is being
    // actively dragged/ interacted with, ignore to avoid auto-triggering AFK
    try {
      const focused = BrowserWindow.getFocusedWindow();
      if ((focused && stopwatchWindow && focused.id === stopwatchWindow.id) || overlayInteracting) {
        console.log('Blur due to overlay focus/interaction — skipping AFK auto-start');
        return;
      }
    } catch (e) {
      console.log('Error checking focused window on blur:', e);
    }
    if (stopwatchWindow && !stopwatchWindow.isDestroyed()) {
      stopwatchWindow.webContents.send('main-window-focused', false);
    }
    if (navView && navView.webContents) {
      navView.webContents.send('main-window-focused', false);
    }
    // When LostKit loses focus, auto-open/start overlay if afkAuto enabled and user hasn't minimized overlay
    if (afkAuto && !overlayMinimized) {
      console.log('AFK auto-trigger: creating/opening overlay and starting AFK countdown');
      createStopwatchWindow();
      // Ensure overlay is in AFK mode and start the countdown
      if (stopwatchWindow && !stopwatchWindow.isDestroyed()) {
        stopwatchWindow.webContents.send('update-mode', 'afk', 90);
        setTimeout(() => {
          if (stopwatchWindow && !stopwatchWindow.isDestroyed()) {
            stopwatchWindow.webContents.send('update-setting', 'start', true);
          }
        }, 300);
      }
      if (navView && navView.webContents) {
        navView.webContents.send('stopwatch-overlay-state', true);
      }
    }
  });

  mainWindow.on('minimize', () => {
    console.log('mainWindow minimized — afkAuto:', afkAuto, 'overlayMinimized:', overlayMinimized);
    if (stopwatchWindow && !stopwatchWindow.isDestroyed()) {
      stopwatchWindow.webContents.send('main-window-focused', false);
    }
    if (navView && navView.webContents) {
      navView.webContents.send('main-window-focused', false);
    }
    if (afkAuto && !overlayMinimized) {
      createStopwatchWindow();
      if (stopwatchWindow && !stopwatchWindow.isDestroyed()) {
        stopwatchWindow.webContents.send('update-mode', 'afk', 90);
        setTimeout(() => {
          if (stopwatchWindow && !stopwatchWindow.isDestroyed()) {
            stopwatchWindow.webContents.send('update-setting', 'start', true);
          }
        }, 300);
      }
      if (navView && navView.webContents) {
        navView.webContents.send('stopwatch-overlay-state', true);
      }
    }
  });

  mainWindow.on('restore', () => {
    if (stopwatchWindow && !stopwatchWindow.isDestroyed()) {
      stopwatchWindow.webContents.send('main-window-focused', true);
      // Reset overlay to AFK 1:30 but do not start
      stopwatchWindow.webContents.send('update-mode', 'afk', 90);
    }
    if (navView && navView.webContents) {
      navView.webContents.send('main-window-focused', true);
    }
  });

  ipcMain.on('toggle-chat', () => {
    chatVisible = !chatVisible;
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
      mainWindow.webContents.send('update-tab-title', currentTab, title);
      ipcMain.emit('switch-nav-view', null, 'nav');
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (stopwatchWindow && !stopwatchWindow.isDestroyed()) {
      stopwatchWindow.close();
    }
  });

  ipcMain.on('set-chat-height', (event, height) => {
    chatHeightValue = Math.max(200, Math.min(height, 800));
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