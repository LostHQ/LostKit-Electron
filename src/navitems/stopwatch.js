const { ipcRenderer } = require('electron');

let currentMode = 'afk'; // 'afk', 'countdown', or 'stopwatch'
let overlayOpen = false;
let countdownTime = 90;
let soundAlert = false;
let soundVolume = 30;
let autoLoop = false;
let color = '#00ff00';
let size = 48;
let opacity = 100;

// DOM Elements
const modeDisplay = document.getElementById('mode-display');
const afkBtn = document.getElementById('afk-btn');
const countdownBtn = document.getElementById('countdown-btn');
const stopwatchBtn = document.getElementById('stopwatch-btn');
const toggleOverlayBtn = document.getElementById('toggle-overlay-btn');
const countdownSettings = document.getElementById('countdown-settings');
const countdownTimeInput = document.getElementById('countdown-time');
const soundAlertCheckbox = document.getElementById('sound-alert-checkbox');
const autoLoopCheckbox = document.getElementById('auto-loop-checkbox');
const volumeSlider = document.getElementById('volume-slider');
const volumeValue = document.getElementById('volume-value');
const colorPicker = document.getElementById('color-picker');
const sizeSlider = document.getElementById('size-slider');
const sizeValue = document.getElementById('size-value');
const opacitySlider = document.getElementById('opacity-slider');
const opacityValue = document.getElementById('opacity-value');

// Audio context for test beep
let audioContext = null;

function initAudio() {
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        console.log('Audio context initialized in panel');
    } catch (e) {
        console.log('Web Audio API not supported:', e);
    }
}

function playTestBeep(volume) {
    if (!audioContext) initAudio();
    if (!audioContext) return;
    
    try {
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        oscillator.frequency.setValueAtTime(800, audioContext.currentTime);
        const vol = volume / 100;
        gainNode.gain.setValueAtTime(vol, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);
        
        oscillator.start();
        oscillator.stop(audioContext.currentTime + 0.3);
        
        console.log('Test beep played at volume:', volume);
    } catch (e) {
        console.log('Error playing test beep:', e);
    }
}

// Check the current state of the overlay when the page loads
ipcRenderer.send('check-stopwatch-overlay-state');
ipcRenderer.on('stopwatch-overlay-state', (event, isOpen) => {
    overlayOpen = isOpen;
    updateOverlayButton();
    
    // If overlay is open, send current settings to it
    if (isOpen) {
        sendAllSettingsToOverlay();
    }
});

// Listen for when overlay closes
ipcRenderer.on('stopwatch-overlay-closed', () => {
    overlayOpen = false;
    updateOverlayButton();
});

// Update the overlay button text
function updateOverlayButton() {
    toggleOverlayBtn.textContent = overlayOpen ? 'Close Stopwatch Overlay' : 'Open Stopwatch Overlay';
}

// Send all current settings to overlay
function sendAllSettingsToOverlay() {
    // Send mode first
    if (currentMode === 'afk') {
        ipcRenderer.send('update-stopwatch-mode', 'afk', 90);
    } else if (currentMode === 'countdown') {
        ipcRenderer.send('update-stopwatch-mode', 'countdown', countdownTime);
    } else {
        ipcRenderer.send('update-stopwatch-mode', 'stopwatch', 0);
    }
    
    // Send all settings
    ipcRenderer.send('update-stopwatch-setting', 'color', color);
    ipcRenderer.send('update-stopwatch-setting', 'size', size);
    ipcRenderer.send('update-stopwatch-setting', 'opacity', opacity);
    ipcRenderer.send('update-stopwatch-setting', 'soundAlert', soundAlert);
    ipcRenderer.send('update-stopwatch-setting', 'soundVolume', soundVolume);
    ipcRenderer.send('update-stopwatch-setting', 'autoLoop', autoLoop);
    
    if (currentMode === 'countdown') {
        ipcRenderer.send('update-stopwatch-setting', 'countdownTime', countdownTime);
    }
}

// Toggle overlay
toggleOverlayBtn.addEventListener('click', () => {
    overlayOpen = !overlayOpen;
    ipcRenderer.send('toggle-stopwatch-overlay', overlayOpen);
    updateOverlayButton();
    
    // When opening overlay, send current settings after a short delay
    if (overlayOpen) {
        setTimeout(() => {
            sendAllSettingsToOverlay();
        }, 200);
    }
});

