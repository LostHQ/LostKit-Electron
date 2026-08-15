const { ipcRenderer } = require('electron');

// Direction is written from the user's point of view — "I'm buying" watches
// other people's sell listings, and vice versa. The main process owns the same
// rule; this file only has to phrase it.
let picked = null;            // { id, name, slug, cost }
let direction = 'buy';

// The same page is used in the nav column and as a standalone window; the
// window has nothing to go "back" to and cannot pop itself out again.
const isWindow = new URLSearchParams(location.search).get('window') === '1';

const $ = (id) => document.getElementById(id);

const spriteUrl = (slug) => `https://markets.lostcity.rs/img/items/${encodeURIComponent(slug)}.webp`;

function formatGp(n) {
    if (n == null) return '—';
    if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1).replace(/\.0$/, '') + 'm';
    if (n >= 100000) return Math.round(n / 1000) + 'k';
    return n.toLocaleString();
}

// Accepts what people actually type: 1200k, 12m, 1.5m, 2b, 1,200,000.
function parseGp(text) {
    if (text == null) return null;
    const s = String(text).trim().toLowerCase().replace(/[,\s]/g, '');
    if (!s) return null;
    const m = s.match(/^(\d+(?:\.\d+)?)([kmb])?$/);
    if (!m) return null;
    const mult = m[2] === 'b' ? 1e9 : m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1e3 : 1;
    const value = Math.round(parseFloat(m[1]) * mult);
    return Number.isFinite(value) && value >= 0 ? value : null;
}

function timeAgo(iso) {
    if (!iso) return '';
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
}

// ── Item search ─────────────────────────────────────────────────────────────
// Two boxes use this: the quick-check slot at the top and the watch form below.
// Same endpoint and same result rows — only where the pick lands differs.
function wireSearch(inputId, boxId, onPick) {
    const input = $(inputId);
    const box = $(boxId);
    let timer = null;
    let latest = 0;

    const close = () => box.classList.remove('open');

    async function run(q) {
        // Typing fast fires several lookups; a slow earlier one must not land
        // on top of the answer to what was actually typed last.
        const mine = ++latest;
        const items = await ipcRenderer.invoke('market-search-items', q);
        if (mine !== latest) return;
        box.innerHTML = '';
        if (!items.length) {
            const row = document.createElement('div');
            row.className = 'wl-result';
            row.innerHTML = '<span class="wl-empty">No items found</span>';
            box.appendChild(row);
        } else {
            items.forEach(item => {
                const row = document.createElement('div');
                row.className = 'wl-result';
                const sprite = document.createElement('img');
                sprite.className = 'wl-sprite small';
                sprite.src = spriteUrl(item.slug);
                sprite.draggable = false;
                sprite.onerror = () => { sprite.style.visibility = 'hidden'; };
                const name = document.createElement('span');
                name.className = 'wl-label';
                name.textContent = item.name;
                // The API also hands back `cost` — the item config's shop value,
                // which high alch pays 60% of. It is deliberately not shown: in
                // a panel about prices, any number on the row reads as a price,
                // and it is not one. A santa hat's value is 160; it trades for
                // 300m. Picking the item gives the real answer anyway.
                row.append(sprite, name);
                row.onclick = () => { input.value = ''; close(); onPick(item); };
                box.appendChild(row);
            });
        }
        box.classList.add('open');
    }

    input.addEventListener('input', (e) => {
        const q = e.target.value.trim();
        clearTimeout(timer);
        if (q.length < 2) { close(); return; }
        timer = setTimeout(() => run(q), 250);
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
    input.addEventListener('focus', (e) => {
        if (e.target.value.trim().length >= 2) run(e.target.value.trim());
    });
    // Enter takes the top result, so a known item never needs the mouse.
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { close(); return; }
        if (e.key !== 'Enter') return;
        const first = box.querySelector('.wl-result');
        if (first && first.onclick) first.onclick();
    });

    return close;
}

const closeResults = wireSearch('item-search', 'search-results', pickItem);
wireSearch('quick-search', 'quick-results', quickCheck);

// ── Quick check ─────────────────────────────────────────────────────────────
// One slot, one item, answered in a couple of seconds: what does it cost and
// what will it fetch. No watch to create, nothing saved — the common case is
// "someone just offered me this, is that fair?", which a watch is far too much
// machinery for.
let quickItem = null;
let quickToken = 0;

