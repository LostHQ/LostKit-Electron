const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

let currentMode = 'afk'; // 'afk', 'countdown', or 'stopwatch'
let countdownTime = 90;
let soundAlert = false;
let soundVolume = 60; // Increased default for background notifications
let autoLoop = false;
let afkAuto = false;
let customSoundPath = ''; // NEW: Path to custom sound file
let alertThreshold = 10; // NEW: Seconds before end to alert (default 10s)
let color = '#00ff00';
let opacity = 100;

// Config file path for persistent settings
const configPath = path.join(process.env.APPDATA || process.env.HOME, '.lostkit-stopwatch-config.json');

// Sounds directory path in user app data
const soundsDir = path.join(process.env.APPDATA || path.join(process.env.HOME, '.config'), 'LostKit', 'sounds');

// Ensure sounds directory exists
if (!fs.existsSync(soundsDir)) {
    fs.mkdirSync(soundsDir, { recursive: true });
    console.log('Created sounds directory:', soundsDir);
}

// DOM Elements
const modeDisplay = document.getElementById('mode-display');
const afkBtn = document.getElementById('afk-btn');
const countdownBtn = document.getElementById('countdown-btn');
const stopwatchBtn = document.getElementById('stopwatch-btn');
const countdownSettings = document.getElementById('countdown-settings');
const countdownTimeInput = document.getElementById('countdown-time');
const soundAlertCheckbox = document.getElementById('sound-alert-checkbox');
const autoLoopCheckbox = document.getElementById('auto-loop-checkbox');
const alertThresholdInput = document.getElementById('alert-threshold-input');
const volumeSlider = document.getElementById('volume-slider');
const volumeValue = document.getElementById('volume-value');
const colorPicker = document.getElementById('color-picker');
const opacitySlider = document.getElementById('opacity-slider');
const opacityValue = document.getElementById('opacity-value');
const afkAutoCheckbox = document.getElementById('afk-auto-checkbox');
const customSoundInput = document.getElementById('custom-sound-input');
const customSoundLabel = document.getElementById('custom-sound-label');

// Sound management functions
function openSoundManager() {
    ipcRenderer.invoke('open-sound-manager').then((success) => {
        if (success) {
            console.log('Sound manager window opened');
        }
    }).catch(err => console.log('Error opening sound manager:', err));
}

function toggleSoundManager() {
    const managerRow = document.getElementById('sound-manager-row');
    if (managerRow.style.display === 'none') {
        managerRow.style.display = '';
        refreshSoundList();
    } else {
        managerRow.style.display = 'none';
    }
}

function refreshSoundList() {
    ipcRenderer.invoke('list-sound-files', soundsDir).then((files) => {
        const soundList = document.getElementById('sound-list');
        soundList.innerHTML = '';
        
        // Add "Default (No Sound)" option
        const defaultBtn = document.createElement('div');
        defaultBtn.style.cssText = 'padding: 6px; background: ' + (customSoundPath === '' ? '#3a5a3a' : '#2a2a2a') + '; border: 1px solid #555; border-radius: 2px; cursor: pointer; display: flex; align-items: center; gap: 4px; font-size: 10px; color: #f0e68c;';
        defaultBtn.innerHTML = '<span style="flex: 1;">Default (No Sound)</span>';
        defaultBtn.onclick = () => {
            customSoundPath = '';
            customSoundLabel.textContent = 'No custom sound';
            saveConfig();
            refreshSoundList();
        };
        soundList.appendChild(defaultBtn);
        
        // Add available sound files
        files.forEach(file => {
            const fullPath = path.join(soundsDir, file);
            const isActive = customSoundPath === fullPath;
            
            const btn = document.createElement('div');
            btn.style.cssText = 'padding: 6px; background: ' + (isActive ? '#3a5a3a' : '#2a2a2a') + '; border: 1px solid #555; border-radius: 2px; cursor: pointer; display: flex; align-items: center; gap: 4px; font-size: 10px; color: #f0e68c;';
            
            const deleteBtn = document.createElement('button');
            deleteBtn.textContent = 'Delete';
            deleteBtn.style.cssText = 'padding: 2px 6px; background: #8b2222; border: 1px solid #c00; border-radius: 2px; color: #fff; cursor: pointer; font-size: 9px;';
            deleteBtn.onclick = (e) => {
                e.stopPropagation();
                deleteSoundFile(file);
            };
            
            btn.appendChild(document.createTextNode(file));
            btn.appendChild(deleteBtn);
            
            btn.onclick = () => {
                customSoundPath = fullPath;
                customSoundLabel.textContent = 'Custom Sound: ' + file;
                saveConfig();
                refreshSoundList();
            };
            soundList.appendChild(btn);
        });
    }).catch(err => console.log('Error refreshing sound list:', err));
}

