const { ipcRenderer } = require('electron');

function goBack() {
    ipcRenderer.send('switch-nav-view', 'nav');
}