async function quickCheck(item) {
    quickItem = item;
    const token = ++quickToken;

    $('quick-card').classList.add('open');
    $('quick-name').textContent = item.name;
    const sprite = $('quick-sprite');
    sprite.src = spriteUrl(item.slug);
    sprite.style.visibility = 'visible';
    sprite.onerror = () => { sprite.style.visibility = 'hidden'; };
    $('quick-body').innerHTML = '<div class="wl-qwait">Checking Markets…</div>';

    const live = await ipcRenderer.invoke('market-live-prices', item.slug);
    if (token !== quickToken) return;      // a newer check has taken over

    const body = $('quick-body');
    body.innerHTML = '';
    if (!live) {
        body.innerHTML = '<div class="wl-err">Could not reach Markets.</div>';
        return;
    }
    // Labelled by what YOU would do. Someone else's sell listing is the side
    // you buy from, so it is the price you pay.
    // Phrased as a condition and an action — "if you buy … pay 279.8m" — rather
    // than leaving the reader to work out whose side of the trade a number is
    // on. Same wording as the price history window, so the two agree.
    body.append(
        quickSide('pay', 'If you buy', 'pay', live.sell, 'selling', 'min'),
        quickSide('get', 'If you sell', 'get', live.buy, 'buying', 'max'),
        quickSpread(live)
    );
}

// Which side's offer list is open. Kept between lookups: someone who wants the
// detail usually wants it for the next item too, and reopening it every time
// would be its own annoyance.
const quickOpen = { pay: false, get: false };

// A side of the book: the summary line, and the offers behind it folded away
// underneath. Everything is here, but only the answer is on screen — the panel
// shares a 250px column with the watch list and cannot spend 300px on a lookup.
function quickSide(cls, label, verb, s, who, bestSide) {
    const frag = document.createDocumentFragment();
    const row = document.createElement('div');
    row.className = 'wl-qrow ' + cls;

    const name = document.createElement('span');
    name.className = 'wl-qlabel';
    name.textContent = label;
    const val = document.createElement('span');
    val.className = 'wl-qval';
    const sub = document.createElement('span');
    sub.className = 'wl-qsub';

    if (!s || s.avg == null) {
        val.textContent = '—';
        val.classList.add('none');
        // "Nobody is offering", "offers, but none in coins" and "the only offer
        // was a placeholder" are three different answers, and only the first
        // means the item has no market at all.
        const bits = [];
        if (s && s.barter) bits.push(`${s.barter} item-only offer${s.barter > 1 ? 's' : ''}`);
        if (s && s.suspect) bits.push(`${s.suspect} placeholder price${s.suspect > 1 ? 's' : ''} ignored`);
        sub.textContent = bits.length ? bits.join(' · ') : `nobody ${who}`;
        // Empty fold cell so the value still lands in the same column as the
        // rows that do have one.
        row.append(name, document.createElement('span'), val, sub);
        frag.appendChild(row);
        return frag;
    }

    const counted = s.count - s.barter - (s.suspect || 0);
    // The headline is the best standing offer, not the average. "If you buy,
    // you pay 345" is untrue when someone is selling at 330 — you would pay
    // 330. The average is the fair-value answer and stays one line down.
    const best = bestSide === 'max' ? s.max : s.min;
    // The verb rides on the number, where it cannot be missed and costs no
    // extra line: "If you buy → pay 330 gp".
    const action = document.createElement('span');
    action.className = 'wl-qverb';
    action.textContent = verb + ' ';
    val.append(action, document.createTextNode(formatGp(best) + ' gp'));

    // The headline covers the best end of the range, so the line underneath
    // carries what it does not: the typical price, and the far end.
    const far = document.createElement('b');
    far.textContent = formatGp(bestSide === 'max' ? s.min : s.max);
    sub.append(document.createTextNode('avg '), document.createTextNode(formatGp(s.avg)),
               document.createTextNode(bestSide === 'max' ? ' · down to ' : ' · up to '), far,
               document.createTextNode(` · ${counted} ${who}`));

    // Caveats stay out of the summary line and go on the fold, where they
    // belong to the offers they describe.
    const caveats = [];
    if (s.valued) caveats.push(`${s.valued} paid in items, valued at today's prices`);
    if (s.barter) caveats.push(`${s.barter} in items, could not be valued`);
    if (s.fromNotes) caveats.push(`${s.fromNotes} read from the seller's notes`);
    if (s.suspect) caveats.push(`${s.suspect} placeholder ignored`);

    row.title = `${label} right now, you ${verb} ${best.toLocaleString()} gp each — ` +
                `${bestSide === 'max' ? 'the most anyone is paying' : 'the cheapest on offer'}.\n` +
                `That is one player's offer, so it goes when they trade or pull it.\n\n` +
                `average ${s.avg.toLocaleString()} gp · median ${s.median.toLocaleString()} gp\n` +
                `lowest ${s.min.toLocaleString()} gp · highest ${s.max.toLocaleString()} gp\n` +
                `across ${counted} standing offer${counted > 1 ? 's' : ''} right now` +
                (caveats.length ? '\n' + caveats.join('\n') : '');

    const fold = quickOffers(s, bestSide, caveats);
    const chev = document.createElement('span');
    chev.className = 'wl-qchev';
    if (fold.childElementCount) {
        row.classList.add('foldable');
        const set = (open) => {
            quickOpen[cls] = open;
            fold.classList.toggle('open', open);
            chev.textContent = open ? '▾' : '▸';
        };
        row.onclick = () => set(!quickOpen[cls]);
        set(quickOpen[cls]);
    }

    row.append(name, chev, val, sub);
    frag.append(row, fold);
    return frag;
}

