const { ipcRenderer } = require('electron');

let currentMode = 'afk'; // 'afk', 'countdown', or 'stopwatch'
let countdownTime = 90;
let soundAlert = false;
let soundVolume = 30;
let autoLoop = false;
let afkAuto = false;
let color = '#00ff00';
let size = 48;
let opacity = 100;

// DOM Elements
const modeDisplay = document.getElementById('mode-display');
const afkBtn = document.getElementById('afk-btn');
const countdownBtn = document.getElementById('countdown-btn');
const stopwatchBtn = document.getElementById('stopwatch-btn');
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
const afkAutoCheckbox = document.getElementById('afk-auto-checkbox');

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

function playBeep() {
    if (!soundAlert || !audioContext) return;
    
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
        
        console.log('Beep played at volume:', soundVolume);
        setTimeout(() => { soundPlayed = false; }, 10000);
        
    } catch (e) {
        console.log('Error playing beep:', e);
    }
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
            
            if (remaining <= 10) {
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
});

// Auto-loop checkbox
autoLoopCheckbox.addEventListener('change', () => {
    autoLoop = autoLoopCheckbox.checked;
});

// AFK Auto checkbox
afkAutoCheckbox.addEventListener('change', () => {
    afkAuto = afkAutoCheckbox.checked;
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
    playTestBeep(soundVolume);
});

// Color picker
colorPicker.addEventListener('input', (e) => {
    color = e.target.value;
    if (!timerDisplay.classList.contains('flash-red')) {
        timerDisplay.style.color = color;
    }
});

// Size slider
sizeSlider.addEventListener('input', (e) => {
    size = parseInt(e.target.value);
    sizeValue.textContent = `${size}px`;
    timerDisplay.style.fontSize = size + 'px';
});

// Opacity slider
opacitySlider.addEventListener('input', (e) => {
    opacity = parseInt(e.target.value);
    opacityValue.textContent = `${opacity}%`;
    timerDisplay.style.opacity = opacity / 100;
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
afkAutoCheckbox.checked = afkAuto;

// Apply initial styling
timerDisplay.style.fontSize = size + 'px';
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
    console.log('Received afk-auto-stop signal');
    
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
});

// Back button function
function goBack() {
    ipcRenderer.send('switch-nav-view', 'nav');
}