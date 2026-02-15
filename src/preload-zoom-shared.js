// Preload script for zoom in navitem windows (for external windows)
const { ipcRenderer } = require('electron');

window.addEventListener('wheel', (e) => {
  try {
    if (e.ctrlKey) {
      ipcRenderer.send('zoom-wheel', {
        deltaY: e.deltaY,
        deltaX: e.deltaX,
        ctrl: true,
        timestamp: Date.now()
      });
      e.preventDefault();
    }
  } catch (err) {
    // ignore
  }
}, { passive: false });