// The offers behind the numbers. A coin offer needs no explaining — the price
// is the offer — but an item offer's gp figure is our own estimate, so what is
// actually on the table gets spelled out underneath it.
const QUICK_OFFERS_SHOWN = 4;

function quickOffers(s, bestSide, caveats) {
    const box = document.createElement('div');
    box.className = 'wl-qoffers';
    const all = [...((s && s.offers) || [])]
        .sort((a, b) => bestSide === 'max' ? b.price - a.price : a.price - b.price);
    if (!all.length) return box;

    all.slice(0, QUICK_OFFERS_SHOWN).forEach(o => {
        const row = document.createElement('div');
        row.className = 'wl-qoffer';
        row.onclick = () => { if (quickItem) ipcRenderer.send('open-market-item', quickItem.slug); };
        row.title = `${o.offer}${o.quantity > 1 ? ` for ${o.quantity.toLocaleString()}` : ''}` +
                    (o.notes ? `\n"${o.notes}"` : '') +
                    (o.valued ? '\n\nPaid in items — the gp figure is our valuation at today\'s prices.' : '') +
                    (o.fromNotes ? '\n\nThe coin field was a placeholder; this price came from the notes.' : '');

        const price = document.createElement('span');
        price.className = 'wl-qoprice' + (o.valued || o.fromNotes ? ' approx' : '');
        price.textContent = (o.valued || o.fromNotes ? '≈' : '') + formatGp(o.price);
        const who = document.createElement('span');
        who.className = 'wl-qowho';
        who.textContent = o.username;
        row.append(price, who);
        box.appendChild(row);

        // Only item offers need their contents shown; a coin offer's contents
        // are the price already on the line above.
        if (o.valued) {
            const what = document.createElement('div');
            what.className = 'wl-qowhat';
            what.textContent = o.offer;
            box.appendChild(what);
        }
    });

    const notes = [];
    if (all.length > QUICK_OFFERS_SHOWN) notes.push(`+${all.length - QUICK_OFFERS_SHOWN} more`);
    notes.push(...(caveats || []));
    if (notes.length) {
        const more = document.createElement('div');
        more.className = 'wl-qomore';
        more.textContent = notes.join(' · ');
        box.appendChild(more);
    }
    return box;
}