function deleteSoundFile(fileName) {
    if (confirm(`Delete "${fileName}"?`)) {
        const filePath = path.join(soundsDir, fileName);
        ipcRenderer.invoke('delete-sound-file', filePath).then((success) => {
            if (success) {
                console.log('Sound file deleted:', filePath);
                if (customSoundPath === filePath) {
                    customSoundPath = '';
                    customSoundLabel.textContent = 'No custom sound';
                    saveConfig();
                }
                refreshSoundList();
            }
        }).catch(err => console.log('Error deleting sound file:', err));
    }
}

// Stopwatch display elements
const timerDisplay = document.getElementById('stopwatch-timer-display');
const startBtn = document.getElementById('stopwatch-start-btn');
const resetBtn = document.getElementById('stopwatch-reset-btn');

// Audio context for test beep
let audioContext = null;

// Stopwatch state
let seconds = 0;
let interval = null;
let running = false;
let soundPlayed = false;

// Save settings to config file
function saveConfig() {
    const config = {
        currentMode,
        countdownTime,
        soundAlert,
        soundVolume,
        autoLoop,
        afkAuto,
        customSoundFilename: customSoundPath ? path.basename(customSoundPath) : '',
        alertThreshold,
        color,
        opacity
    };
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log('Stopwatch config saved');
    } catch (e) {
        console.log('Error saving config:', e);
    }
}

// Load settings from config file
function loadConfig() {
    try {
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            currentMode = config.currentMode ?? currentMode;
            countdownTime = config.countdownTime ?? countdownTime;
            soundAlert = config.soundAlert ?? soundAlert;
            soundVolume = config.soundVolume ?? soundVolume;
            autoLoop = config.autoLoop ?? autoLoop;
            afkAuto = config.afkAuto ?? afkAuto;
            
            // Handle custom sound - if filename is stored, reconstruct full path
            if (config.customSoundFilename) {
                const fullPath = path.join(soundsDir, config.customSoundFilename);
                if (fs.existsSync(fullPath)) {
                    customSoundPath = fullPath;
                } else {
                    console.log('Custom sound file not found:', fullPath);
                    customSoundPath = '';
                }
            }
            
            alertThreshold = config.alertThreshold ?? alertThreshold;
            color = config.color ?? color;
            opacity = config.opacity ?? opacity;
            console.log('Stopwatch config loaded:', {soundAlert, soundVolume, customSoundPath});

            // Send settings to main process so background AFK alert can use them
            ipcRenderer.send('update-stopwatch-setting', 'soundAlert', soundAlert);
            ipcRenderer.send('update-stopwatch-setting', 'soundVolume', soundVolume);
            ipcRenderer.send('update-stopwatch-setting', 'customSoundPath', customSoundPath);
            console.log('Sent settings to main process');
        }
    } catch (e) {
        console.log('Error loading config:', e);
    }
}

