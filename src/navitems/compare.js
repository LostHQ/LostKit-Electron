const { ipcRenderer } = require('electron');

// Same skill table hiscores.js uses. Kept local rather than shared so the
// working hiscores panel is left untouched.
const SKILLS = {
    0:  { name: 'Overall',     icon: 'stats.webp' },
    1:  { name: 'Attack',      icon: 'attack.webp' },
    2:  { name: 'Defence',     icon: 'defence.webp' },
    3:  { name: 'Strength',    icon: 'strength.webp' },
    4:  { name: 'Hitpoints',   icon: 'hitpoints.webp' },
    5:  { name: 'Ranged',      icon: 'ranged.webp' },
    6:  { name: 'Prayer',      icon: 'prayer.webp' },
    7:  { name: 'Magic',       icon: 'magic.webp' },
    8:  { name: 'Cooking',     icon: 'cooking.webp' },
    9:  { name: 'Woodcutting', icon: 'woodcutting.webp' },
    10: { name: 'Fletching',   icon: 'fletching.webp' },
    11: { name: 'Fishing',     icon: 'fishing.webp' },
    12: { name: 'Firemaking',  icon: 'firemaking.webp' },
    13: { name: 'Crafting',    icon: 'crafting.webp' },
    14: { name: 'Smithing',    icon: 'smithing.webp' },
    15: { name: 'Mining',      icon: 'mining.webp' },
    16: { name: 'Herblore',    icon: 'herblore.webp' },
    17: { name: 'Agility',     icon: 'agility.webp' },
    18: { name: 'Thieving',    icon: 'thieving.webp' },
    21: { name: 'Runecraft',   icon: 'runecraft.webp' }
};
const SKILL_ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21];

const $ = (id) => document.getElementById(id);

let mode = 'levels';
let current = null;   // { a: {name, byType}, b: {name, byType} }

const ERRORS = {
    empty:       'Enter a name.',
    notfound:    'No hiscores entry for that name.',
    ratelimited: 'The hiscores API is rate limiting us — wait a moment and try again.',
    network:     'Could not reach the hiscores API.'
};

function formatXp(xp) {
    if (xp >= 1000000) return (xp / 1000000).toFixed(1).replace(/\.0$/, '') + 'm';
    if (xp >= 1000) return Math.round(xp / 1000) + 'k';
    return String(xp);
}

function indexStats(stats) {
    const byType = {};
    stats.forEach(s => { byType[s.type] = { level: s.level, xp: Math.floor(s.value / 10), rank: s.rank }; });
    return byType;
}

// ── Lookup ──────────────────────────────────────────────────────────────────
async function compare() {
    const n1 = $('p1').value.trim();
    const n2 = $('p2').value.trim();
    if (!n1 || !n2) { setStatus('Enter both names.', true); return; }

    $('go').disabled = true;
    setStatus(`Looking up ${n1} and ${n2}…`);
    $('results').innerHTML = '';
    $('summary').innerHTML = '';

    // Sequential, not parallel: the API rate limits and two at once can trip it.
    const a = await ipcRenderer.invoke('hiscores-lookup', n1);
    const b = a.ok ? await ipcRenderer.invoke('hiscores-lookup', n2) : null;
    $('go').disabled = false;

    if (!a.ok) { setStatus(`${n1}: ${ERRORS[a.error] || a.error}`, true); return; }
    if (!b.ok) { setStatus(`${n2}: ${ERRORS[b.error] || b.error}`, true); return; }

    current = { a: { name: a.name, byType: indexStats(a.stats) },
                b: { name: b.name, byType: indexStats(b.stats) } };
    setStatus('');
    render();
}

function setStatus(text, isError) {
    $('status').textContent = text;
    $('status').classList.toggle('error', !!isError);
}

// ── Render ──────────────────────────────────────────────────────────────────
const valueOf = (side, type) => {
    const s = side.byType[type];
    if (!s) return null;
    return mode === 'xp' ? s.xp : s.level;
};

// Levels stop at 99, so two maxed accounts look identical on level alone even
// when one has ten times the xp. XP breaks every level tie — which past 99 is
// the only thing that separates anyone.
function compareSides(sa, sb) {
    const va = sa ? (mode === 'xp' ? sa.xp : sa.level) : 0;
    const vb = sb ? (mode === 'xp' ? sb.xp : sb.level) : 0;
    if (va !== vb) {
        return { verdict: va > vb ? 'up' : 'down', gap: Math.abs(va - vb), unit: mode === 'xp' ? 'xp' : 'levels', byXp: false };
    }
    const xa = sa ? sa.xp : 0;
    const xb = sb ? sb.xp : 0;
    if (xa !== xb) {
        return { verdict: xa > xb ? 'up' : 'down', gap: Math.abs(xa - xb), unit: 'xp', byXp: true };
    }
    return { verdict: 'same', gap: 0, unit: '', byXp: false };
}