function quickSpread(live) {
    const row = document.createElement('div');
    row.className = 'wl-qrow spread';
    // Best against best, matching the two rows above. Averaged against averaged
    // it claimed flax cost 12% to round-trip when the real gap between the
    // cheapest seller and the best buyer was 5gp — a difference that decides
    // whether a flip is worth doing at all.
    const buyAt = live.sell && live.sell.min;      // cheapest you can buy at
    const sellAt = live.buy && live.buy.max;       // most you can sell for
    const name = document.createElement('span');
    name.className = 'wl-qlabel';
    name.textContent = 'Spread';
    const val = document.createElement('span');
    val.className = 'wl-qval';
    const sub = document.createElement('span');
    sub.className = 'wl-qsub';

    if (buyAt == null || sellAt == null) {
        val.textContent = '—';
        val.classList.add('none');
        sub.textContent = 'only one side has coin offers';
    } else if (buyAt >= sellAt) {
        val.textContent = formatGp(buyAt - sellAt) + ' gp';
        sub.textContent = `${Math.round(((buyAt - sellAt) / buyAt) * 100)}% round trip`;
    } else {
        // Listings are not auto-matched here, so bids above asks do happen.
        row.classList.add('flip');
        val.textContent = '+' + formatGp(sellAt - buyAt) + ' gp';
        sub.textContent = 'buyers are paying over the asking price';
    }
    // Empty fold cell: this row has nothing to unfold, but its value still has
    // to line up with the two above it.
    row.append(name, document.createElement('span'), val, sub);
    return row;
}

$('quick-graph').onclick = () => {
    if (quickItem) ipcRenderer.send('open-price-history-window', { slug: quickItem.slug, name: quickItem.name });
};
$('quick-again').onclick = () => { if (quickItem) quickCheck(quickItem); };
$('quick-clear').onclick = () => {
    quickItem = null;
    quickToken++;                          // abandon any check still in flight
    $('quick-card').classList.remove('open');
    $('quick-search').value = '';
    $('quick-search').focus();
};
// The bridge to the panel below: liked the price, now watch for it.
$('quick-watch').onclick = () => { if (quickItem) pickItem(quickItem); };

function pickItem(item) {
    picked = item;
    $('picked-name').textContent = item.name;
    const sprite = $('picked-sprite');
    sprite.src = spriteUrl(item.slug);
    sprite.style.visibility = 'visible';
    sprite.onerror = () => { sprite.style.visibility = 'hidden'; };
    $('add-form').classList.add('open');
    $('item-search').value = '';
    closeResults();
    updateHint();
    $('price-max').focus();
}

$('picked-clear').onclick = () => {
    picked = null;
    $('add-form').classList.remove('open');
    $('price-min').value = '';
    $('price-max').value = '';
    $('item-search').focus();
};

// ── Direction + range ───────────────────────────────────────────────────────
$('dir-buy').onclick = () => setDirection('buy');
$('dir-sell').onclick = () => setDirection('sell');

function setDirection(d) {
    direction = d;
    $('dir-buy').classList.toggle('active', d === 'buy');
    $('dir-sell').classList.toggle('active', d === 'sell');
    updateHint();
}

$('price-min').addEventListener('input', updateHint);
$('price-max').addEventListener('input', updateHint);
$('deviation').addEventListener('input', updateHint);

function readRange() {
    const dev = parseInt($('deviation').value, 10);
    return {
        min: parseGp($('price-min').value),
        max: parseGp($('price-max').value),
        deviation: Number.isFinite(dev) && dev >= 0 ? dev : 20
    };
}

// Says back, in words, exactly what will trigger an alert. Cheap to write and
// it removes any doubt about which side of the trade is being watched.
function describeRule(dir, min, max) {
    const who = dir === 'buy' ? 'Someone selling' : 'Someone buying';
    if (min != null && max != null) return `${who} between ${formatGp(min)} and ${formatGp(max)} gp`;
    if (max != null) return `${who} at ${formatGp(max)} gp or less`;
    if (min != null) return `${who} at ${formatGp(min)} gp or more`;
    return `${who} at any price`;
}

// The window of prices actually displayed: the range, widened by the deviation.
function describeWindow(dir, min, max, deviation) {
    if (min == null && max == null) return 'Showing every offer';
    const f = 1 + Math.max(0, deviation) / 100;
    if (max != null) return `Showing up to ${formatGp(Math.round(max * f))} gp`;
    return `Showing down to ${formatGp(Math.round(min / f))} gp`;
}