function initAudio() {
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        console.log('Audio context initialized in stopwatch panel');
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

function playDefaultBeep() {
    if (!audioContext) initAudio();
    if (!audioContext) return;
    
    try {
        const osc = audioContext.createOscillator();
        const gain = audioContext.createGain();
        
        osc.connect(gain);
        gain.connect(audioContext.destination);
        
        osc.frequency.setValueAtTime(800, audioContext.currentTime);
        const vol = soundVolume / 100;
        gain.gain.setValueAtTime(vol, audioContext.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);
        
        osc.start();
        osc.stop(audioContext.currentTime + 0.3);
        
        console.log('Default beep played at volume:', soundVolume);
        setTimeout(() => { soundPlayed = false; }, 10000);
        
    } catch (e) {
        console.log('Error playing default beep:', e);
    }
}

function playBeep() {
    if (!soundAlert) return;
    if (!audioContext) initAudio();

    // If custom sound is set, try to play it
    if (customSoundPath && fs.existsSync(customSoundPath)) {
        try {
            const audio = new Audio(`file://${customSoundPath}`);
            audio.volume = soundVolume / 100;
            audio.play().catch(e => {
                console.log('Failed to play custom sound, falling back to default beep:', e);
                playDefaultBeep();
            });
            console.log('Custom sound played:', customSoundPath);
            setTimeout(() => { soundPlayed = false; }, 10000);
            return;
        } catch (e) {
            console.log('Error playing custom sound:', e);
        }
    }

    // Fall back to default beep
    playDefaultBeep();
}

function formatTime(totalSeconds) {
    const mins = Math.floor(Math.abs(totalSeconds) / 60);
    const secs = Math.abs(totalSeconds) % 60;
    const sign = totalSeconds < 0 ? '-' : '';
    return `${sign}${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function updateDisplay() {
    if (currentMode === 'afk' || currentMode === 'countdown') {
        const remaining = (currentMode === 'afk' ? 90 : countdownTime) - seconds;
        
        if (remaining <= 0) {
            timerDisplay.textContent = '00:00';
            timerDisplay.classList.remove('flash-red');
            timerDisplay.style.color = '#ff0000';
            
            if (autoLoop && running) {
                seconds = 0;
                soundPlayed = false;
                timerDisplay.classList.remove('flash-red');
                updateDisplay();
                return;
            }
            
            if (running) {
                clearInterval(interval);
                running = false;
                startBtn.textContent = 'Start';
            }
            
            soundPlayed = false;
        } else {
            timerDisplay.textContent = formatTime(remaining);
            
            if (remaining <= alertThreshold) {
                timerDisplay.classList.add('flash-red');
                
                if (soundAlert && !soundPlayed) {
                    playBeep();
                    soundPlayed = true;
                }
            } else {
                timerDisplay.classList.remove('flash-red');
                timerDisplay.style.color = color;
            }
        }
    } else if (currentMode === 'stopwatch') {
        timerDisplay.textContent = formatTime(seconds);
        timerDisplay.classList.remove('flash-red');
        timerDisplay.style.color = color;
        soundPlayed = false;
    }
}

function tick() {
    if (currentMode === 'afk' || currentMode === 'countdown') {
        const maxTime = currentMode === 'afk' ? 90 : countdownTime;
        if (seconds >= maxTime) return;
    }
    seconds++;
    updateDisplay();
}

startBtn.addEventListener('click', () => {
    if (running) {
        clearInterval(interval);
        startBtn.textContent = 'Start';
        running = false;
    } else {
        if ((currentMode === 'afk' || currentMode === 'countdown') && seconds >= (currentMode === 'afk' ? 90 : countdownTime)) {
            seconds = 0;
            soundPlayed = false;
        }
        
        interval = setInterval(tick, 1000);
        startBtn.textContent = 'Pause';
        running = true;
    }
});

resetBtn.addEventListener('click', () => {
    seconds = 0;
    soundPlayed = false;
    timerDisplay.classList.remove('flash-red');
    
    if (running) {
        clearInterval(interval);
        interval = setInterval(tick, 1000);
        startBtn.textContent = 'Pause';
    } else {
        startBtn.textContent = 'Start';
    }
    
    updateDisplay();
});

// Mode switching
function setMode(mode) {
    currentMode = mode;
    saveConfig();
    
    // Update active button
    afkBtn.classList.remove('active');
    countdownBtn.classList.remove('active');
    stopwatchBtn.classList.remove('active');
    
    // Stop timer when changing modes
    if (running) {
        clearInterval(interval);
        running = false;
        startBtn.textContent = 'Start';
    }
    
    seconds = 0;
    soundPlayed = false;
    
    if (mode === 'afk') {
        afkBtn.classList.add('active');
        modeDisplay.textContent = 'Mode: AFK Timer (90s)';
        countdownSettings.style.display = 'none';
        timerDisplay.textContent = '01:30';
        timerDisplay.style.color = color;
    } else if (mode === 'countdown') {
        countdownBtn.classList.add('active');
        modeDisplay.textContent = `Mode: Countdown (${countdownTime}s)`;
        countdownSettings.style.display = 'block';
        timerDisplay.textContent = formatTime(countdownTime);
        timerDisplay.style.color = color;
    } else {
        stopwatchBtn.classList.add('active');
        modeDisplay.textContent = 'Mode: Timer (Count Up)';
        countdownSettings.style.display = 'none';
        timerDisplay.textContent = '00:00';
        timerDisplay.style.color = color;
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
        if (!running) {
            timerDisplay.textContent = formatTime(countdownTime);
        }
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
    saveConfig();
    
    if (currentMode === 'countdown') {
        modeDisplay.textContent = `Mode: Countdown (${countdownTime}s)`;
        if (!running) {
            timerDisplay.textContent = formatTime(countdownTime);
        }
    }
});

// Sound alert checkbox
soundAlertCheckbox.addEventListener('change', () => {
    soundAlert = soundAlertCheckbox.checked;
    saveConfig();
    ipcRenderer.send('update-stopwatch-setting', 'soundAlert', soundAlert);
});

// Alert threshold input
alertThresholdInput.addEventListener('input', (e) => {
    let value = parseInt(e.target.value);
    if (isNaN(value) || value < 1) value = 1;
    if (value > 89) value = 89;
    alertThreshold = value;
    alertThresholdInput.value = value;
});

alertThresholdInput.addEventListener('change', (e) => {
    let value = parseInt(e.target.value);
    if (isNaN(value) || value < 1) value = 1;
    if (value > 89) value = 89;
    alertThreshold = value;
    alertThresholdInput.value = value;
    saveConfig();
});

// Volume slider
volumeSlider.addEventListener('input', (e) => {
    soundVolume = parseInt(e.target.value);
    volumeValue.textContent = soundVolume + '%';
    saveConfig();
    ipcRenderer.send('update-stopwatch-setting', 'soundVolume', soundVolume);
});

// Auto-loop checkbox
autoLoopCheckbox.addEventListener('change', () => {
    autoLoop = autoLoopCheckbox.checked;
    saveConfig();
});

// AFK Auto checkbox
afkAutoCheckbox.addEventListener('change', () => {
    afkAuto = afkAutoCheckbox.checked;
    saveConfig();
    console.log('nav panel: afkAuto changed ->', afkAuto);
    ipcRenderer.send('update-stopwatch-setting', 'afkAuto', afkAuto);
});

// Volume slider
volumeSlider.addEventListener('input', (e) => {
    soundVolume = parseInt(e.target.value);
    volumeValue.textContent = `${soundVolume}%`;
});

// Play test beep and send volume setting when user releases the volume slider
volumeSlider.addEventListener('change', (e) => {
    soundVolume = parseInt(e.target.value);
    saveConfig();
    ipcRenderer.send('update-stopwatch-setting', 'soundVolume', soundVolume);
    
    // Play custom sound if available, otherwise default beep
    if (customSoundPath && fs.existsSync(customSoundPath)) {
        try {
            const audio = new Audio(`file://${customSoundPath}`);
            audio.volume = soundVolume / 100;
            audio.play().catch(e => {
                console.log('Failed to play custom sound:', e);
                playTestBeep(soundVolume);
            });
            console.log('Custom sound preview played at volume:', soundVolume);
        } catch (e) {
            console.log('Error playing custom sound preview:', e);
            playTestBeep(soundVolume);
        }
    } else {
        playTestBeep(soundVolume);
    }
});

