const { ipcRenderer } = require('electron');

const skillMap = {
    0: { name: 'Overall', icon: 'stats.webp' },
    1: { name: 'Attack', icon: 'attack.webp' },
    2: { name: 'Defence', icon: 'defence.webp' },
    3: { name: 'Strength', icon: 'strength.webp' },
    4: { name: 'Hitpoints', icon: 'hitpoints.webp' },
    5: { name: 'Ranged', icon: 'ranged.webp' },
    6: { name: 'Prayer', icon: 'prayer.webp' },
    7: { name: 'Magic', icon: 'magic.webp' },
    8: { name: 'Cooking', icon: 'cooking.webp' },
    9: { name: 'Woodcutting', icon: 'woodcutting.webp' },
    10: { name: 'Fletching', icon: 'fletching.webp' },
    11: { name: 'Fishing', icon: 'fishing.webp' },
    12: { name: 'Firemaking', icon: 'firemaking.webp' },
    13: { name: 'Crafting', icon: 'crafting.webp' },
    14: { name: 'Smithing', icon: 'smithing.webp' },
    15: { name: 'Mining', icon: 'mining.webp' },
    16: { name: 'Herblore', icon: 'herblore.webp' },
    17: { name: 'Agility', icon: 'agility.webp' },
    18: { name: 'Thieving', icon: 'thieving.webp' },
    21: { name: 'Runecraft', icon: 'runecraft.webp' }
};

async function lookupPlayer() {
    const playerName = document.getElementById('playerName').value.trim();
    if (!playerName) {
        alert('Please enter a player name');
        return;
    }

    document.getElementById('playerStats').style.display = 'none';
    document.getElementById('error').style.display = 'none';
    document.getElementById('loading').style.display = 'block';

    try {
        const response = await fetch(`https://2004.lostcity.rs/api/hiscores/player/${encodeURIComponent(playerName)}`);

        if (!response.ok) {
            throw new Error('Player not found');
        }

        const data = await response.json();
        displayPlayerStats(playerName, data);
    } catch (error) {
        console.error('Error fetching player data:', error);
        document.getElementById('loading').style.display = 'none';
        document.getElementById('error').style.display = 'block';
    }
}

function displayPlayerStats(playerName, statsData) {
    document.getElementById('loading').style.display = 'none';

    const statsGrid = document.querySelector('.stats-grid');
    statsGrid.innerHTML = '';

    const skillOrder = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21];

    const statsMap = {};
    statsData.forEach(stat => {
        statsMap[stat.type] = stat;
    });

    skillOrder.forEach(skillType => {
        const stat = statsMap[skillType];
        const skill = skillMap[skillType];

        if (stat && skill) {
            const statRow = document.createElement('div');
            statRow.className = 'stat-row';

            statRow.innerHTML = `
                <img src="../assets/skillicons/${skill.icon}" alt="${skill.name}" class="stat-icon">
                <div class="stat-info">
                    <div class="stat-values">
                        <span class="stat-level">Level: ${stat.level.toLocaleString()}</span>
                        <span class="stat-xp">XP: ${Math.floor(stat.value / 10).toLocaleString()}</span>
                        <span class="stat-rank">Rank: ${stat.rank.toLocaleString()}</span>
                    </div>
                </div>
            `;

            statsGrid.appendChild(statRow);
        }
    });

    document.getElementById('playerStats').style.display = 'block';
}

document.addEventListener('DOMContentLoaded', () => {
    const playerInput = document.getElementById('playerName');
    if (playerInput) {
        playerInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                lookupPlayer();
            }
        });
    }
});

function goBack() {
    ipcRenderer.send('switch-nav-view', 'nav');
}