function updateHint() {
    if (!picked) return;
    const { min, max, deviation } = readRange();
    const bad = [];
    if ($('price-min').value.trim() && min == null) bad.push('min');
    if ($('price-max').value.trim() && max == null) bad.push('max');
    if (bad.length) {
        $('range-hint').textContent = `Can't read the ${bad.join(' and ')} price — try 400, 1200k or 12m`;
        $('add-btn').disabled = true;
        return;
    }
    $('range-hint').textContent = `${describeRule(direction, min, max)}. ${describeWindow(direction, min, max, deviation)}.`;
    $('add-btn').disabled = false;
}

$('add-btn').onclick = async () => {
    if (!picked) return;
    const { min, max, deviation } = readRange();
    $('add-btn').disabled = true;
    $('add-btn').textContent = 'Checking…';
    const watches = await ipcRenderer.invoke('add-market-watch', {
        itemId: picked.id, slug: picked.slug, name: picked.name, direction, min, max, deviation
    });
    $('add-btn').textContent = 'Watch this item';
    $('picked-clear').onclick();
    render(watches);
};

// ── Watch list ──────────────────────────────────────────────────────────────
function render(watches) {
    const host = $('watches');
    host.innerHTML = '';

    if (!watches || !watches.length) {
        const empty = document.createElement('div');
        empty.className = 'wl-empty-state';
        empty.textContent = 'Nothing watched yet. Search for an item above, say whether you are buying or selling, and set the price you care about.';
        host.appendChild(empty);
        return;
    }

    watches.forEach(w => {
        const card = document.createElement('div');
        card.className = 'wl-card' + (w.matches && w.matches.length ? ' hit' : '');

        const head = document.createElement('div');
        head.className = 'wl-card-head';
        const sprite = document.createElement('img');
        sprite.className = 'wl-sprite small';
        sprite.src = spriteUrl(w.slug);
        sprite.draggable = false;
        sprite.onerror = () => { sprite.style.visibility = 'hidden'; };
        const name = document.createElement('span');
        name.className = 'wl-name';
        name.textContent = w.name;
        name.title = 'Open ' + w.name + ' on Markets';
        name.onclick = () => ipcRenderer.send('open-market-item', w.slug);
        const graphBtn = document.createElement('span');
        graphBtn.className = 'wl-tool';
        graphBtn.textContent = '📈';
        graphBtn.title = 'Price history from completed trades';
        graphBtn.onclick = () => ipcRenderer.send('open-price-history-window', { slug: w.slug, name: w.name });

        const editBtn = document.createElement('span');
        editBtn.className = 'wl-tool';
        editBtn.textContent = '✎';
        editBtn.title = 'Edit price range';
        editBtn.onclick = () => toggleEdit(card, w);

        const del = document.createElement('span');
        del.className = 'wl-x';
        del.textContent = '×';
        del.title = 'Stop watching';
        del.onclick = async () => render(await ipcRenderer.invoke('remove-market-watch', w.id));
        head.append(sprite, name, graphBtn, editBtn, del);
        card.appendChild(head);

        const rule = document.createElement('div');
        rule.className = 'wl-rule';
        rule.innerHTML = describeRule(w.direction, w.min, w.max).replace(
            /(\d[\d,.]*[mk]?) gp/g, '<b>$1 gp</b>');
        card.appendChild(rule);

        card.appendChild(buildEditForm(w));

        if (w.error) {
            const err = document.createElement('div');
            err.className = 'wl-err';
            err.textContent = 'Could not reach Markets: ' + w.error;
            card.appendChild(err);
        } else if (!w.listings || !w.listings.length) {
            const none = document.createElement('div');
            none.className = 'wl-none';
            // "Nothing close" and "nothing at all" are very different answers.
            if (w.farCount) {
                none.textContent = `${w.farCount} offer${w.farCount > 1 ? 's' : ''}, none near your price — best is ${formatGp(w.best)} gp.`;
            } else if (w.suspectCount) {
                none.textContent = `${w.suspectCount} offer${w.suspectCount > 1 ? 's' : ''} ignored — the price listed is nowhere ` +
                                   `near what this goes for, with no real figure in the notes.`;
            } else {
                none.textContent = w.direction === 'buy' ? 'Nobody is selling this right now.' : 'Nobody is buying this right now.';
            }
            card.appendChild(none);
        } else {
            const rows = document.createElement('div');
            rows.className = 'wl-rows';
            const matchIds = new Set((w.matches || []).map(m => m.id));
            w.listings.slice(0, 5).forEach(l => {
                const row = document.createElement('div');
                row.className = 'wl-row' + (matchIds.has(l.id) ? ' match' : '');
                row.title = `${l.offer} — ${timeAgo(l.updatedAt)}${l.notes ? '\n"' + l.notes + '"' : ''}` +
                    (l.priceFromNotes ? '\n\nThe coin field was a placeholder; this price was read from the notes.' : '');
                row.onclick = () => ipcRenderer.send('open-market-item', w.slug);
                const price = document.createElement('span');
                price.className = 'wl-price' + (l.priceFromNotes ? ' approx' : '');
                // "≈" earns its place here: this number came from prose, not
                // from the coin field, so it should not look equally certain.
                price.textContent = (l.priceFromNotes ? '≈' : '') + formatGp(l.price) + ' gp';
                const qty = document.createElement('span');
                qty.className = 'wl-qty';
                qty.textContent = '×' + l.quantity.toLocaleString();
                const who = document.createElement('span');
                who.className = 'wl-who';
                who.textContent = l.username;
                row.append(price, qty, who);
                rows.appendChild(row);
            });
            card.appendChild(rows);

            const foot = document.createElement('div');
            foot.className = 'wl-foot';
            const left = document.createElement('span');
            left.textContent = (w.matches && w.matches.length)
                ? `${w.matches.length} in range`
                : `best ${formatGp(w.best)} gp`;
            if (w.lastChecked) {
                left.classList.add('wl-checked');
                left.dataset.checked = w.lastChecked;
                left.title = 'Last checked ' + timeAgo(w.lastChecked);
            }
            const right = document.createElement('span');
            const extras = [];
            if (w.farCount) extras.push(`${w.farCount} further off`);
            if (w.barterCount) extras.push(`${w.barterCount} item trade${w.barterCount > 1 ? 's' : ''}`);
            if (w.suspectCount) extras.push(`${w.suspectCount} ignored`);
            right.textContent = extras.join(' · ');
            right.title = 'Offers outside your price window, offers paid in items rather than coins, and ' +
                          'placeholder prices — a token amount listed with the real one in the notes';
            foot.append(left, right);
            card.appendChild(foot);
        }

        host.appendChild(card);
    });
}

