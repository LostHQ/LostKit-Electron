# LostKit 2

LostKit is a desktop application built with Electron and JavaScript, designed for [Lost City](https://2004.lostcity.rs/title) players. It provides useful tools such as hiscores lookup, world switcher, stopwatch, chat, notes, screenshot capture, creator notifications and more to enhance your gaming experience.

## Dependencies

1. Node JS: [nodejs.org](https://nodejs.org)
2. Git: [git-scm.com](https://git-scm.com)

## Installation

1. Clone the repository:

```
git clone https://github.com/LostHQ/LostKit-Electron.git
```

2. Install the dependencies:

```
npm install
```

## Usage

### Running the Application

To start the application in development mode:

```
npm start
```

### Building the Application

To package the app for your current platform:

```
npm run package
```

To create distributable files:

```
npm run make
```

The built files will be available in the `out` directory.

### Building Installers with Auto-Update Support

**Windows** (run on a Windows machine):
```
npm run build:win
```

**Linux** (run on a Linux machine):
```
npm run build:linux
```

Built files will be available in the `dist` directory.

## Per OS Instructions

### Windows
- **Installing:** Download `LostKit-2-Setup-x.x.x.exe` from the [Releases page](https://github.com/LostHQ/LostKit-Electron/releases), run it and choose your install folder. Future updates download silently in the background and install the next time you close the app.
- **Development:** Use the commands above in Command Prompt or PowerShell.

### Linux
- **Installing:** Download the AppImage from the [Releases page](https://github.com/LostHQ/LostKit-Electron/releases), make it executable and run it. Updates install automatically in the background, same as Windows.
- **Development:** Use your terminal with the commands above.

### macOS
No pre-built installer is provided for macOS. If you want to run LostKit on a Mac, clone the repo and follow the **Running from Source** steps above — it will work, but you won't receive automatic updates. To get a new version you'll need to `git pull` and restart.

## Auto-Updates (v2.6.0+)

From version 2.6.0 onwards, LostKit updates itself silently on Windows and Linux. When a new version is available it downloads in the background and installs the next time you close the app. You can manage update preferences in **Settings → Updates**.

## License

This project is licensed under the GNU Public License v3.0
