const { ipcRenderer } = require('electron');

let worlds = [];

async function loadWorlds() {
    try {
        const response = await fetch('https://2004.losthq.rs/pages/api/worlds.php');
        worlds = await response.json();
        displayWorlds();
    } catch (error) {
        console.error('Failed to load worlds:', error);
        document.getElementById('content').innerHTML = '<div class="loading">Failed to load worlds. Please try again.</div>';
    }
}

function displayWorlds() {
    const content = document.getElementById('content');
    content.innerHTML = '<ul class="world-list"></ul>';
    const list = content.querySelector('.world-list');

    worlds.forEach(world => {
        const item = document.createElement('li');
        item.className = 'world-item';

        const info = document.createElement('div');
        info.className = 'world-info';
        info.innerHTML = `
            W${world.world} (${world.location}) ${world.p2p ? 'P2P' : 'F2P'}<br>
            Players: ${world.count}
        `;

        const buttons = document.createElement('div');
        buttons.className = 'world-buttons';

        const hdBtn = document.createElement('button');
        hdBtn.className = 'hd-btn';
        hdBtn.textContent = 'HD';
        hdBtn.onclick = () => selectWorld(world, 'hd');

        const ldBtn = document.createElement('button');
        ldBtn.className = 'ld-btn';
        ldBtn.textContent = 'LD';
        ldBtn.onclick = () => selectWorld(world, 'ld');

        buttons.appendChild(hdBtn);
        buttons.appendChild(ldBtn);

        item.appendChild(info);
        item.appendChild(buttons);
        list.appendChild(item);
    });
}

function selectWorld(world, detail) {
    const url = detail === 'hd' ? world.hd : world.ld;
    const title = `W${world.world} ${detail.toUpperCase()}`;
    ipcRenderer.send('select-world', url, title);
}

function refreshWorlds() {
    loadWorlds();
}

function goBack() {
    ipcRenderer.send('switch-nav-view', 'nav');
}

window.onload = loadWorlds;