// ── Editing an existing watch ───────────────────────────────────────────────
function buildEditForm(w) {
    const form = document.createElement('div');
    form.className = 'wl-edit';

    const dir = document.createElement('div');
    dir.className = 'wl-dir';
    let direction = w.direction;
    const buyBtn = document.createElement('button');
    const sellBtn = document.createElement('button');
    buyBtn.className = 'wl-dir-btn' + (direction === 'buy' ? ' active' : '');
    sellBtn.className = 'wl-dir-btn' + (direction === 'sell' ? ' active' : '');
    buyBtn.textContent = "I'm buying";
    sellBtn.textContent = "I'm selling";
    buyBtn.onclick = () => { direction = 'buy'; buyBtn.classList.add('active'); sellBtn.classList.remove('active'); hint(); };
    sellBtn.onclick = () => { direction = 'sell'; sellBtn.classList.add('active'); buyBtn.classList.remove('active'); hint(); };
    dir.append(buyBtn, sellBtn);

    const range = document.createElement('div');
    range.className = 'wl-range';
    const minIn = document.createElement('input');
    const maxIn = document.createElement('input');
    [minIn, maxIn].forEach(i => { i.className = 'wl-input wl-num'; i.type = 'text'; i.title = 'Accepts 1200k, 12m, 1.5m'; });
    minIn.placeholder = 'min'; maxIn.placeholder = 'max';
    minIn.value = w.min != null ? String(w.min) : '';
    maxIn.value = w.max != null ? String(w.max) : '';
    const dash = document.createElement('span');
    dash.className = 'wl-dash';
    dash.textContent = '–';
    range.append(minIn, dash, maxIn);

    const devRow = document.createElement('div');
    devRow.className = 'wl-dev';
    const devIn = document.createElement('input');
    devIn.className = 'wl-input wl-dev-num';
    devIn.type = 'number';
    devIn.min = '0';
    devIn.value = Number.isFinite(w.deviation) ? w.deviation : 20;
    const devLabel = document.createElement('label');
    devLabel.textContent = 'show within';
    const devPct = document.createElement('span');
    devPct.textContent = '% of it';
    devRow.append(devLabel, devIn, devPct);

    const hintEl = document.createElement('div');
    hintEl.className = 'wl-hint';

    const actions = document.createElement('div');
    actions.className = 'wl-edit-actions';
    const save = document.createElement('button');
    save.className = 'wl-btn';
    save.textContent = 'Save';
    const cancel = document.createElement('button');
    cancel.className = 'wl-btn wl-btn-ghost';
    cancel.textContent = 'Cancel';
    cancel.onclick = () => form.classList.remove('open');
    actions.append(save, cancel);

    function read() {
        const dev = parseInt(devIn.value, 10);
        return { direction, min: parseGp(minIn.value), max: parseGp(maxIn.value),
                 deviation: Number.isFinite(dev) && dev >= 0 ? dev : 20 };
    }
    function hint() {
        const p = read();
        const badMin = minIn.value.trim() && p.min == null;
        const badMax = maxIn.value.trim() && p.max == null;
        if (badMin || badMax) {
            hintEl.textContent = "Can't read that price — try 400, 1200k or 12m";
            save.disabled = true;
            return;
        }
        save.disabled = false;
        hintEl.textContent = `${describeRule(p.direction, p.min, p.max)}. ${describeWindow(p.direction, p.min, p.max, p.deviation)}.`;
    }
    [minIn, maxIn, devIn].forEach(i => i.addEventListener('input', hint));
    hint();

    save.onclick = async () => {
        save.disabled = true;
        save.textContent = 'Saving…';
        render(await ipcRenderer.invoke('update-market-watch', w.id, read()));
    };

    form.append(dir, range, devRow, hintEl, actions);
    return form;
}

