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
 *
 * Occlusion detection: uses WindowFromPoint to check that the window actually
 * visible at the cursor position belongs to the Lostkit process. If another
 * window is covering Lostkit, events are suppressed.
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

// PS_SCRIPT now outputs "x,y,visible" where visible is 1 if the topmost
// window at (x,y) belongs to the Lostkit process, 0 if occluded.
const PS_SCRIPT = `
param([int]$ParentPid = 0)

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public class HoverTracker {
    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT pt);

    [DllImport("user32.dll")]
    public static extern IntPtr WindowFromPoint(POINT pt);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    static HashSet<uint> lostkitPids;

    static void CollectPids(int parentPid) {
        lostkitPids = new HashSet<uint>();
        try {
            var parent = Process.GetProcessById(parentPid);
            string exeName = parent.ProcessName;
            foreach (var p in Process.GetProcessesByName(exeName))
                lostkitPids.Add((uint)p.Id);
        } catch { }
        if (parentPid > 0) lostkitPids.Add((uint)parentPid);
    }

    public static void Run(int parentPid) {
        CollectPids(parentPid);
        POINT pt;
        while (true) {
            if (GetCursorPos(out pt)) {
                IntPtr hwnd = WindowFromPoint(pt);
                uint pid = 0;
                if (hwnd != IntPtr.Zero)
                    GetWindowThreadProcessId(hwnd, out pid);
                int visible = (pid != 0 && lostkitPids.Contains(pid)) ? 1 : 0;
                Console.WriteLine(pt.X + "," + pt.Y + "," + visible);
                Console.Out.Flush();
            }
            Thread.Sleep(100);
        }
    }
}
"@
[HoverTracker]::Run($ParentPid)
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
      '-File', scriptPath,
      '-ParentPid', String(process.pid)
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
        if (parts.length !== 3) continue;
        const x = parseInt(parts[0]);
        const y = parseInt(parts[1]);
        const visible = parseInt(parts[2]); // 1 = Lostkit is topmost at cursor
        if (isNaN(x) || isNaN(y) || isNaN(visible)) continue;

        try {
          const bounds = getBoundsCb && getBoundsCb();
          if (!bounds) continue;

          const inBounds = (
            x >= bounds.x &&
            x <= bounds.x + bounds.width &&
            y >= bounds.y &&
            y <= bounds.y + bounds.height
          );

          // Only count as "inside" if cursor is in bounds AND Lostkit
          // is the topmost window at the cursor (not occluded by another window)
          const isInside = inBounds && visible === 1;

          if (isInside && !wasInside) {
            wasInside = true;
            idleFired = false;
            lastX = x;
            lastY = y;
            armIdleTimer();
            if (onEnterCb) onEnterCb();
          } else if (!isInside && wasInside) {
            wasInside = false;
            idleFired = false;
            clearIdleTimer();
            lastX = null;
            lastY = null;
            if (onLeaveCb) onLeaveCb();
          } else if (isInside && wasInside) {
            const moved = (x !== lastX || y !== lastY);
            if (moved) {
              lastX = x;
              lastY = y;
              if (idleFired) {
                idleFired = false;
                try { if (onEnterCb) onEnterCb(); } catch (e) {}
              }
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
