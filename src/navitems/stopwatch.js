const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

// ==================== STATE VARIABLES ====================
let currentMode = 'afk'; // 'afk', 'countdown', or 'stopwatch'
let countdownTime = 90;
let soundAlert = false;
let soundVolume = 60;
let autoLoop = false;
let afkGameClick = false; // Reset AFK timer when clicking on game tab
let afkInputType = 'mouse'; // 'mouse' or 'both' - what resets the timer
let customSoundPath = ''; // Path to custom sound file
let alertThreshold = 10; // Seconds before end to alert (default 10s)
let color = '#00ff00';
let opacity = 100;

// Dual mode support
let dualModeEnabled = false;
let secondaryMode = 'countdown';

// Maximum countdown time in seconds (24 hours = 86400 seconds)
const MAX_COUNTDOWN_SECONDS = 86400;

// Config file path for persistent settings
const configPath = path.join(process.env.APPDATA || process.env.HOME, '.lostkit-stopwatch-config.json');

// Sounds directory path in user app data
const soundsDir = path.join(process.env.APPDATA || path.join(process.env.HOME, '.config'), 'LostKit', 'sounds');

// Default packaged sound path (relative to app)
let defaultPackagedSoundPath = '';

// Ensure sounds directory exists
if (!fs.existsSync(soundsDir)) {
    fs.mkdirSync(soundsDir, { recursive: true });
    console.log('Created sounds directory:', soundsDir);
}

// Initialize default packaged sound path
function initDefaultSoundPath() {
    try {
        const possiblePaths = [
            path.join(__dirname, '..', 'assets', 'sound', "Bell_(Wizards'_Guild)_ringing.wav.ogg"),
            path.join(process.resourcesPath, 'assets', 'sound', "Bell_(Wizards'_Guild)_ringing.wav.ogg"),
            path.join(__dirname, 'assets', 'sound', "Bell_(Wizards'_Guild)_ringing.wav.ogg"),
        ];
        
        for (const testPath of possiblePaths) {
            if (fs.existsSync(testPath)) {
                defaultPackagedSoundPath = testPath;
                console.log('Found default packaged sound at:', defaultPackagedSoundPath);
                return;
            }
        }
        console.log('Default packaged sound not found, checked paths:', possiblePaths);
    } catch (e) {
        console.log('Error initializing default sound path:', e);
    }
}

// Parse time input - supports both "90" (seconds) and "1:30" (minutes:seconds) formats
function parseTimeInput(input) {
    if (!input || typeof input !== 'string') {
        return { seconds: 90, valid: false };
    }
    
    const trimmed = input.trim();
    
    // Check if it contains a colon (minutes:seconds format)
    if (trimmed.includes(':')) {
        const parts = trimmed.split(':');
        if (parts.length === 2) {
            const minutes = parseInt(parts[0]) || 0;
            const seconds = parseInt(parts[1]) || 0;
            
            if (minutes < 0 || seconds < 0 || seconds > 59) {
                return { seconds: 90, valid: false };
            }
            
            const totalSeconds = minutes * 60 + seconds;
            return { seconds: totalSeconds, valid: true, isMinutesFormat: true };
        }
        return { seconds: 90, valid: false };
    } else {
        // Plain seconds format
        const seconds = parseInt(trimmed);
        if (isNaN(seconds) || seconds < 1) {
            return { seconds: 90, valid: false };
        }
        return { seconds: seconds, valid: true, isMinutesFormat: false };
    }
}

