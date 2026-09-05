const { ipcRenderer } = require('electron');

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';

const W = 1000, H = 380;
const M = { top: 18, right: 20, bottom: 34, left: 90 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;

let item = { slug: '', name: '' };
let allTrades = [];              // everything fetched, oldest first
let totalOnRecord = 0;
let loadedOldest = null;         // oldest timestamp we hold
let loadedComplete = false;      // true once the market has no more pages
let rangeDays = 0;               // 0 = all
let series = { sell: true, buy: true };
let payment = 'all';             // all | coins | mixed | items
let zoom = null;                 // { t0, t1 } when zoomed in
let searchTimer = null;
let plotted = [];                // points currently on screen, for hit testing

const params = new URLSearchParams(location.search);
if (params.get('slug')) item = { slug: params.get('slug'), name: params.get('name') || params.get('slug') };

// ── Formatting ──────────────────────────────────────────────────────────────
function formatGp(n) {
    if (n == null) return '-';
    if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1).replace(/\.0$/, '') + 'm';
    if (n >= 1000) return Math.round(n / 1000) + 'k';
    if (n < 10 && n % 1 !== 0) return n.toFixed(2).replace(/0$/, '');
    return n.toLocaleString();
}

function timeAgo(when) {
    const mins = Math.floor((Date.now() - new Date(when).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    const days = Math.floor(hrs / 24);
    if (days < 30) return days + 'd ago';
    const months = Math.floor(days / 30);
    return months + (months === 1 ? ' month ago' : ' months ago');
}

const shortDate = (when) => new Date(when).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const fullDate = (when) => new Date(when).toLocaleString();
const timeOf = (t) => new Date(t.soldAt).getTime();

const svgEl = (name, attrs) => {
    const el = document.createElementNS(SVG_NS, name);
    Object.entries(attrs || {}).forEach(([k, v]) => el.setAttribute(k, v));
    return el;
};

const escapeHtml = (s) => String(s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A valuation that lands wildly outside what the item actually goes for is a
// mistake, not a price. The usual cause is a unit slip: someone selling dragon
// bones asks for "2,900 Dragon bones" where they meant 2,900 coins, and the
// offer duly values at 2,900 times the going rate. One such point rescales the
// whole chart and squashes three months of real prices into a flat line at the
// bottom, so it is left off - listed underneath instead, where it can be seen
// for what it is.
const OUTLIER_FACTOR = 20;
let plotReference = null;

// The item's own clean coin sales are the yardstick. Below three of them there
// is no yardstick, and nothing is judged.
function updatePlotReference() {
    const prices = allTrades
        .filter(t => t.kind === 'coins' && !t.suspect && t.price != null)
        .map(t => t.price)
        .sort((a, b) => a - b);
    plotReference = prices.length >= 3 ? prices[Math.floor(prices.length / 2)] : null;
}

const estimateOutOfScale = (t) =>
    plotReference != null && t.estimate && t.estimate.unit != null &&
    (t.estimate.unit > plotReference * OUTLIER_FACTOR || t.estimate.unit < plotReference / OUTLIER_FACTOR);

// Where a trade sits on the price axis: its estimated worth once the item half
// has been valued, otherwise the coin figure alone.
const plotValue = (t) => (t.estimate && t.estimate.unit != null)
    ? (estimateOutOfScale(t) ? null : t.estimate.unit)
    : t.price;

// ── Filtering ───────────────────────────────────────────────────────────────
function visibleTrades() {
    const cutoff = rangeDays ? Date.now() - rangeDays * 86400000 : null;
    return allTrades.filter(t => {
        if (cutoff && timeOf(t) < cutoff) return false;
        if (zoom && (timeOf(t) < zoom.t0 || timeOf(t) > zoom.t1)) return false;
        if (payment !== 'all' && t.kind !== payment) return false;
        if (!series[t.type]) return false;
        return true;
    });
}

// ── Load ────────────────────────────────────────────────────────────────────
async function load(force) {
    if (!item.slug) return;
    $('item-name').textContent = item.name;
    $('sprite').style.visibility = 'visible';
    $('sprite').src = `https://markets.lostcity.rs/img/items/${encodeURIComponent(item.slug)}.webp`;
    $('sprite').onerror = () => { $('sprite').style.visibility = 'hidden'; };
    $('subtitle').textContent = 'Loading completed trades…';
    $('refresh').disabled = true;

    // "All" means as far back as the market will give us, not the first page.
    const res = await ipcRenderer.invoke('market-price-history', item.slug, { days: rangeDays || 3650 });
    allTrades = res.trades || [];
    totalOnRecord = res.total || 0;
    loadedOldest = res.oldest || null;
    loadedComplete = !!res.complete;
    updatePlotReference();
    $('refresh').disabled = false;
    zoom = null;
    draw();
    loadSnapshot();
    estimateOffers();
}

// What it is going for right now - the number you actually want when pricing
// your own offer, as opposed to what it historically sold for.
async function loadSnapshot() {
    const host = $('snapshot');
    host.innerHTML = '';
    const live = await ipcRenderer.invoke('market-live-prices', item.slug);
    if (!live) return;
    // Labelled by YOUR action, not the counterparty's. A "sell" listing is
    // someone selling, which is the side you buy from - stating it the other
    // way round reads as though selling is what earns you the higher number.
    host.appendChild(snapCard('sell', 'If you BUY, you pay', 'players selling', live.sell, 'min'));
    host.appendChild(snapCard('buy', 'If you SELL, you get', 'players buying', live.buy, 'max'));
    host.appendChild(spreadCard(live));
}

function snapCard(side, label, who, s, bestSide) {
    const card = document.createElement('div');
    card.className = 'ph-snap ' + side + (s && s.avg != null ? '' : ' empty');
    if (!s || s.avg == null) {
        card.innerHTML = `<div class="snap-label">${label}</div>` +
            `<div class="snap-value">${s && s.count ? 'no coin offers' : 'nobody ' + (side === 'sell' ? 'selling' : 'buying')}</div>` +
            `<div class="snap-range">${s && s.barter ? `${s.barter} item-only offer${s.barter > 1 ? 's' : ''}` : ''}</div>`;
        return card;
    }
    const counted = s.count - s.barter - (s.suspect || 0);
    const best = bestSide === 'max' ? s.max : s.min;
    const extras = [];
    if (s.valued) extras.push(`${s.valued} valued from items`);
    if (s.barter) extras.push(`${s.barter} in items, unvalued`);
    if (s.fromNotes) extras.push(`${s.fromNotes} read from notes`);
    if (s.suspect) extras.push(`${s.suspect} placeholder ignored`);
    // The best standing offer leads: that is the price you would actually
    // trade at. The average is the fair-value figure and sits underneath.
    card.innerHTML =
        `<div class="snap-label">${label}</div>` +
        `<div class="snap-value">${formatGp(best)} gp</div>` +
        `<div class="snap-range">avg <b>${formatGp(s.avg)}</b> · range <b>${formatGp(s.min)}</b>–` +
        `<b>${formatGp(s.max)}</b> · ${counted} ${who}` +
        `${extras.length ? ` (${extras.join(', ')})` : ''}</div>`;
    card.title = `best ${best.toLocaleString()} gp - ` +
                 `${bestSide === 'max' ? 'the most anyone is paying' : 'the cheapest on offer'}\n` +
                 `average ${s.avg.toLocaleString()} gp · median ${s.median.toLocaleString()} gp\n` +
                 `lowest ${s.min.toLocaleString()} gp · highest ${s.max.toLocaleString()} gp\n` +
                 `across ${counted} standing offer${counted > 1 ? 's' : ''} from ${who}` +
                 (s.valued ? `\n${s.valued} paid in items, valued at today's prices` : '');
    return card;
}

// The gap between the two, which is the number that actually decides whether
// flipping is worth it.
function spreadCard(live) {
    const card = document.createElement('div');
    card.className = 'ph-snap spread';
    // Best against best, matching the two cards beside it - the gap you would
    // actually face, not the gap between two averages.
    const buyAt = live.sell && live.sell.min;      // cheapest you can buy at
    const sellAt = live.buy && live.buy.max;       // most you can sell for
    if (buyAt == null || sellAt == null) {
        card.classList.add('empty');
        card.innerHTML = '<div class="snap-label">Spread</div><div class="snap-value">one side is empty</div>';
        return card;
    }
    const diff = buyAt - sellAt;
    const pct = Math.round((Math.abs(diff) / buyAt) * 100);
    if (diff >= 0) {
        card.innerHTML =
            `<div class="snap-label">Spread - cost of a round trip</div>` +
            `<div class="snap-value">${formatGp(diff)} gp</div>` +
            `<div class="snap-range">buying costs <b>${pct}%</b> more than selling returns</div>`;
    } else {
        // Player listings are not auto-matched, so bids above asks do happen.
        card.classList.add('flip');
        card.innerHTML =
            `<div class="snap-label">Spread - buyers are paying over the asking price</div>` +
            `<div class="snap-value">+${formatGp(-diff)} gp</div>` +
            `<div class="snap-range">someone is paying more than the cheapest seller wants</div>`;
    }
    return card;
}

// Does the selected range reach further back than what we hold? If so we have
// to go and fetch it - otherwise "3 months" just shows the same week.
function needsMoreHistory() {
    if (!rangeDays || loadedComplete || !loadedOldest) return false;
    return loadedOldest > Date.now() - rangeDays * 86400000;
}

// Second pass: value the item half of every offer that has one, then redraw
// with those points moved from their coin floor up to an estimated worth.
async function estimateOffers() {
    const needing = allTrades.filter(t => (t.kind === 'mixed' || t.kind === 'items') &&
                                          t.parts && t.parts.length && !t.estimate);
    if (!needing.length) return;

    const busy = document.createElement('span');
    busy.textContent = ' · valuing item offers…';
    $('subtitle').appendChild(busy);

    const estimates = await ipcRenderer.invoke('market-value-offers', needing.map(t => ({
        id: t.id, soldAt: t.soldAt, coins: t.coins, parts: t.parts, perEach: t.perEach, lotQty: t.lotQty
    })));

    // Store every result, even the ones that could not be priced - the popup
    // still shows which items were valued and which were not. Only estimates
    // with a unit get plotted.
    let stored = 0;
    allTrades.forEach(t => {
        const e = estimates[t.id];
        if (e) { t.estimate = e; stored++; }
    });
    busy.remove();
    if (stored) draw();
}

// ── Draw ────────────────────────────────────────────────────────────────────
function draw() {
    const trades = visibleTrades();
    const priced = trades.filter(t => plotValue(t) != null);
    const unpriced = trades.filter(t => plotValue(t) == null);

    const counts = { coins: 0, mixed: 0, items: 0 };
    trades.forEach(t => { counts[t.kind] = (counts[t.kind] || 0) + 1; });
    const bits = [];
    if (counts.coins) bits.push(`${counts.coins} coin`);
    if (counts.mixed) bits.push(`${counts.mixed} coins+items`);
    if (counts.items) bits.push(`${counts.items} item swap`);
    const scope = zoom ? ' in view'
        : rangeDays ? ` in the last ${rangeDays === 7 ? 'week' : rangeDays === 30 ? 'month' : '3 months'}` : '';
    $('subtitle').textContent = trades.length
        ? `${bits.join(' · ')}${scope}${totalOnRecord > allTrades.length ? ` - fetched ${allTrades.length} of ${totalOnRecord}` : ''}`
        : `No trades match these filters${scope}`;

    $('chart').innerHTML = '';
    $('legend').innerHTML = '';
    $('trades').innerHTML = '';
    document.querySelectorAll('.ph-warn').forEach(el => el.remove());
    hideTip();

    if (!trades.length) {
        $('chart').innerHTML = '<div class="ph-empty">Nothing matches the current filters.<br>' +
            'Try widening the range, or turning a payment type back on.</div>';
        return;
    }
    if (!priced.length) {
        $('chart').innerHTML = `<div class="ph-empty">These ${trades.length} trade${trades.length > 1 ? 's' : ''} ` +
            'could not be valued in gp.<br>They are listed below.</div>';
    } else {
        $('chart').appendChild(buildChart(priced));
        buildLegend(priced, unpriced);
    }
    buildTable(trades);
    buildWarnings(priced, trades);
}

function buildChart(priced) {
    const values = priced.map(plotValue);
    let min = Math.min(...values), max = Math.max(...values);
    if (min === max) { min = Math.max(0, min * 0.9); max = max * 1.1 || 1; }
    const pad = (max - min) * 0.12;
    min = Math.max(0, min - pad); max = max + pad;

    // Fit the axis to the data actually in view, so a week's worth of trades
    // fills the width instead of huddling against "now" at the right edge.
    // Zoom is the one case that pins the window explicitly.
    let tMin, tMax;
    if (zoom) {
        tMin = zoom.t0; tMax = zoom.t1;
    } else {
        const times = priced.map(timeOf);
        tMin = Math.min(...times); tMax = Math.max(...times);
        if (tMin === tMax) { tMin -= 43200000; tMax += 43200000; }
        const breathe = (tMax - tMin) * 0.03;
        tMin -= breathe; tMax += breathe;
    }

    const x = (ms) => M.left + ((ms - tMin) / (tMax - tMin)) * PLOT_W;
    const y = (p) => M.top + PLOT_H - ((p - min) / (max - min)) * PLOT_H;

    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet' });

    const defs = svgEl('defs');
    defs.innerHTML =
        `<linearGradient id="lineGrad" x1="0" y1="0" x2="0" y2="1">
           <stop offset="0%" stop-color="#f0c65a"/><stop offset="100%" stop-color="#b8860b"/>
         </linearGradient>
         <linearGradient id="areaSell" x1="0" y1="0" x2="0" y2="1">
           <stop offset="0%" stop-color="#5fd97a" stop-opacity="0.22"/>
           <stop offset="100%" stop-color="#5fd97a" stop-opacity="0"/>
         </linearGradient>
         <linearGradient id="areaBuy" x1="0" y1="0" x2="0" y2="1">
           <stop offset="0%" stop-color="#74a0ff" stop-opacity="0.18"/>
           <stop offset="100%" stop-color="#74a0ff" stop-opacity="0"/>
         </linearGradient>`;
    svg.appendChild(defs);

    // Price gridlines
    for (let i = 0; i <= 4; i++) {
        const p = min + ((max - min) * i) / 4;
        const yy = y(p);
        svg.appendChild(svgEl('line', { class: 'grid-line', x1: M.left, y1: yy, x2: W - M.right, y2: yy }));
        const label = svgEl('text', { class: 'axis-label y', x: M.left - 12, y: yy + 4 });
        label.textContent = formatGp(Math.round(p));
        svg.appendChild(label);
    }

    // Time gridlines, spaced by how much time is on screen
    const spanDays = (tMax - tMin) / 86400000;
    const divisions = spanDays > 120 ? 6 : spanDays > 20 ? 5 : 4;
    for (let i = 0; i <= divisions; i++) {
        const ms = tMin + ((tMax - tMin) * i) / divisions;
        const xx = x(ms);
        svg.appendChild(svgEl('line', { class: 'grid-line v', x1: xx, y1: M.top, x2: xx, y2: M.top + PLOT_H }));
        const label = svgEl('text', { class: 'axis-label x', x: xx, y: H - 12 });
        label.textContent = shortDate(ms);
        svg.appendChild(label);
    }
    svg.appendChild(svgEl('line', { class: 'axis-base', x1: M.left, y1: M.top + PLOT_H, x2: W - M.right, y2: M.top + PLOT_H }));
    svg.appendChild(svgEl('line', { class: 'axis-base', x1: M.left, y1: M.top, x2: M.left, y2: M.top + PLOT_H }));

    // One line per side, so a sell trend and a buy trend can be read apart.
    ['sell', 'buy'].forEach(side => {
        if (!series[side]) return;
        const pts = priced.filter(t => t.type === side).sort((a, b) => timeOf(a) - timeOf(b));
        if (pts.length < 2) return;
        const coords = pts.map(t => [x(timeOf(t)), y(plotValue(t))]);
        svg.appendChild(svgEl('path', {
            class: 'price-area', fill: `url(#area${side === 'sell' ? 'Sell' : 'Buy'})`,
            d: `M ${coords[0][0]} ${M.top + PLOT_H} L ` + coords.map(c => c.join(' ')).join(' L ') +
               ` L ${coords[coords.length - 1][0]} ${M.top + PLOT_H} Z`
        }));
        svg.appendChild(svgEl('polyline', {
            class: 'price-line',
            points: coords.map(c => c.join(',')).join(' '),
            stroke: side === 'sell' ? '#5fd97a' : '#74a0ff'
        }));
    });

    plotted = priced.map(t => ({
        t,
        x: x(timeOf(t)),
        y: y(plotValue(t)),
        estimated: !!(t.estimate && t.estimate.unit != null)
    }));
    // Floor links first, so they sit under the dots: for an estimated point
    // this shows where the coins alone would have put it.
    plotted.forEach(p => {
        if (p.estimated && p.t.price != null && p.t.price !== p.t.estimate.unit) {
            svg.appendChild(svgEl('line', { class: 'est-link', x1: p.x, y1: y(p.t.price), x2: p.x, y2: p.y }));
        }
    });
    plotted.forEach(p => {
        const cls = p.estimated ? 'estimated' : p.t.kind === 'mixed' ? 'mixed' : p.t.type;
        p.node = svgEl('circle', { cx: p.x, cy: p.y, r: 4, class: 'pt ' + cls });
        svg.appendChild(p.node);
    });

    // One hover layer for the whole plot: finds the nearest point rather than
    // relying on hitting a dot, so points sitting on top of each other are all
    // reachable - they are reported together.
    const overlay = svgEl('rect', {
        x: M.left, y: M.top, width: PLOT_W, height: PLOT_H, fill: 'transparent', class: 'hover-layer'
    });
    svg.appendChild(overlay);
    svg.addEventListener('mousemove', (e) => onHover(e, svg));
    svg.addEventListener('mouseleave', () => { hideTip(); clearActive(svg); });
    svg.addEventListener('wheel', (e) => onWheel(e, svg, tMin, tMax), { passive: false });

    return svg;
}

// ── Hover ───────────────────────────────────────────────────────────────────
function toViewBox(e, svg) {
    const r = svg.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (W / r.width), y: (e.clientY - r.top) * (H / r.height) };
}

function clearActive(svg) {
    svg.querySelectorAll('.pt.active').forEach(n => { n.classList.remove('active'); n.setAttribute('r', 4); });
    const c = svg.querySelector('.crosshair');
    if (c) c.remove();
}

function onHover(e, svg) {
    if (!plotted.length) return;
    const pos = toViewBox(e, svg);
    let best = null, bestD = Infinity;
    plotted.forEach(p => {
        const d = Math.hypot(p.x - pos.x, p.y - pos.y);
        if (d < bestD) { bestD = d; best = p; }
    });
    if (!best || bestD > 60) { hideTip(); clearActive(svg); return; }

    // Everything sitting essentially on top of the nearest point comes too, so
    // overlapping trades are all readable instead of one hiding the others.
    const group = plotted.filter(p => Math.hypot(p.x - best.x, p.y - best.y) <= 7);
    clearActive(svg);
    svg.insertBefore(svgEl('line', {
        class: 'crosshair', x1: best.x, y1: M.top, x2: best.x, y2: M.top + PLOT_H
    }), svg.querySelector('.pt'));
    group.forEach(p => { p.node.classList.add('active'); p.node.setAttribute('r', 6); });
    showTip(e, group.map(p => p.t));
}

function showTip(e, trades) {
    const tip = $('tip');
    const blocks = trades.slice(0, 3).map(t => tipBlock(t));
    if (trades.length > 3) blocks.push(`<div class="tip-more">+ ${trades.length - 3} more at this point</div>`);
    tip.innerHTML = blocks.join('<div class="tip-sep"></div>');
    tip.classList.add('show');

    const r = tip.getBoundingClientRect();
    tip.style.left = Math.max(8, Math.min(e.clientX + 16, window.innerWidth - r.width - 8)) + 'px';
    tip.style.top = Math.max(8, Math.min(e.clientY + 16, window.innerHeight - r.height - 8)) + 'px';
}

function tipBlock(t) {
    const est = t.estimate;
    const rows = [];
    const outOfScale = estimateOutOfScale(t);
    const headline = t.suspect ? 'price not believed'
        : outOfScale ? '≈ ' + formatGp(est.unit) + ' gp - off the scale'
        : est && est.unit != null ? '≈ ' + formatGp(est.unit) + ' gp'
        : t.price != null ? (t.kind === 'mixed' ? '≥ ' : t.priceFromNotes ? '≈ ' : '') + formatGp(t.price) + ' gp'
        : 'no gp value';
    rows.push(`<div class="tip-head">${headline} <span style="color:${t.type === 'sell' ? '#5fd97a' : '#74a0ff'}">${t.type}</span></div>`);
    rows.push(`<div class="tip-meta">${fullDate(t.soldAt)} · ×${t.quantity.toLocaleString()} · ${escapeHtml(t.username)}</div>`);

    // A token coin amount with the real number in the notes - say so plainly,
    // and show what was actually written down either way.
    if (t.suspect) {
        rows.push(`<div class="tip-note">Listed at ${t.listedPrice != null ? t.listedPrice.toLocaleString() : '-'} gp, ` +
                  `nowhere near what this item goes for, and the notes don't give a real figure. ` +
                  `Left off the chart rather than believed.` +
                  (t.notes ? `<br><i>"${escapeHtml(t.notes)}"</i>` : ''));
    } else if (t.priceFromNotes) {
        rows.push(`<div class="tip-note">Listed at ${t.listedPrice != null ? t.listedPrice.toLocaleString() : '-'} gp - ` +
                  `a placeholder. Read as ${t.price.toLocaleString()} gp from the notes:` +
                  (t.notes ? `<br><i>"${escapeHtml(t.notes)}"</i>` : ''));
    }

    // On a pure coin trade the coin figure IS the disputed number, and the note
    // above has already given it - repeating it as a line item would read as
    // though it still counted toward something.
    const coinsDisputed = (t.suspect || t.priceFromNotes) && !(t.parts && t.parts.length);
    if (t.coins && !coinsDisputed) rows.push(`<div class="tip-row"><span class="qty">coins</span><span class="val">${t.coins.toLocaleString()} gp</span></div>`);
    (t.parts || []).forEach((p, i) => {
        const v = est && est.parts && est.parts[i];
        const worth = v && v.unit != null ? `≈ ${formatGp(v.unit * p.quantity)} gp<span class="src">${v.source}</span>` : 'not valued';
        rows.push(`<div class="tip-row"><span class="qty">${p.quantity.toLocaleString()} × ${escapeHtml(p.name)}</span><span class="val">${worth}</span></div>`);
    });
    if (outOfScale) {
        rows.push(`<div class="tip-total"><span>estimated worth</span><span>≈ ${est.total.toLocaleString()} gp</span></div>`);
        rows.push(`<div class="tip-note">That is ${Math.round(est.unit / plotReference).toLocaleString()}× what ` +
                  `${escapeHtml(item.name)} normally goes for (about ${formatGp(plotReference)} gp), so it is almost ` +
                  `certainly a slip - asking for an item where coins were meant. Left off the chart so it cannot ` +
                  `flatten every real price on it.`);
    } else if (est && est.unit != null) {
        rows.push(`<div class="tip-total"><span>estimated worth</span><span>≈ ${est.total.toLocaleString()} gp</span></div>`);
    } else if (est && est.missing) {
        rows.push(`<div class="tip-note">${est.missing} item${est.missing > 1 ? 's have' : ' has'} no price data, ` +
                  `so this trade has no gp value - it is left off the chart rather than guessed at.</div>`);
    }
    return rows.join('');
}

const hideTip = () => $('tip').classList.remove('show');

// Table row ↔ chart point. Trades that were filtered out have no dot, which is
// simply a no-op rather than an error.
function highlightPoint(tradeId, on) {
    const p = plotted.find(pt => pt.t.id === tradeId);
    if (!p || !p.node) return;
    p.node.classList.toggle('glow', on);
    p.node.setAttribute('r', on ? 7 : 4);
}

// ── Zoom ────────────────────────────────────────────────────────────────────
function onWheel(e, svg, tMin, tMax) {
    e.preventDefault();
    const pos = toViewBox(e, svg);
    const frac = Math.min(1, Math.max(0, (pos.x - M.left) / PLOT_W));
    const anchor = tMin + (tMax - tMin) * frac;
    const factor = e.deltaY < 0 ? 0.75 : 1 / 0.75;      // in on scroll up
    const span = (tMax - tMin) * factor;
    const MIN_SPAN = 3600000;                            // never tighter than an hour
    if (span < MIN_SPAN) return;

    let t0 = anchor - (anchor - tMin) * factor;
    let t1 = t0 + span;
    // Zooming back out past the loaded history just clears the zoom.
    const fullSpan = rangeDays ? rangeDays * 86400000
        : (allTrades.length ? timeOf(allTrades[allTrades.length - 1]) - timeOf(allTrades[0]) : span);
    if (span >= fullSpan) { zoom = null; } else { zoom = { t0, t1 }; }
    draw();
}

// ── Legend, warnings, table ─────────────────────────────────────────────────
function buildLegend(priced, unpriced) {
    const keys = [];
    if (series.sell && priced.some(t => t.type === 'sell' && !t.estimate)) keys.push(['sell', 'sold by a seller']);
    if (series.buy && priced.some(t => t.type === 'buy' && !t.estimate)) keys.push(['buy', 'filled a buy offer']);
    let html = keys.map(([c, txt]) => `<span class="ph-key"><span class="ph-swatch ${c}"></span>${txt}</span>`).join('');
    if (priced.some(t => t.estimate && t.estimate.unit != null)) {
        html += `<span class="ph-key"><span class="ph-swatch estimated"></span>` +
                `items valued into gp - hover for the breakdown</span>`;
    }
    if (priced.some(t => t.kind === 'mixed' && !(t.estimate && t.estimate.unit != null))) {
        html += `<span class="ph-key"><span class="ph-swatch mixed"></span>coin part only, items not valued</span>`;
    }
    const suspects = unpriced.filter(t => t.suspect).length;
    const offScale = unpriced.filter(estimateOutOfScale).length;
    const plain = unpriced.length - suspects - offScale;
    if (plain) html += `<span class="ph-key">${plain} could not be valued, listed below</span>`;
    if (suspects) html += `<span class="ph-key"><span class="ph-swatch suspect"></span>` +
        `${suspects} placeholder price${suspects > 1 ? 's' : ''} ignored</span>`;
    if (offScale) html += `<span class="ph-key"><span class="ph-swatch suspect"></span>` +
        `${offScale} off the scale - hover to see why</span>`;
    if (priced.some(t => t.priceFromNotes)) html += `<span class="ph-key"><span class="ph-swatch estimated"></span>` +
        `${priced.filter(t => t.priceFromNotes).length} read from the seller's notes</span>`;
    $('legend').innerHTML = html;
}

function buildWarnings(priced, trades) {
    if (needsMoreHistory()) {
        const w = document.createElement('div');
        w.className = 'ph-warn';
        w.textContent = `Only history back to ${shortDate(loadedOldest)} has been fetched - press Refresh to pull the full range.`;
        $('legend').insertAdjacentElement('afterend', w);
        return;
    }
    if (!priced.length) return;
    const last = priced[priced.length - 1];
    const ageDays = (Date.now() - timeOf(last)) / 86400000;
    if (ageDays > 14 || priced.length < 3) {
        const w = document.createElement('div');
        w.className = 'ph-warn';
        w.textContent = ageDays > 14
            ? `Thin history - the most recent match was ${timeAgo(last.soldAt)}. Treat these figures as a rough guide.`
            : `Only ${priced.length} priced trade${priced.length > 1 ? 's' : ''} in view - not enough to call a trend.`;
        $('legend').insertAdjacentElement('afterend', w);
    }
}

function buildTable(trades) {
    const host = $('trades');
    const head = document.createElement('div');
    head.className = 'ph-tr head';
    ['Date', 'Side', 'Price each', 'Quantity', 'Player', 'Paid with'].forEach(h => {
        const c = document.createElement('span');
        c.textContent = h;
        head.appendChild(c);
    });
    host.appendChild(head);

    // Newest first - a list is read from the top and the latest trade is the
    // one people want.
    [...trades].reverse().forEach(t => {
        const row = document.createElement('div');
        row.className = 'ph-tr';
        // Hovering a row lights up the matching dot, so a line in the list can
        // be located on the chart without hunting for it - and shows the same
        // itemised breakdown, since the "Paid with" column has to truncate.
        row.addEventListener('mouseenter', (e) => { highlightPoint(t.id, true); showTip(e, [t]); });
        row.addEventListener('mousemove', (e) => showTip(e, [t]));
        row.addEventListener('mouseleave', () => { highlightPoint(t.id, false); hideTip(); });

        // No title="" anywhere on this row: the row already opens the rich tip
        // on hover, and the OS tooltip would appear a second later right on top
        // of it, hiding the breakdown it duplicates.
        const when = document.createElement('span');
        when.className = 'when';
        when.textContent = shortDate(t.soldAt);

        const side = document.createElement('span');
        side.className = 'side ' + t.type;
        side.textContent = t.type;

        const price = document.createElement('span');
        if (t.suspect) {
            price.className = 'price suspect';
            price.textContent = 'placeholder';
        } else if (estimateOutOfScale(t)) {
            // Show what it valued at - seeing "≈ 8.4m" against a 2.9k item is
            // what makes the mistake obvious.
            price.className = 'price suspect';
            price.textContent = '≈ ' + formatGp(t.estimate.unit);
        } else if (t.estimate && t.estimate.unit != null) {
            price.className = 'price approx';
            price.textContent = '≈ ' + formatGp(t.estimate.unit);
        } else if (t.price == null) {
            price.className = 'price none';
            price.textContent = 'items only';
        } else if (t.kind === 'mixed') {
            price.className = 'price approx';
            price.textContent = '≥ ' + t.price.toLocaleString();
        } else if (t.priceFromNotes) {
            price.className = 'price approx';
            price.textContent = '≈ ' + t.price.toLocaleString();
        } else {
            price.className = 'price';
            price.textContent = t.price.toLocaleString();
        }

        const qty = document.createElement('span');
        qty.className = 'qty';
        qty.textContent = '×' + t.quantity.toLocaleString();

        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = t.username;

        const offer = document.createElement('span');
        offer.className = 'offer';
        offer.textContent = t.offer;

        row.append(when, side, price, qty, who, offer);
        host.appendChild(row);
    });
}

// ── Search: check any item without watching it ──────────────────────────────
$('search').addEventListener('input', (e) => {
    const q = e.target.value.trim();
    clearTimeout(searchTimer);
    if (q.length < 2) { $('search-results').classList.remove('open'); return; }
    searchTimer = setTimeout(async () => {
        const items = await ipcRenderer.invoke('market-search-items', q);
        const box = $('search-results');
        box.innerHTML = '';
        if (!items.length) {
            box.innerHTML = '<div class="ph-result">No items found</div>';
        } else {
            items.forEach(it => {
                const row = document.createElement('div');
                row.className = 'ph-result';
                const img = document.createElement('img');
                img.src = `https://markets.lostcity.rs/img/items/${encodeURIComponent(it.slug)}.webp`;
                img.onerror = () => { img.style.visibility = 'hidden'; };
                const name = document.createElement('span');
                name.textContent = it.name;
                row.append(img, name);
                row.onclick = () => {
                    item = { slug: it.slug, name: it.name };
                    $('search').value = '';
                    box.classList.remove('open');
                    load();
                };
                box.appendChild(row);
            });
        }
        box.classList.add('open');
    }, 250);
});
$('search').addEventListener('blur', () => setTimeout(() => $('search-results').classList.remove('open'), 150));

// ── Toolbar ─────────────────────────────────────────────────────────────────
$('ranges').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    rangeDays = Number(btn.dataset.days) || 0;
    [...$('ranges').children].forEach(b => b.classList.toggle('active', b === btn));
    zoom = null;
    // A longer range may need history we have not pulled yet.
    if (needsMoreHistory()) load(); else draw();
});

// Series are toggles, not a choice - both on is the normal state.
$('series').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const key = btn.dataset.series;
    if (series[key] && !series[key === 'sell' ? 'buy' : 'sell']) return;  // never hide both
    series[key] = !series[key];
    btn.classList.toggle('active', series[key]);
    draw();
});

$('payment').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    payment = btn.dataset.pay;
    [...$('payment').children].forEach(b => b.classList.toggle('active', b === btn));
    draw();
});

$('reset-zoom').onclick = () => { zoom = null; draw(); };
$('refresh').onclick = () => load(true);
$('open-market').onclick = () => { if (item.slug) ipcRenderer.send('open-market-item', item.slug); };

ipcRenderer.on('price-history-item', (event, next) => {
    if (!next || !next.slug) return;
    item = next;
    load();
});

if (item.slug) load();
else $('search').focus();
