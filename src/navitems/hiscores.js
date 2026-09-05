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

// Cumulative XP required to reach a given level (standard RuneScape formula).
function xpForLevel(level) {
    if (level <= 1) return 0;
    let points = 0;
    for (let lvl = 1; lvl < level; lvl++) {
        points += Math.floor(lvl + 300 * Math.pow(2, lvl / 7));
    }
    return Math.floor(points / 4);
}

// Compute the progress-to-next-level bar and the remaining-XP text for a skill.
// Overall (type 0) has no single next level, so it gets neither.
function computeSkillProgress(skillType, level, xp) {
    if (skillType === 0) return { bar: '', next: '' };
    if (level >= 99) {
        return {
            bar: '<div class="stat-progress maxed"><div class="stat-progress-fill" style="width:100%"></div></div>',
            next: '<span class="stat-next maxed">Maxed</span>'
        };
    }
    const base = xpForLevel(level);
    const nextLvlXp = xpForLevel(level + 1);
    const span = nextLvlXp - base;
    const into = Math.max(0, xp - base);
    const pct = span > 0 ? Math.max(0, Math.min(100, (into / span) * 100)) : 0;
    const remaining = Math.max(0, nextLvlXp - xp);
    return {
        bar: `<div class="stat-progress" title="${remaining.toLocaleString()} XP to level ${level + 1}"><div class="stat-progress-fill" style="width:${pct.toFixed(1)}%"></div></div>`,
        next: `<span class="stat-next">Next: ${remaining.toLocaleString()} XP</span>`
    };
}

async function lookupPlayer() {
    const playerName = document.getElementById('playerName').value.trim();
    if (!playerName) {
        alert('Please enter a player name');
        return;
    }

    document.getElementById('playerStats').style.display = 'none';
    document.getElementById('error').style.display = 'none';
    document.getElementById('loading').style.display = 'block';

    // Same route the compare window uses, so both share one cache, one rate
    // limiter and one set of error messages. Fetching straight from here used
    // to report every failure as "player not found" - including a rate limit,
    // which is a wait-and-retry, not a missing player.
    const res = await ipcRenderer.invoke('hiscores-lookup', playerName);
    document.getElementById('loading').style.display = 'none';

    if (!res.ok) {
        const err = document.getElementById('error');
        err.textContent = HISCORES_ERRORS[res.error] || 'Could not look that player up.';
        err.style.display = 'block';
        return;
    }
    displayPlayerStats(res.name, res.stats);
}

const HISCORES_ERRORS = {
    empty:       'Enter a player name.',
    notfound:    'No hiscores entry for that name.',
    ratelimited: 'The hiscores API is rate limiting us - wait a moment and try again.',
    network:     'Could not reach the hiscores API.'
};

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

            const xp = Math.floor(stat.value / 10);
            const progress = computeSkillProgress(skillType, stat.level, xp);

            statRow.innerHTML = `
                <img src="../assets/skillicons/${skill.icon}" alt="${skill.name}" class="stat-icon">
                <div class="stat-info">
                    <div class="stat-values">
                        <span class="stat-level">Level: ${stat.level.toLocaleString()}</span>
                        <span class="stat-xp">XP: ${xp.toLocaleString()}</span>
                        <span class="stat-rank">Rank: ${stat.rank.toLocaleString()}</span>
                        ${progress.next}
                    </div>
                </div>
                ${progress.bar}
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

// Opens the compare window, carrying whatever name is already typed here so the
// lookup you were doing becomes the left-hand side of the comparison.
function openCompare() {
    const typed = (document.getElementById('playerName') || {}).value || '';
    ipcRenderer.send('open-compare-window', { p1: typed.trim(), p2: '' });
}