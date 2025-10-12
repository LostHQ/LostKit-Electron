const { ipcRenderer } = require('electron');

let worlds = [];
let currentWorldType = 'members';

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

function selectWorldType(type) {
    currentWorldType = type;

    document.getElementById('free-btn').classList.toggle('active', type === 'free');
    document.getElementById('members-btn').classList.toggle('active', type === 'members');
    
    displayWorlds();
}

function displayWorlds() {
    const content = document.getElementById('content');
    content.innerHTML = '<div class="world-grid"></div>';
    const grid = content.querySelector('.world-grid');

    const filteredWorlds = worlds.filter(world => {
        if (currentWorldType === 'free') {
            return !world.p2p;
        } else {
            return world.p2p;
        }
    });

    filteredWorlds.forEach(world => {
        const item = document.createElement('div');
        item.className = 'world-item';

        item.innerHTML = `
            <div class="world-title">World ${world.world}</div>
            <div class="world-players">${world.count} Online</div>
        `;

        item.onclick = () => selectWorld(world);
        grid.appendChild(item);
    });
}

function selectWorld(world) {
    const isHighDetail = document.getElementById('high-detail-checkbox').checked;
    const url = isHighDetail ? world.hd : world.ld;
    const title = `W${world.world} ${isHighDetail ? 'HD' : 'LD'}`;
    ipcRenderer.send('select-world', url, title);
}

function refreshWorlds() {
    loadWorlds();
}

function goBack() {
    ipcRenderer.send('switch-nav-view', 'nav');
}

window.onload = loadWorlds;