// Format seconds to display string (for input field)
function formatTimeInput(totalSeconds) {
    if (totalSeconds >= 60 && totalSeconds % 60 === 0) {
        // Even minutes - show as minutes:seconds
        const mins = Math.floor(totalSeconds / 60);
        return `${mins}:00`;
    } else if (totalSeconds >= 60) {
        // Show as minutes:seconds
        const mins = Math.floor(totalSeconds / 60);
        const secs = totalSeconds % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
    // Less than 60 seconds - show as plain seconds
    return totalSeconds.toString();
}

// ==================== DOM ELEMENTS ====================
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
const afkGameClickCheckbox = document.getElementById('afk-game-click-checkbox');
const afkInputTypeSelect = document.getElementById('afk-input-type-select');
const afkInputTypeRow = document.getElementById('afk-input-type-row');
const customSoundInput = document.getElementById('custom-sound-input');
const customSoundLabel = document.getElementById('custom-sound-label');

// Mode-specific option panels
const afkModeOptions = document.getElementById('afk-mode-options');

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

// ==================== CONFIG FUNCTIONS ====================

// Save settings to config file
function saveConfig() {
    const config = {
        currentMode,
        countdownTime,
        soundAlert,
        soundVolume,
        autoLoop,
        afkGameClick,
        afkInputType,
        customSoundFilename: customSoundPath ? path.basename(customSoundPath) : '',
        alertThreshold,
        color,
        opacity,
        dualModeEnabled,
        secondaryMode
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
            afkGameClick = config.afkGameClick ?? afkGameClick;
            afkInputType = config.afkInputType ?? afkInputType;
            
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
            dualModeEnabled = config.dualModeEnabled ?? dualModeEnabled;
            secondaryMode = config.secondaryMode ?? secondaryMode;
            
            console.log('Stopwatch config loaded:', {soundAlert, soundVolume, customSoundPath});

            // Send settings to main process so background timer can use them
            ipcRenderer.send('update-stopwatch-setting', 'soundAlert', soundAlert);
            ipcRenderer.send('update-stopwatch-setting', 'soundVolume', soundVolume);
            ipcRenderer.send('update-stopwatch-setting', 'customSoundPath', customSoundPath);
            ipcRenderer.send('update-stopwatch-setting', 'afkGameClick', afkGameClick);
            ipcRenderer.send('update-stopwatch-setting', 'alertThreshold', alertThreshold);
            console.log('Sent settings to main process');
        }
    } catch (e) {
        console.log('Error loading config:', e);
    }
}

// ==================== AUDIO FUNCTIONS ====================

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
                console.log('Failed to play custom sound, falling back to default packaged sound:', e);
                playDefaultPackagedSound();
            });
            console.log('Custom sound played:', customSoundPath);
            setTimeout(() => { soundPlayed = false; }, 10000);
            return;
        } catch (e) {
            console.log('Error playing custom sound:', e);
        }
    }

    // Use default packaged sound instead of generated beep
    playDefaultPackagedSound();
}

function playDefaultPackagedSound() {
    // Try to play the default packaged sound
    if (defaultPackagedSoundPath && fs.existsSync(defaultPackagedSoundPath)) {
        try {
            const audio = new Audio(`file://${defaultPackagedSoundPath}`);
            audio.volume = soundVolume / 100;
            audio.play().then(() => {
                console.log('Default packaged sound played at volume:', soundVolume);
            }).catch(e => {
                console.log('Failed to play default packaged sound, falling back to generated beep:', e);
                playDefaultBeep();
            });
            setTimeout(() => { soundPlayed = false; }, 10000);
            return;
        } catch (e) {
            console.log('Error playing default packaged sound:', e);
        }
    }
    
    // Fall back to generated beep if packaged sound not available
    playDefaultBeep();
}

// ==================== DISPLAY FUNCTIONS ====================