// Color picker
colorPicker.addEventListener('input', (e) => {
    color = e.target.value;
    if (!timerDisplay.classList.contains('flash-red')) {
        timerDisplay.style.color = color;
    }
});

colorPicker.addEventListener('change', (e) => {
    color = e.target.value;
    saveConfig();
});

// Opacity slider
opacitySlider.addEventListener('input', (e) => {
    opacity = parseInt(e.target.value);
    opacityValue.textContent = `${opacity}%`;
    timerDisplay.style.opacity = opacity / 100;
});

opacitySlider.addEventListener('change', (e) => {
    opacity = parseInt(e.target.value);
    saveConfig();
});

// Custom sound file input
customSoundInput.addEventListener('change', (e) => {
    const files = e.target.files;
    if (files && files.length > 0) {
        const selectedFile = files[0];
        const fileName = selectedFile.name;
        // Save with original filename to preserve user's file names
        const destPath = path.join(soundsDir, fileName);
        
        try {
            // Read file as array buffer and send to main process
            const reader = new FileReader();
            reader.onload = function(event) {
                const buffer = Buffer.from(event.target.result);
                ipcRenderer.invoke('copy-sound-file', buffer, destPath).then((success) => {
                    if (success) {
                        customSoundPath = destPath;
                        customSoundLabel.textContent = 'Custom Sound: ' + fileName;
                        saveConfig();
                        ipcRenderer.send('update-stopwatch-setting', 'customSoundPath', destPath);
                        console.log('Custom sound copied to:', destPath);
                        
                        // Play preview of the custom sound
                        try {
                            const audio = new Audio(`file://${destPath}`);
                            audio.volume = soundVolume / 100;
                            audio.play().catch(err => console.log('Preview play failed:', err));
                        } catch (err) {
                            console.log('Error playing custom sound preview:', err);
                        }
                    } else {
                        console.log('Failed to copy sound file');
                    }
                }).catch(err => console.log('Error copying custom sound file:', err));
            };
            reader.readAsArrayBuffer(selectedFile);
        } catch (err) {
            console.log('Error in sound file handler:', err);
        }
    }
});

