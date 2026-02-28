/**
 * native-hover.js
 *
 * Polls cursor position every 100ms via PowerShell + Win32 GetCursorPos.
 * Fires onEnter() when cursor moves INTO the given bounds,
 * fires onLeave() when cursor moves OUT,
 * fires onIdle() when cursor has been INSIDE and NOT MOVED for idleMs milliseconds.
 *
 * Only fires on state transitions — no jitter.
 * Works whether Electron is focused or not.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let psProcess = null;
let scriptPath = null;
let getBoundsCb = null;
let onEnterCb = null;
let onLeaveCb = null;
let onIdleCb = null;
let idleMs = 2000;
let wasInside = false;
let idleTimer = null;
let lastX = null;
let lastY = null;
let idleFired = false;

const PS_SCRIPT = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Threading;

public class HoverTracker {
    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT pt);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    public static void Run() {
        POINT pt;
        while (true) {
            if (GetCursorPos(out pt)) {
                Console.WriteLine(pt.X + "," + pt.Y);
                Console.Out.Flush();
            }
            Thread.Sleep(100);
        }
    }
}
"@
[HoverTracker]::Run()
`;

function clearIdleTimer() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

function armIdleTimer() {
  clearIdleTimer();
  if (!onIdleCb) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (wasInside && !idleFired) {
      idleFired = true;
      try { onIdleCb(); } catch (e) {}
    }
  }, idleMs);
}

/**
 * start(getBounds, onEnter, onLeave, onIdle, idleTimeoutMs)
 *   onIdle  — called when cursor has been inside and stopped moving for idleTimeoutMs ms
 *   idleTimeoutMs — default 2000 (2 seconds)
 */
function start(getBounds, onEnter, onLeave, onIdle, idleTimeoutMs) {
  if (psProcess) return;
  if (process.platform !== 'win32') return;

  getBoundsCb = getBounds;
  onEnterCb = onEnter;
  onLeaveCb = onLeave;
  onIdleCb = onIdle || null;
  idleMs = idleTimeoutMs != null ? idleTimeoutMs : 2000;
  wasInside = false;
  idleFired = false;
  lastX = null;
  lastY = null;

  try {
    scriptPath = path.join(os.tmpdir(), 'lostkit-hover.ps1');
    fs.writeFileSync(scriptPath, PS_SCRIPT, 'utf8');

    psProcess = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath
    ], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    });

    let buf = '';
    psProcess.stdout.on('data', (data) => {
      buf += data.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(',');
        if (parts.length !== 2) continue;
        const x = parseInt(parts[0]);
        const y = parseInt(parts[1]);
        if (isNaN(x) || isNaN(y)) continue;

        try {
          const bounds = getBoundsCb && getBoundsCb();
          if (!bounds) continue;

          const isInside = (
            x >= bounds.x &&
            x <= bounds.x + bounds.width &&
            y >= bounds.y &&
            y <= bounds.y + bounds.height
          );

          if (isInside && !wasInside) {
            // Entered canvas
            wasInside = true;
            idleFired = false;
            lastX = x;
            lastY = y;
            armIdleTimer();
            if (onEnterCb) onEnterCb();
          } else if (!isInside && wasInside) {
            // Left canvas
            wasInside = false;
            idleFired = false;
            clearIdleTimer();
            lastX = null;
            lastY = null;
            if (onLeaveCb) onLeaveCb();
          } else if (isInside && wasInside) {
            // Still inside — check for movement
            const moved = (x !== lastX || y !== lastY);
            if (moved) {
              lastX = x;
              lastY = y;
              if (idleFired) {
                // Was idle but mouse moved again — fire onEnter again so the
                // main process knows to pause the timer (un-idle re-pause)
                idleFired = false;
                try { if (onEnterCb) onEnterCb(); } catch (e) {}
              }
              // Re-arm idle timer on any movement
              armIdleTimer();
            }
          }
        } catch (e) {}
      }
    });

    psProcess.on('error', (e) => {
      console.error('hover tracker: error:', e.message);
      psProcess = null;
    });

    psProcess.on('exit', () => { psProcess = null; });

    console.log('hover tracker: started (pid', psProcess.pid + ')');
  } catch (e) {
    console.error('hover tracker: failed to start -', e.message);
    psProcess = null;
  }
}

function stop() {
  clearIdleTimer();
  getBoundsCb = null;
  onEnterCb = null;
  onLeaveCb = null;
  onIdleCb = null;
  wasInside = false;
  idleFired = false;
  lastX = null;
  lastY = null;
  if (psProcess) {
    try { psProcess.kill(); } catch (e) {}
    psProcess = null;
  }
  if (scriptPath) {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
    scriptPath = null;
  }
  console.log('hover tracker: stopped');
}

function destroy() { stop(); }

module.exports = { start, stop, destroy };