function render() {
    if (!current) return;
    const { a, b } = current;
    const host = $('results');
    host.innerHTML = '';
    host.appendChild(buildHeader(a, b));

    // Total first, as its own row — it is the headline result, and it is not a
    // skill, so it stays out of the skills-won tally below.
    const totalCmp = compareSides(a.byType[0], b.byType[0]);
    const totalRow = buildRow(0, a.byType[0], b.byType[0], totalCmp);
    totalRow.classList.add('total');
    host.appendChild(totalRow);

    let ahead = 0, behind = 0, tied = 0;
    SKILL_ORDER.forEach(type => {
        const cmp = compareSides(a.byType[type], b.byType[type]);
        if (cmp.verdict === 'up') ahead++; else if (cmp.verdict === 'down') behind++; else tied++;
        host.appendChild(buildRow(type, a.byType[type], b.byType[type], cmp));
    });

    const totalLine = totalCmp.verdict === 'same'
        ? `Total <span class="even">dead level</span>`
        : `Total: <span class="${totalCmp.verdict === 'up' ? 'win' : 'lose'}">` +
          `${escapeHtml(totalCmp.verdict === 'up' ? a.name : b.name)}</span>` +
          ` by ${totalCmp.gap.toLocaleString()} ${totalCmp.unit}`;

    $('summary').innerHTML =
        `${totalLine} &nbsp;·&nbsp; skills <span class="win">${ahead}</span>–<span class="lose">${behind}</span>` +
        `${tied ? `, <span class="even">${tied}</span> tied` : ''}`;
}

function buildHeader(a, b) {
    const head = document.createElement('div');
    head.className = 'cmp-head';
    head.appendChild(nameCell(a, false));
    const spacer = document.createElement('span');
    head.appendChild(spacer);
    head.appendChild(nameCell(b, true));
    return head;
}

function nameCell(side, right) {
    const cell = document.createElement('span');
    cell.className = 'name' + (right ? ' right' : '');
    cell.textContent = side.name;
    const total = side.byType[0];
    const tot = document.createElement('span');
    tot.className = 'tot';
    tot.textContent = total
        ? `total ${total.level.toLocaleString()} · ${formatXp(total.xp)} xp`
        : 'no overall entry';
    cell.appendChild(tot);
    return cell;
}

function buildRow(type, statA, statB, cmp) {
    const skill = SKILLS[type];
    const verdict = cmp.verdict;
    const row = document.createElement('div');
    row.className = 'cmp-row' + (cmp.byXp ? ' by-xp' : '');
    row.title = `${skill.name}\n${statLine(statA)}\n${statLine(statB)}` +
                (cmp.gap ? `\ndifference: ${cmp.gap.toLocaleString()} ${cmp.unit}` : '') +
                (cmp.byXp ? '\n(same level — decided on xp)' : '');

    const arrow = document.createElement('span');
    arrow.className = 'cmp-arrow ' + verdict;
    arrow.textContent = verdict === 'up' ? '◀' : verdict === 'down' ? '▶' : '=';

    // Mirrored: icons on the outside, arrow in the middle, so each half reads
    // as its own table underneath that player's name.
    // Each half keeps its own numbers together against its own icon, so the
    // slack collects in the middle around the arrow rather than splitting a
    // player's level from their xp.
    row.append(
        skillIcon(skill),
        valueCell(statA, verdict === 'up'  ? 'win-up'   : null),
        subCell(statA, 'left'),
        arrow,
        subCell(statB, 'right'),
        valueCell(statB, verdict === 'down' ? 'win-down' : null),
        skillIcon(skill)
    );
    return row;
}

function skillIcon(skill) {
    const img = document.createElement('img');
    img.className = 'cmp-icon';
    img.src = `../assets/skillicons/${skill.icon}`;
    img.alt = skill.name;
    img.title = skill.name;
    img.onerror = () => { img.style.visibility = 'hidden'; };
    return img;
}

function valueCell(stat, winClass) {
    const cell = document.createElement('span');
    cell.className = 'cmp-val' + (winClass ? ' ' + winClass : '') + (stat ? '' : ' none');
    cell.textContent = !stat ? '—' : (mode === 'xp' ? formatXp(stat.xp) : String(stat.level));
    return cell;
}

// The secondary number: whichever of level/xp is not currently the headline.
function subCell(stat, align) {
    const cell = document.createElement('span');
    cell.className = 'cmp-sub ' + align;
    cell.textContent = !stat ? 'not ranked' : (mode === 'xp' ? `lvl ${stat.level}` : `${formatXp(stat.xp)} xp`);
    return cell;
}

const statLine = (s) => s ? `lvl ${s.level} · ${s.xp.toLocaleString()} xp · rank ${s.rank.toLocaleString()}` : 'not ranked';

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── Wiring ──────────────────────────────────────────────────────────────────
$('go').onclick = compare;
$('swap').onclick = () => {
    const v = $('p1').value; $('p1').value = $('p2').value; $('p2').value = v;
    if (current) { current = { a: current.b, b: current.a }; render(); }
};
[$('p1'), $('p2')].forEach(i => i.addEventListener('keypress', e => { if (e.key === 'Enter') compare(); }));

$('mode-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('.cmp-seg-btn');
    if (!btn) return;
    mode = btn.dataset.mode;
    [...$('mode-seg').children].forEach(b => b.classList.toggle('active', b === btn));
    render();
});

ipcRenderer.on('compare-prefill', (event, names) => {
    if (!names) return;
    if (names.p1) $('p1').value = names.p1;
    if (names.p2) $('p2').value = names.p2;
    if (names.p1 && names.p2) compare(); else $(names.p1 ? 'p2' : 'p1').focus();
});

$('results').innerHTML = '<div class="cmp-empty">Compare two accounts skill by skill.<br>' +
    'The arrow points at whoever leads — green when the left player is ahead, red when behind, blue when level.</div>';
$('p1').focus();
