const { ipcRenderer } = require('electron');

// Forward wheel events (when Ctrl is held) to the main process
window.addEventListener('wheel', (e) => {
  try {
    if (e.ctrlKey) {
      // Send sensible fields only
      ipcRenderer.send('zoom-wheel', {
        deltaY: e.deltaY,
        deltaX: e.deltaX,
        ctrl: true,
        timestamp: Date.now()
      });
      // Prevent default to avoid the page's native zoom
      e.preventDefault();
    }
  } catch (err) {
    // ignore
  }
}, { passive: false, capture: true });
