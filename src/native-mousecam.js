/**
 * native-mousecam.js
 *
 * Replicates mousecam.ahk without AutoHotkey.
 *
 * Uses PowerShell + Win32 SetWindowsHookEx (WH_MOUSE_LL) to:
 *   1. Intercept middle mouse button at the OS level and SWALLOW it
 *      so it never reaches Electron or the game as a click.
 *   2. While middle is held, send arrow keys via keybd_event based
 *      on cursor offset from anchor — identical to the AHK script.
 *
 * Windows only. start()/stop()/destroy() are safe to call at any time.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let psProcess = null;
let scriptPath = null;

const PS_SCRIPT = `
Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class MouseCam {
    const int WH_MOUSE_LL    = 14;
    const int WM_MBUTTONDOWN = 0x0207;
    const int WM_MBUTTONUP   = 0x0208;
    const int WM_MOUSEMOVE   = 0x0200;

    const byte VK_LEFT  = 0x25;
    const byte VK_UP    = 0x26;
    const byte VK_RIGHT = 0x27;
    const byte VK_DOWN  = 0x28;
    const uint KEYUP    = 0x0002;

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    struct MSLLHOOKSTRUCT {
        public POINT pt;
        public uint mouseData, flags, time;
        public IntPtr dwExtraInfo;
    }

    delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string lpModuleName);

    static IntPtr hookId = IntPtr.Zero;
    static LowLevelMouseProc hookProc;

    static bool middleDown = false;
    static int anchorX, anchorY;
    static bool lDown, rDown, uDown, dDown;

    static void Key(byte vk, bool press, ref bool state) {
        if (press  && !state) { keybd_event(vk, 0, 0,     UIntPtr.Zero); state = true;  }
        if (!press && state)  { keybd_event(vk, 0, KEYUP, UIntPtr.Zero); state = false; }
    }

    static void ReleaseAll() {
        Key(VK_LEFT,  false, ref lDown);
        Key(VK_RIGHT, false, ref rDown);
        Key(VK_UP,    false, ref uDown);
        Key(VK_DOWN,  false, ref dDown);
    }

    static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode < 0) return CallNextHookEx(hookId, nCode, wParam, lParam);

        int msg = wParam.ToInt32();
        var data = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));

        if (msg == WM_MBUTTONDOWN) {
            middleDown = true;
            anchorX = data.pt.X;
            anchorY = data.pt.Y;
            return (IntPtr)1; // swallow — game never sees the click
        }

        if (msg == WM_MBUTTONUP) {
            middleDown = false;
            ReleaseAll();
            return (IntPtr)1; // swallow
        }

        if (msg == WM_MOUSEMOVE && middleDown) {
            int dx = data.pt.X - anchorX;
            int dy = data.pt.Y - anchorY;
            Key(VK_LEFT,  dx > 0, ref lDown);
            Key(VK_RIGHT, dx < 0, ref rDown);
            Key(VK_DOWN,  dy < 0, ref dDown);
            Key(VK_UP,    dy > 0, ref uDown);
        }

        return CallNextHookEx(hookId, nCode, wParam, lParam);
    }

    public static void Run() {
        hookProc = HookCallback;
        using (var process = Process.GetCurrentProcess())
        using (var module  = process.MainModule) {
            hookId = SetWindowsHookEx(WH_MOUSE_LL, hookProc, GetModuleHandle(module.ModuleName), 0);
        }
        Application.Run();
        UnhookWindowsHookEx(hookId);
        ReleaseAll();
    }
}
"@ -ReferencedAssemblies System.Windows.Forms

[MouseCam]::Run()
`;

function start() {
  if (psProcess) return;

  if (process.platform !== 'win32') {
    console.log('mousecam: Windows only, skipping');
    return;
  }

  try {
    scriptPath = path.join(os.tmpdir(), 'lostkit-mousecam.ps1');
    fs.writeFileSync(scriptPath, PS_SCRIPT, 'utf8');

    psProcess = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath
    ], {
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true
    });

    psProcess.on('error', (e) => {
      console.error('mousecam: PowerShell error:', e.message);
      psProcess = null;
    });

    psProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.error('mousecam: PowerShell exited with code', code);
      }
      psProcess = null;
    });

    console.log('mousecam: started (pid', psProcess.pid + ')');
  } catch (e) {
    console.error('mousecam: failed to start -', e.message);
    psProcess = null;
  }
}

function stop() {
  if (psProcess) {
    try { psProcess.kill(); } catch (e) {}
    psProcess = null;
  }
  if (scriptPath) {
    try { fs.unlinkSync(scriptPath); } catch (e) {}
    scriptPath = null;
  }
  console.log('mousecam: stopped');
}

function destroy() {
  stop();
}

module.exports = { start, stop, destroy };