function formatTime(totalSeconds) {
    const mins = Math.floor(Math.abs(totalSeconds) / 60);
    const secs = Math.abs(totalSeconds) % 60;
    const sign = totalSeconds < 0 ? '-' : '';
    return `${sign}${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function updateDisplay() {
    // Note: Sound alerts are handled by the main process (background timer)
    // This function only updates the visual display
    if (currentMode === 'afk') {
        // AFK mode: show remaining time, or negative if past 90 seconds
        const remaining = 90 - seconds;
        
        if (remaining <= 0) {
            // Show negative time (how long since timer expired)
            timerDisplay.textContent = formatTime(remaining);
            timerDisplay.classList.add('flash-red');
            timerDisplay.style.color = '#ff0000';
        } else {
            timerDisplay.textContent = formatTime(remaining);
            
            if (remaining <= alertThreshold) {
                timerDisplay.classList.add('flash-red');
            } else {
                timerDisplay.classList.remove('flash-red');
                timerDisplay.style.color = color;
            }
        }
    } else if (currentMode === 'countdown') {
        const remaining = countdownTime - seconds;
        
        if (remaining <= 0) {
            if (autoLoop) {
                // For auto-loop, reset and continue
                seconds = 0;
                soundPlayed = false;
                timerDisplay.classList.remove('flash-red');
                timerDisplay.textContent = formatTime(countdownTime);
                return;
            }
            
            timerDisplay.textContent = '00:00';
            timerDisplay.classList.remove('flash-red');
            timerDisplay.style.color = '#ff0000';
            
            if (running) {
                clearInterval(interval);
                running = false;
                startBtn.textContent = 'Start';
                // Also stop the background timer
                ipcRenderer.send('stop-background-timer');
            }
            
            soundPlayed = false;
        } else {
            timerDisplay.textContent = formatTime(remaining);
            
            if (remaining <= alertThreshold) {
                timerDisplay.classList.add('flash-red');
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

// Update visibility of mode-specific options
function updateModeOptionsVisibility() {
    // Hide all mode-specific options first
    if (afkModeOptions) afkModeOptions.style.display = 'none';
    
    // Show options based on current mode
    if (currentMode === 'afk') {
        if (afkModeOptions) afkModeOptions.style.display = 'block';
    }
    
    // Countdown settings are shown in setMode function already
}

function tick() {
    // For AFK mode, keep counting past 90 (for negative display)
    // For countdown mode, stop at max time (unless auto-loop)
    if (currentMode === 'countdown') {
        if (seconds >= countdownTime) {
            if (autoLoop) {
                seconds = 0;
                soundPlayed = false;
            } else {
                return;
            }
        }
    }
    seconds++;
    updateDisplay();
}

// ==================== BUTTON HANDLERS ====================

startBtn.addEventListener('click', () => {
    if (running) {
        clearInterval(interval);
        startBtn.textContent = 'Start';
        running = false;
        
        // Also pause the background timer
        ipcRenderer.send('pause-background-timer');
        
        // Also pause the game-click timer if Game Click is enabled (legacy AFK)
        if (afkGameClick && currentMode === 'afk') {
            ipcRenderer.send('pause-game-click-timer');
        }
    } else {
        // For countdown mode, reset if already finished
        // For AFK mode, allow continuing even past 90 (negative display)
        if (currentMode === 'countdown' && seconds >= countdownTime) {
            seconds = 0;
            soundPlayed = false;
        }
        
        interval = setInterval(tick, 1000);
        startBtn.textContent = 'Pause';
        running = true;
        
        // Start/resume the background timer for all modes
        // If legacy Game-Click AFK mode is enabled and we're in AFK mode,
        // prefer the game-click timer (legacy) and do NOT start the unified background timer
        if (afkGameClick && currentMode === 'afk') {
            ipcRenderer.send('resume-game-click-timer');
        } else {
            ipcRenderer.send('start-background-timer', {
                mode: currentMode,
                initialSeconds: seconds,
                countdownTime: countdownTime,
                autoLoop: autoLoop
            });
        }
    }
});

resetBtn.addEventListener('click', () => {
    seconds = 0;
    soundPlayed = false;
    timerDisplay.classList.remove('flash-red');
    
    // Reset the appropriate timer depending on mode/config
    if (afkGameClick && currentMode === 'afk') {
        ipcRenderer.send('reset-game-click-timer');
    } else {
        ipcRenderer.send('reset-background-timer');
    }
    
    if (running) {
        clearInterval(interval);
        interval = setInterval(tick, 1000);
        startBtn.textContent = 'Pause';
    } else {
        startBtn.textContent = 'Start';
    }
    
    updateDisplay();
});

// ==================== MODE SWITCHING ====================

function setMode(mode, preserveState = false) {
    currentMode = mode;
    saveConfig();
    
    // Update active button
    afkBtn.classList.remove('active');
    countdownBtn.classList.remove('active');
    stopwatchBtn.classList.remove('active');
    
    // Stop timer when changing modes (unless preserving state)
    if (running && !preserveState) {
        clearInterval(interval);
        running = false;
        startBtn.textContent = 'Start';
    }
    
    // Stop background timer when switching modes (unless preserving state)
    if (!preserveState) {
        ipcRenderer.send('stop-background-timer');
    }
    
    // Stop background timer when switching away from AFK mode
    if (mode !== 'afk' && afkGameClick) {
        ipcRenderer.send('pause-game-click-timer');
    }
    
    // Resume background timer when switching to AFK mode
    if (mode === 'afk' && afkGameClick) {
        ipcRenderer.send('resume-game-click-timer');
    }
    
    if (!preserveState) {
        seconds = 0;
        soundPlayed = false;
    }
    
    if (mode === 'afk') {
        afkBtn.classList.add('active');
        modeDisplay.textContent = 'Mode: AFK Timer (90s)';
        countdownSettings.style.display = 'none';
        if (!preserveState) {
            timerDisplay.textContent = '01:30';
            timerDisplay.style.color = color;
        }
    } else if (mode === 'countdown') {
        countdownBtn.classList.add('active');
        modeDisplay.textContent = `Mode: Countdown (${countdownTime}s)`;
        countdownSettings.style.display = 'block';
        if (!preserveState) {
            timerDisplay.textContent = formatTime(countdownTime);
            timerDisplay.style.color = color;
        }
    } else {
        stopwatchBtn.classList.add('active');
        modeDisplay.textContent = 'Mode: Timer (Count Up)';
        countdownSettings.style.display = 'none';
        if (!preserveState) {
            timerDisplay.textContent = '00:00';
            timerDisplay.style.color = color;
        }
    }
    
    // Show/hide mode-specific options
    updateModeOptionsVisibility();
}

afkBtn.addEventListener('click', () => setMode('afk'));
countdownBtn.addEventListener('click', () => setMode('countdown'));
stopwatchBtn.addEventListener('click', () => setMode('stopwatch'));

// ==================== INPUT HANDLERS ====================

// Countdown time input - update instantly as user types
countdownTimeInput.addEventListener('input', () => {
    const parsed = parseTimeInput(countdownTimeInput.value);
    let newTime = parsed.seconds;
    
    // Validate input
    if (!parsed.valid || newTime < 1) {
        newTime = 1;
    }
    if (newTime > MAX_COUNTDOWN_SECONDS) {
        newTime = MAX_COUNTDOWN_SECONDS;
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
    const parsed = parseTimeInput(countdownTimeInput.value);
    let newTime = parsed.seconds;
    
    if (!parsed.valid || newTime < 1) {
        newTime = 1;
    }
    if (newTime > MAX_COUNTDOWN_SECONDS) {
        newTime = MAX_COUNTDOWN_SECONDS;
    }
    
    countdownTime = newTime;
    // Update input to show formatted time
    countdownTimeInput.value = formatTimeInput(countdownTime);
    saveConfig();
    
    // Update background timer settings
    ipcRenderer.send('update-background-timer-settings', { countdownTime: countdownTime });
    
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
    const maxThreshold = Math.max(89, countdownTime - 1);
    if (isNaN(value) || value < 1) value = 1;
    if (value > maxThreshold) value = maxThreshold;
    alertThreshold = value;
    alertThresholdInput.value = value;
});

alertThresholdInput.addEventListener('change', (e) => {
    let value = parseInt(e.target.value);
    const maxThreshold = Math.max(89, countdownTime - 1);
    if (isNaN(value) || value < 1) value = 1;
    if (value > maxThreshold) value = maxThreshold;
    alertThreshold = value;
    alertThresholdInput.value = value;
    saveConfig();
    ipcRenderer.send('update-stopwatch-setting', 'alertThreshold', alertThreshold);
    // Update background timer settings
    ipcRenderer.send('update-background-timer-settings', { alertThreshold: alertThreshold });
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
    // Update background timer settings
    ipcRenderer.send('update-background-timer-settings', { autoLoop: autoLoop });
});

// AFK Game Click checkbox
afkGameClickCheckbox.addEventListener('change', () => {
    afkGameClick = afkGameClickCheckbox.checked;
    saveConfig();
    console.log('nav panel: afkGameClick changed ->', afkGameClick);
    ipcRenderer.send('update-stopwatch-setting', 'afkGameClick', afkGameClick);
});

// AFK Input Type select
afkInputTypeSelect.addEventListener('change', () => {
    afkInputType = afkInputTypeSelect.value;
    saveConfig();
    console.log('nav panel: afkInputType changed ->', afkInputType);
    ipcRenderer.send('update-stopwatch-setting', 'afkInputType', afkInputType);
});

// Play test beep and send volume setting when user releases the volume slider
volumeSlider.addEventListener('change', (e) => {
    soundVolume = parseInt(e.target.value);
    saveConfig();
    ipcRenderer.send('update-stopwatch-setting', 'soundVolume', soundVolume);
    
    // Play custom sound if available, otherwise default packaged sound
    if (customSoundPath && fs.existsSync(customSoundPath)) {
        try {
            const audio = new Audio(`file://${customSoundPath}`);
            audio.volume = soundVolume / 100;
            audio.play().catch(e => {
                console.log('Failed to play custom sound:', e);
                playDefaultPackagedSound();
            });
            console.log('Custom sound preview played at volume:', soundVolume);
        } catch (e) {
            console.log('Error playing custom sound preview:', e);
            playDefaultPackagedSound();
        }
    } else {
        playDefaultPackagedSound();
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

// ==================== SOUND MANAGEMENT ====================

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

// ==================== INITIALIZATION ====================

// Initialize by loading config
initDefaultSoundPath();
loadConfig();

// Set mode from saved config (preserve state to not stop background timer)
setMode(currentMode, true);

colorPicker.value = color;
opacitySlider.value = opacity;
opacityValue.textContent = `${opacity}%`;
soundAlertCheckbox.checked = soundAlert;
autoLoopCheckbox.checked = autoLoop;
alertThresholdInput.value = alertThreshold;
volumeSlider.value = soundVolume;
volumeValue.textContent = `${soundVolume}%`;
afkGameClickCheckbox.checked = afkGameClick;
countdownTimeInput.value = formatTimeInput(countdownTime);
if (afkInputTypeSelect) {
    afkInputTypeSelect.value = afkInputType;
}
if (customSoundPath) {
    const soundFileName = path.basename(customSoundPath);
    customSoundLabel.textContent = 'Custom Sound: ' + soundFileName;
    console.log('Loaded custom sound:', soundFileName);
}

// Initialize mode options visibility
updateModeOptionsVisibility();

// Refresh sound list display
refreshSoundList();

// Apply initial styling
timerDisplay.style.opacity = opacity / 100;

// Request current background timer state and sync display
ipcRenderer.invoke('get-background-timer-state').then((state) => {
    console.log('Background timer state on load:', state);
    if (state && state.running) {
        // Sync regardless of mode - update our mode to match background timer
        currentMode = state.mode;
        seconds = state.seconds;
        running = true;
        startBtn.textContent = 'Pause';
        
        // Update mode buttons to reflect current mode
        afkBtn.classList.remove('active');
        countdownBtn.classList.remove('active');
        stopwatchBtn.classList.remove('active');
        if (state.mode === 'afk') afkBtn.classList.add('active');
        else if (state.mode === 'countdown') countdownBtn.classList.add('active');
        else stopwatchBtn.classList.add('active');
        
        // Update mode display
        if (state.mode === 'afk') {
            modeDisplay.textContent = 'Mode: AFK Timer (90s)';
            countdownSettings.style.display = 'none';
        } else if (state.mode === 'countdown') {
            modeDisplay.textContent = `Mode: Countdown (${state.countdownTime || countdownTime}s)`;
            countdownSettings.style.display = 'block';
            if (state.countdownTime) countdownTime = state.countdownTime;
        } else {
            modeDisplay.textContent = 'Mode: Timer (Count Up)';
            countdownSettings.style.display = 'none';
        }
        
        // Start local interval to keep display updated
        interval = setInterval(tick, 1000);
        
        updateDisplay();
        console.log('Synced with background timer:', state);
    }
    // Always check legacy game-click timer for AFK mode
    ipcRenderer.invoke('get-game-click-timer-state').then((legacyState) => {
        if (legacyState && legacyState.running && legacyState.afkGameClick && currentMode === 'afk') {
            seconds = legacyState.seconds;
            running = true;
            startBtn.textContent = 'Pause';
            
            // Start local interval to keep display updated
            if (!interval) {
                interval = setInterval(tick, 1000);
            }
            updateDisplay();
            console.log('Synced with legacy game-click timer:', legacyState.seconds, 'seconds');
        }
    }).catch(err => console.log('Could not get legacy timer state:', err));
}).catch(err => console.log('Could not get background timer state:', err));

// Inform main process of current settings on load so background timer works
ipcRenderer.send('update-stopwatch-setting', 'afkGameClick', afkGameClick);
ipcRenderer.send('update-stopwatch-setting', 'afkInputType', afkInputType);
ipcRenderer.send('update-stopwatch-setting', 'alertThreshold', alertThreshold);
ipcRenderer.send('update-stopwatch-setting', 'soundAlert', soundAlert);
ipcRenderer.send('update-stopwatch-setting', 'soundVolume', soundVolume);
ipcRenderer.send('update-stopwatch-setting', 'customSoundPath', customSoundPath);
console.log('nav panel: initial settings sent to main process');

// ==================== IPC LISTENERS ====================

// Listen for game click reset signal from main process
ipcRenderer.on('afk-game-click-reset', () => {
    console.log('Received afk-game-click-reset signal, currentMode:', currentMode);
    
    // Only reset if we're in AFK mode
    if (currentMode === 'afk') {
        // Reset the timer and restart it
        seconds = 0;
        soundPlayed = false;
        timerDisplay.classList.remove('flash-red');
        
        // If using legacy Game-Click AFK handling, reset that timer instead
        if (afkGameClick) {
            ipcRenderer.send('reset-game-click-timer');

            // Ensure local display is running
            if (!running) {
                interval = setInterval(tick, 1000);
                running = true;
                startBtn.textContent = 'Pause';
                ipcRenderer.send('resume-game-click-timer');
            }
        } else {
            // Fallback to unified background timer reset
            ipcRenderer.send('reset-background-timer');

            // Start the timer locally if not running
            if (!running) {
                interval = setInterval(tick, 1000);
                running = true;
                startBtn.textContent = 'Pause';
                ipcRenderer.send('start-background-timer', {
                    mode: 'afk',
                    initialSeconds: 0,
                    countdownTime: 90,
                    autoLoop: false
                });
            }
        }

        updateDisplay();
        console.log('AFK timer reset due to game click');
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

// Listen for game-click background timer ticks to sync display
ipcRenderer.on('game-click-timer-tick', (event, bgSeconds) => {
    // Sync the stopwatch display with the background timer when in AFK mode
    if (currentMode === 'afk' && afkGameClick) {
        seconds = bgSeconds;
        updateDisplay();
    }
});

// Listen for unified background timer ticks to sync display
ipcRenderer.on('background-timer-tick', (event, data) => {
    // Sync the stopwatch display with the background timer
    if (currentMode === data.mode) {
        seconds = data.seconds;
        if (data.countdownTime && currentMode === 'countdown') {
            countdownTime = data.countdownTime;
        }
        updateDisplay();
    }
});

// Listen for alert sound request from main process (background timer)
ipcRenderer.on('play-alert-sound', (event, data) => {
    console.log('Received play-alert-sound request:', data);
    
    if (data.customSoundPath && fs.existsSync(data.customSoundPath)) {
        try {
            const audio = new Audio(`file://${data.customSoundPath}`);
            audio.volume = data.soundVolume / 100;
            audio.play().then(() => {
                console.log('Background alert sound played:', data.customSoundPath);
            }).catch(e => {
                console.log('Failed to play background alert sound:', e);
                playDefaultPackagedSound();
            });
        } catch (e) {
            console.log('Error playing background alert sound:', e);
            playDefaultPackagedSound();
        }
    } else {
        playDefaultPackagedSound();
    }
});

// Back button function
function goBack() {
    ipcRenderer.send('switch-nav-view', 'nav');
}