// Initialize by loading config
loadConfig();
setMode('afk');
colorPicker.value = color;
opacitySlider.value = opacity;
opacityValue.textContent = `${opacity}%`;
soundAlertCheckbox.checked = soundAlert;
autoLoopCheckbox.checked = autoLoop;
alertThresholdInput.value = alertThreshold;
volumeSlider.value = soundVolume;
volumeValue.textContent = `${soundVolume}%`;
afkAutoCheckbox.checked = afkAuto;
if (customSoundPath) {
    const soundFileName = path.basename(customSoundPath);
    customSoundLabel.textContent = 'Custom Sound: ' + soundFileName;
    console.log('Loaded custom sound:', soundFileName);
}

// Refresh sound list display
refreshSoundList();

// Apply initial styling
timerDisplay.style.opacity = opacity / 100;

// Inform main process of current AFK Auto setting on load so auto behavior works
ipcRenderer.send('update-stopwatch-setting', 'afkAuto', afkAuto);
console.log('nav panel: initial afkAuto sent ->', afkAuto);

// Listen for AFK auto-start signal from main process (when window loses focus or is minimized)
ipcRenderer.on('afk-auto-start', () => {
    console.log('Received afk-auto-start signal, currentMode:', currentMode);
    
    // Only auto-start if we're in AFK mode
    if (currentMode === 'afk') {
        console.log('Starting AFK timer automatically');
        
        // Reset and start the timer
        seconds = 0;
        soundPlayed = false;
        timerDisplay.classList.remove('flash-red');
        
        // Start the interval
        if (running) {
            clearInterval(interval);
        }
        interval = setInterval(tick, 1000);
        running = true;
        startBtn.textContent = 'Pause';
        updateDisplay();
    }
});

// Listen for AFK auto-stop signal from main process (when window regains focus)
ipcRenderer.on('afk-auto-stop', () => {
    console.log('Received afk-auto-stop signal, currentMode:', currentMode);
    
    // Only reset if we're in AFK mode
    if (currentMode === 'afk') {
        // Stop the timer if running
        if (running) {
            clearInterval(interval);
            running = false;
            startBtn.textContent = 'Start';
        }
        
        // Reset the timer
        seconds = 0;
        soundPlayed = false;
        timerDisplay.classList.remove('flash-red');
        updateDisplay();
    }
});

// Listen for sound selection from sound manager window
ipcRenderer.on('sound-selected', (event, soundPath) => {
    customSoundPath = soundPath;
    saveConfig();
    ipcRenderer.send('update-stopwatch-setting', 'customSoundPath', soundPath);
    
    if (soundPath === '') {
        customSoundLabel.textContent = 'No custom sound';
    } else {
        const fileName = path.basename(soundPath);
        customSoundLabel.textContent = 'Custom Sound: ' + fileName;
    }
    
    console.log('Sound selected from manager:', soundPath);
});

// Listen for background AFK alerts from main process
ipcRenderer.on('background-afk-alert', () => {
    console.log('Received background AFK alert, soundAlert:', soundAlert);
    // Play the alert sound if sound alert is enabled
    if (soundAlert) {
        playBeep();
    }
});

// Listen for background AFK timer ticks
ipcRenderer.on('background-afk-tick', (event, seconds) => {
    console.log('Background AFK tick:', seconds);
    // Could update UI here if user comes back to stopwatch view
});

// Back button function
function goBack() {
    ipcRenderer.send('switch-nav-view', 'nav');
}