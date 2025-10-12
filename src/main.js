const { app, BrowserWindow, WebContentsView, ipcMain, dialog, shell } = require('electron');
const path = require('path');

let mainWindow;
let primaryViews = [];
let navView;
let chatView;
let tabs = [{ id: 'main', url: 'https://w2-2004.lostcity.rs/rs2.cgi?plugin=0&world=2&lowmem=0', title: 'W2 HD' }];
let currentTab = 'main';
let chatVisible = false;
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

app.whenReady().then(() => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
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
  chatView.setVisible(false);

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

  ipcMain.on('toggle-chat', () => {
    chatVisible = !chatVisible;
    chatView.setVisible(chatVisible);
    updateBounds();
    mainWindow.webContents.send('chat-toggled', chatVisible, chatHeightValue);
  });

  ipcMain.on('add-tab', (event, url, customTitle) => {
    const id = Date.now().toString();
    const title = customTitle || url;
    tabs.push({ id, url, title });
    const newView = new WebContentsView({
      webPreferences: {
        webSecurity: false
      }
    });
    newView.webContents.loadURL(url);
    newView.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });
    mainWindow.contentView.addChildView(newView);
    newView.setVisible(false);
    primaryViews.push({ id, view: newView });
    mainWindow.webContents.send('add-tab', id, title);
    if (!customTitle) {
      newView.webContents.on('page-title-updated', (event, pageTitle) => {
        tabs.find(t => t.id === id).title = pageTitle;
        mainWindow.webContents.send('update-tab-title', id, pageTitle);
      });
    }
    updateBounds();
  });

  ipcMain.on('close-tab', (event, id) => {
    if (id !== 'main') {
      tabs = tabs.filter(t => t.id !== id);
      const index = primaryViews.findIndex(pv => pv.id === id);
      if (index !== -1) {
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
      currentTabData.url = url;
      currentTabData.title = title;
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
  });

  ipcMain.on('set-chat-height', (event, height) => {
    chatHeightValue = Math.max(200, Math.min(height, 800));
    updateBounds();
  });

  ipcMain.on('update-chat-height', (event, height) => {
    chatHeightValue = Math.max(200, Math.min(800, height));
    updateBounds();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