// Mode switching
function setMode(mode) {
    currentMode = mode;
    
    // Update active button
    afkBtn.classList.remove('active');
    countdownBtn.classList.remove('active');
    stopwatchBtn.classList.remove('active');
    
    if (mode === 'afk') {
        afkBtn.classList.add('active');
        modeDisplay.textContent = 'Mode: AFK Timer (90s)';
        countdownSettings.style.display = 'none';
        // Send mode update to main process
        ipcRenderer.send('update-stopwatch-mode', 'afk', 90);
    } else if (mode === 'countdown') {
        countdownBtn.classList.add('active');
        modeDisplay.textContent = `Mode: Countdown (${countdownTime}s)`;
        countdownSettings.style.display = 'block';
        // Send the current countdown time immediately when switching to countdown mode
        ipcRenderer.send('update-stopwatch-mode', 'countdown', countdownTime);
    } else {
        stopwatchBtn.classList.add('active');
        modeDisplay.textContent = 'Mode: Timer (Count Up)';
        countdownSettings.style.display = 'none';
        ipcRenderer.send('update-stopwatch-mode', 'stopwatch', 0);
    }
}

afkBtn.addEventListener('click', () => setMode('afk'));
countdownBtn.addEventListener('click', () => setMode('countdown'));
stopwatchBtn.addEventListener('click', () => setMode('stopwatch'));

// Countdown time input - update instantly as user types
countdownTimeInput.addEventListener('input', () => {
    let newTime = parseInt(countdownTimeInput.value);
    
    // Validate input
    if (isNaN(newTime) || newTime < 1) {
        newTime = 1;
    }
    if (newTime > 999) {
        newTime = 999;
        countdownTimeInput.value = 999;
    }
    
    countdownTime = newTime;
    
    if (currentMode === 'countdown') {
        modeDisplay.textContent = `Mode: Countdown (${countdownTime}s)`;
        // Send updates to overlay immediately as user types
        ipcRenderer.send('update-stopwatch-mode', 'countdown', countdownTime);
        ipcRenderer.send('update-stopwatch-setting', 'countdownTime', countdownTime);
    }
});

// Also handle blur event to ensure valid value when user leaves the field
countdownTimeInput.addEventListener('blur', () => {
    let newTime = parseInt(countdownTimeInput.value);
    
    if (isNaN(newTime) || newTime < 1) {
        newTime = 1;
        countdownTimeInput.value = 1;
    }
    if (newTime > 999) {
        newTime = 999;
        countdownTimeInput.value = 999;
    }
    
    countdownTime = newTime;
    
    if (currentMode === 'countdown') {
        modeDisplay.textContent = `Mode: Countdown (${countdownTime}s)`;
        ipcRenderer.send('update-stopwatch-mode', 'countdown', countdownTime);
        ipcRenderer.send('update-stopwatch-setting', 'countdownTime', countdownTime);
    }
});

// Sound alert checkbox
soundAlertCheckbox.addEventListener('change', () => {
    soundAlert = soundAlertCheckbox.checked;
    ipcRenderer.send('update-stopwatch-setting', 'soundAlert', soundAlert);
});

// Auto-loop checkbox
autoLoopCheckbox.addEventListener('change', () => {
    autoLoop = autoLoopCheckbox.checked;
    ipcRenderer.send('update-stopwatch-setting', 'autoLoop', autoLoop);
});

// Volume slider
volumeSlider.addEventListener('input', (e) => {
    soundVolume = parseInt(e.target.value);
    volumeValue.textContent = `${soundVolume}%`;
});

// Play test beep and send volume setting when user releases the volume slider
volumeSlider.addEventListener('change', (e) => {
    soundVolume = parseInt(e.target.value);
    ipcRenderer.send('update-stopwatch-setting', 'soundVolume', soundVolume);
    playTestBeep(soundVolume);
});

// Color picker
colorPicker.addEventListener('input', (e) => {
    color = e.target.value;
    ipcRenderer.send('update-stopwatch-setting', 'color', color);
});

// Size slider
sizeSlider.addEventListener('input', (e) => {
    size = parseInt(e.target.value);
    sizeValue.textContent = `${size}px`;
    ipcRenderer.send('update-stopwatch-setting', 'size', size);
});

// Opacity slider
opacitySlider.addEventListener('input', (e) => {
    opacity = parseInt(e.target.value);
    opacityValue.textContent = `${opacity}%`;
    ipcRenderer.send('update-stopwatch-setting', 'opacity', opacity);
});

// Initialize
setMode('afk');
colorPicker.value = color;
sizeSlider.value = size;
sizeValue.textContent = `${size}px`;
opacitySlider.value = opacity;
opacityValue.textContent = `${opacity}%`;
soundAlertCheckbox.checked = soundAlert;
autoLoopCheckbox.checked = autoLoop;
volumeSlider.value = soundVolume;
volumeValue.textContent = `${soundVolume}%`;

// Back button function
function goBack() {
    ipcRenderer.send('switch-nav-view', 'nav');
}