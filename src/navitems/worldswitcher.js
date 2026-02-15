const { ipcRenderer } = require('electron');

let worlds = [];
let currentWorldType = 'members';

async function loadWorlds() {
    try {
        const response = await fetch('https://2004.losthq.rs/pages/api/worlds.php');
        worlds = await response.json();
        displayWorlds();
        // Measure latency for each world in the background
        worlds.forEach(world => measureWorldLatency(world));
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

    // Calculate total players for filtered worlds
    const totalPlayers = filteredWorlds.reduce((sum, world) => sum + (parseInt(world.count) || 0), 0);
    const totalPlayersDiv = document.getElementById('total-players');
    if (totalPlayersDiv) {
        totalPlayersDiv.textContent = `Total players: ${totalPlayers}`;
    }

    filteredWorlds.forEach(world => {
        const item = document.createElement('div');
        item.className = 'world-item';
        item.id = `world-${world.world}`;

        // Get latency if available, otherwise show "measuring..."
        const latency = world.latency !== undefined ? world.latency : null;
        const latencyColor = latency ? getLatencyColor(latency) : '#888888';
        const latencyText = latency ? `${latency}ms` : 'measuring...';

        item.innerHTML = `
            <div class="world-title">World ${world.world}</div>
            <div class="world-players">${world.count} Online</div>
            <div class="world-latency" style="color: ${latencyColor};">${latencyText}</div>
        `;

        item.onclick = () => selectWorld(world);
        grid.appendChild(item);
    });
}

async function measureWorldLatency(world) {
    try {
        // Ping the world by making a HEAD request to measure latency
        const startTime = performance.now();
        await fetch(world.hd, { method: 'HEAD', mode: 'no-cors' });
        const endTime = performance.now();
        const latency = Math.round(endTime - startTime);
        
        // Store latency in world object
        world.latency = latency;
        
        // Update the display element if it exists
        const worldItem = document.getElementById(`world-${world.world}`);
        if (worldItem) {
            const latencyElement = worldItem.querySelector('.world-latency');
            const latencyColor = getLatencyColor(latency);
            latencyElement.textContent = `${latency}ms`;
            latencyElement.style.color = latencyColor;
        }
    } catch (error) {
        console.error(`Failed to measure latency for world ${world.world}:`, error);
        // If measurement fails, still update the display
        world.latency = -1;
    }
}

function getLatencyColor(latency) {
    // Color coding based on latency thresholds
    if (latency <= 50) {
        return '#00ff00'; // Green - excellent
    } else if (latency <= 80) {
        return '#ffff00'; // Yellow - good
    } else if (latency <= 120) {
        return '#ff8800'; // Orange - fair
    } else {
        return '#ff0000'; // Red - poor
    }
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