function toggleEdit(card, w) {
    card.querySelector('.wl-edit').classList.toggle('open');
}


async function refreshAll() {
    $('watches').innerHTML = '<div class="loading">Checking Markets…</div>';
    render(await ipcRenderer.invoke('refresh-market-watches'));
}

$('notify-toggle').onchange = (e) => ipcRenderer.send('set-market-notify-enabled', e.target.checked);

// Background polling pushes updates here, so the panel is live without anyone
// pressing Refresh. Flash the list so a change that arrives while you are
// looking at it doesn't go unnoticed.
ipcRenderer.on('market-watches-updated', (event, watches) => {
    render(watches);
    const host = $('watches');
    host.classList.remove('wl-flash');
    void host.offsetWidth;          // restart the animation
    host.classList.add('wl-flash');
    updateFreshness();
});

// Keeps "checked 2m ago" honest between polls.
function updateFreshness() {
    const stamps = document.querySelectorAll('.wl-checked');
    stamps.forEach(el => {
        const t = Number(el.dataset.checked);
        if (t) el.title = 'Last checked ' + timeAgo(t);
    });
    const newest = Math.max(0, ...[...stamps].map(el => Number(el.dataset.checked) || 0));
    const label = $('poll-status');
    if (!label) return;
    label.textContent = newest
        ? `Checked ${timeAgo(newest)} · auto every ${Math.round(pollIntervalMs / 60000)} min`
        : `Auto-checks every ${Math.round(pollIntervalMs / 60000)} min`;
}

let pollIntervalMs = 300000;
setInterval(updateFreshness, 30000);

function goBack() { ipcRenderer.send('switch-nav-view', 'nav'); }
function openInWindow() { ipcRenderer.send('open-watchlist-window'); }
// Opens the price history window with nothing loaded, ready to search — so
// looking a price up never requires committing to a watch first.
function openPriceCheck() { ipcRenderer.send('open-price-history-window', { slug: '', name: '' }); }

(async () => {
    // Standalone window: no nav column behind it, and no popping out of itself.
    if (isWindow) {
        $('back-btn').style.display = 'none';
        $('popout-btn').style.display = 'none';
        document.title = 'LostKit - Price Watch';
    }
    $('notify-toggle').checked = await ipcRenderer.invoke('get-market-notify-enabled');
    $('deviation').value = await ipcRenderer.invoke('get-market-default-deviation');
    pollIntervalMs = await ipcRenderer.invoke('get-market-poll-interval');
    render(await ipcRenderer.invoke('get-market-watches'));
    updateFreshness();
})();
