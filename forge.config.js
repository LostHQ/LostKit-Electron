const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
    packagerConfig: {
        asar: true,
        icon: 'src/assets/icon.ico',
        outDir: 'out',
        win32metadata: {
            ProductName: 'LostKit 2 - by LostHQ Team'
        }
    },
    rebuildConfig: {},
    makers: [
        // Windows Squirrel Installer
        {
            name: '@electron-forge/maker-squirrel',
            config: {
                setupIcon: 'src/assets/icon.ico'
            },
        },
        // Universal - Portable ZIP
        {
            name: '@electron-forge/maker-zip',
            config: {
                bin: 'LostKit'
            }
        }
    ],
    plugins: [
        {
            name: '@electron-forge/plugin-auto-unpack-natives',
            config: {},
        },
        new FusesPlugin({
            version: FuseVersion.V1,
            [FuseV1Options.RunAsNode]: false,
            [FuseV1Options.EnableCookieEncryption]: true,
            [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
            [FuseV1Options.EnableNodeCliInspectArguments]: false,
            [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
            [FuseV1Options.OnlyLoadAppFromAsar]: false,
        }),
    ],
    publishers: [
        {
            name: '@electron-forge/publisher-github',
            config: {
                repository: {
                    owner: 'LostHQ',
                    name: 'LostKit-Electron'
                }
            }
        }
    ]
};