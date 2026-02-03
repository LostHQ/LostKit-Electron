const { ipcRenderer } = require('electron');

// Forward wheel events (when Ctrl is held) to the main process for zoom
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

// Detect clicks on game view for AFK timer reset
window.addEventListener('DOMContentLoaded', () => {
    document.addEventListener('mousedown', () => {
        ipcRenderer.send('game-view-clicked');
    }, true);
});
