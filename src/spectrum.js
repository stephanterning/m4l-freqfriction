// Ordinary wheel input belongs to the two overflow panes. Their DOM nodes stay
// attached while new analysis frames arrive, including during a momentum gesture.
const byId = id => document.getElementById(id);
const monitor = byId('monitor'), sources = byId('sources'), spectra = byId('spectra');
const rows = byId('rows'), divider = byId('divider'), zoom = byId('zoom');
const bridge = window.max;
const collapsedTracks = new Set();
let view, sidebarWidth, dragOffset, scale = 1, rowHeight = 56, previousRange = '';
let ticks = [], plotPending = false, active = true;
const send = (...args) => bridge.outlet(...args);

function layout() {
    const width = innerWidth / scale;
    const initial = Math.min(192, Math.floor(width * 0.34));
    const sidebar = Math.max(Math.min(88, initial), Math.min(sidebarWidth ?? initial, Math.max(initial, width - 112)));
    const compact = width - sidebar < 312;
    const stacked = width - sidebar < 565;
    const labelWidth = Math.min(145, Math.floor((width - sidebar) * 0.34));
    monitor.style.setProperty('--sidebar', sidebar + 'px');
    monitor.style.setProperty('--labels', labelWidth + 'px');
    monitor.style.setProperty('--header', (compact ? 96 : stacked ? 72 : 48) + 'px');
    monitor.classList.toggle('compact', compact);
    monitor.classList.toggle('stacked', stacked);
    const wide = width - sidebar - labelWidth - 10 >= 230;
    const frequencies = wide ? [50, 100, 250, 500, 1000, 2500, 5000, 10000] : [100, 1000, 10000];
    if (ticks.length !== frequencies.length) {
        ticks = frequencies.map(hz => Math.log(hz / 30) / Math.log(600));
        byId('axis').replaceChildren(...frequencies.map((hz, i) => {
            const label = document.createElement('span');
            label.textContent = hz >= 1000 ? hz / 1000 + 'k' : String(hz);
            label.style.left = ticks[i] * 100 + '%';
            return label;
        }));
    }
    schedulePlot();
    return sidebar;
}

function updateRows(container, items, create, update) {
    for (let i = 0; i < items.length; i++) {
        const node = container.children[i] || container.appendChild(create());
        node.dataset.key = items[i].key;
        update(node, items[i]);
    }
    while (container.children.length > items.length) container.lastElementChild.remove();
}

function sourceButton() {
    const node = document.createElement('button');
    node.className = 'source';
    node.innerHTML = '<span class="check"></span><span class="ellipsis"></span>';
    return node;
}
function spectrumRow() {
    const node = document.createElement('div');
    node.className = 'row';
    node.innerHTML = '<div class="row-label"><button class="fold" type="button"></button>' +
        '<button class="track-name" type="button"><span class="name ellipsis"></span>' +
        '<svg class="shield" viewBox="0 0 16 16" role="img" aria-label="Protected">' +
        '<title>Protected</title><path d="M8 2 14 4v3.5c0 3-2 5.2-6 7-4-1.8-6-4-6-7V4Z"/></svg>' +
        '<span class="detail ellipsis"></span></button></div><canvas></canvas>';
    return node;
}

function updateFold(row) {
    const collapsed = collapsedTracks.has(row.dataset.key);
    const fold = row.firstChild.firstChild;
    const expanded = String(!collapsed);
    if (fold.getAttribute('aria-expanded') === expanded) return;
    row.classList.toggle('collapsed', collapsed);
    fold.setAttribute('aria-expanded', expanded);
    fold.title = collapsed ? 'Expand spectrum' : 'Collapse spectrum';
}

function setText(element, value) {
    if (element.textContent !== value) element.textContent = value;
}

function trackColorHex(rgb) {
    return Number.isInteger(rgb) && rgb >= 0 && rgb <= 0xffffff
        ? '#' + rgb.toString(16).padStart(6, '0') : '';
}

function setTrackLabelColor(node, rgb) {
    const background = trackColorHex(rgb);
    if (background === (node.dataset.trackColor || '')) return;
    if (!background) {
        delete node.dataset.trackColor;
        node.style.removeProperty('--track-fg');
        node.style.removeProperty('--track-bg');
        return;
    }

    function linear(channel) {
        const srgb = (channel & 255) / 255;
        return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    }
    const luminance = 0.2126 * linear(rgb >> 16) + 0.7152 * linear(rgb >> 8) + 0.0722 * linear(rgb);
    // Live exposes the background RGB. This cutoff matches the dark red and purple in the reference.
    node.dataset.trackColor = background;
    node.style.setProperty('--track-bg', background);
    node.style.setProperty('--track-fg', luminance >= 0.14 ? '#000' : '#fff');
}

function frame(payload) {
    const next = JSON.parse(payload);
    if (!view && Number.isFinite(next.rowHeight)) setHeight(next.rowHeight);
    for (const row of next.rows) {
        row.spectrum = [];
        row.masks = [];
    }
    view = next;
    const protectedKey = view.rows.find(row => row.protectedRow)?.key;
    setText(byId('count'), 'Sources  ' + view.rows.length + '/' + view.tracks.length);
    setText(byId('helper'), view.helper ? 'Input helper connected' : view.exceedsLocalCapacity ? 'Input helper offline' : '');
    setText(byId('status'), view.status);
    Array.from(byId('controls').querySelectorAll('button')).forEach((button, i) => button.classList.toggle('selected', i === view.hold));
    byId('sensitivity').querySelectorAll('button').forEach((button, i) =>
        button.setAttribute('aria-pressed', String(i === view.sensitivity)));
    updateRows(sources, view.tracks, sourceButton, (node, track) => {
        const shown = Boolean(track.shown);
        node.title = track.label;
        const padding = (8 + 12 * track.depth) + 'px';
        if (node.style.paddingLeft !== padding) node.style.paddingLeft = padding;
        node.setAttribute('aria-pressed', shown);
        node.classList.toggle('protected', track.key === protectedKey);
        setTrackLabelColor(node, track.color);
        setText(node.firstChild, shown ? '✓' : '');
        setText(node.lastChild, track.label);
    });
    updateRows(rows, view.rows, spectrumRow, (node, row) => {
        const label = node.firstChild;
        const name = label.lastChild;
        if (node.title !== row.label) {
            node.title = row.label;
            label.firstChild.setAttribute('aria-label', 'Fold or unfold spectrum for ' + row.label);
        }
        node.classList.toggle('protected', row.protectedRow);
        updateFold(node);
        setTrackLabelColor(label, row.color);
        setText(name.firstChild, row.label);
        setText(name.lastChild, row.status || (row.context && !row.protectedRow ? 'Context' : ''));
    });
    byId('empty').hidden = !!view.rows.length;
    schedulePlot();
}

function updateSpectra(first, ...values) {
    if (!active || !view) return;
    let offset = 0;
    for (let i = first; i < view.rows.length && offset < values.length; i++) {
        const row = view.rows[i];
        const bins = values[offset++], masks = values[offset++];
        if (offset + bins + masks > values.length || !Number.isInteger(bins) || !Number.isInteger(masks)) return;
        row.spectrum = values.slice(offset, offset + bins);
        offset += bins;
        row.masks = values.slice(offset, offset + masks);
        offset += masks;
    }
    schedulePlot();
}

function displayDb(spectrum, index) {
    const last = spectrum.length - 1;
    // Symmetric, seven-band smoothing for the display, with edge values extended.
    return (spectrum[Math.max(0, index - 3)] + spectrum[Math.min(last, index + 3)] +
        6 * (spectrum[Math.max(0, index - 2)] + spectrum[Math.min(last, index + 2)]) +
        15 * (spectrum[Math.max(0, index - 1)] + spectrum[Math.min(last, index + 1)]) +
        20 * spectrum[index]) / 64;
}

function traceSpectrum(ctx, spectrum, bandWidth, height) {
    if (!spectrum.length) return;

    const yAt = index => {
        const db = displayDb(spectrum, index);
        return height - 3 - (height - 7) * Math.max(0, Math.min(1, (db + 78) / 78));
    };
    let y = yAt(0);
    ctx.moveTo(0, y);
    if (spectrum.length === 1) return;

    const controlWidth = bandWidth / 3;
    let nextY = yAt(1);
    let tangent = nextY - y;
    for (let i = 1; i < spectrum.length; i++) {
        const rise = nextY - y;
        const hasFollowing = i + 1 < spectrum.length;
        const followingY = hasFollowing ? yAt(i + 1) : nextY;
        const nextRise = hasFollowing ? followingY - nextY : rise;
        // Flatten turns and limit slopes so the curve stays between adjacent samples.
        const nextTangent = rise * nextRise > 0
            ? Math.sign(rise) * Math.min(Math.abs(rise), Math.abs(nextRise)) : 0;
        const x = i * bandWidth;
        if (tangent === rise && nextTangent === rise) {
            ctx.lineTo(x, nextY);
        } else {
            ctx.bezierCurveTo(x - 2 * controlWidth, y + tangent / 3,
                x - controlWidth, nextY - nextTangent / 3, x, nextY);
        }
        y = nextY;
        nextY = followingY;
        tangent = nextTangent;
    }
}

function paintCurve(canvas, row) {
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) return;
    const density = devicePixelRatio * scale;
    const w = Math.round(width * density), h = Math.round(height * density);
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(w / width, 0, 0, h / height, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = 'rgba(255,255,255,.08)';
    for (const tick of ticks) ctx.fillRect(tick * width, 0, 1, height);
    const bandWidth = width / Math.max(1, row.spectrum.length - 1);
    const warningRight = width * Math.log(view.warningCeilingHz / 30) / Math.log(600);
    row.masks.forEach((amount, i) => {
        if (!amount) return;
        ctx.fillStyle = 'rgba(255,46,46,' + 0.58 * amount + ')';
        const x = Math.max(0, (i - 0.5) * bandWidth);
        if (x < warningRight) ctx.fillRect(x, 0, Math.min(bandWidth + 0.2, warningRight - x), height);
    });
    ctx.lineWidth = row.protectedRow ? 1.7 : 1.15;
    ctx.strokeStyle = trackColorHex(row.color) || '#cad4e3';
    ctx.beginPath();
    traceSpectrum(ctx, row.spectrum, bandWidth, height);
    ctx.stroke();
}

function firstRowMatching(matches) {
    let first = 0, end = rows.children.length;
    while (first < end) {
        const middle = Math.floor((first + end) / 2);
        if (matches(rows.children[middle].getBoundingClientRect())) end = middle;
        else first = middle + 1;
    }
    return first;
}

function schedulePlot() {
    if (plotPending || !active) return;
    plotPending = true;
    requestAnimationFrame(() => {
        plotPending = false;
        if (!view || !active) return;
        const {top, bottom} = spectra.getBoundingClientRect();
        const first = firstRowMatching(rect => rect.bottom > top);
        const end = bottom > top ? firstRowMatching(rect => rect.top >= bottom) : first;
        const range = first + '/' + end;
        if (range !== previousRange) {
            previousRange = range;
            send('viewRange', first, end - first);
        }
        for (let i = first; i < end; i++) paintCurve(rows.children[i].lastChild, view.rows[i]);
    });
}

function keepScrollAnchor(updateLayout) {
    const {top} = spectra.getBoundingClientRect();
    const index = firstRowMatching(rect => rect.bottom > top);
    const anchor = rows.children[index];
    const before = anchor?.getBoundingClientRect();
    updateLayout();
    if (before?.height) {
        const fraction = (top - before.top) / before.height;
        const after = anchor.getBoundingClientRect();
        spectra.scrollTop += (after.top + fraction * after.height - top) / scale;
    }
    schedulePlot();
}

function setHeight(value) {
    const next = Math.min(120, Math.max(32, value));
    if (next === rowHeight) return;
    keepScrollAnchor(() => {
        rowHeight = next;
        monitor.style.setProperty('--row-height', rowHeight + 'px');
    });
}

// Option+wheel changes row height. For ordinary gestures the browser handles
// scrolling and its platform momentum, including stopping on a fresh touch.
monitor.addEventListener('wheel', event => {
    if (!event.altKey || !event.deltaY) return;
    event.preventDefault();
    const change = Math.max(-9, Math.min(9, event.deltaY / 4));
    const before = rowHeight;
    setHeight(before + change);
    if (rowHeight !== before) send('setRowHeight', rowHeight);
}, {passive:false});
spectra.addEventListener('scroll', schedulePlot, {passive:true});
sources.onclick = event => {
    const button = event.target.closest('.source');
    if (button) send('viewAction', 'visibility', button.dataset.key, Number(event.shiftKey));
};
rows.onclick = event => {
    const row = event.target.closest('.row');
    if (!row) return;
    if (event.target.closest('.fold')) {
        const key = row.dataset.key;
        if (collapsedTracks.has(key)) collapsedTracks.delete(key);
        else collapsedTracks.add(key);
        keepScrollAnchor(() => updateFold(row));
        return;
    }
    send('viewAction', 'reference', row.dataset.key, Number(event.shiftKey));
};
byId('sensitivity').querySelectorAll('button').forEach((button, i) => {
    button.onclick = () => send('viewAction', 'sensitivity', i);
});
byId('controls').querySelectorAll('button').forEach((button, i) => {
    button.onclick = () => send('viewAction', 'hold', i);
});
zoom.onchange = () => {
    scale = parseInt(zoom.value, 10) / 100;
    monitor.style.zoom = scale;
    layout();
};
divider.onpointerdown = event => {
    dragOffset = event.clientX / scale - layout();
    divider.setPointerCapture(event.pointerId);
    divider.classList.add('drag');
};
divider.onpointermove = event => {
    if (dragOffset === undefined) return;
    sidebarWidth = event.clientX / scale - dragOffset;
    sidebarWidth = layout();
};
divider.onlostpointercapture = () => {
    dragOffset = undefined;
    divider.classList.remove('drag');
};
addEventListener('keydown', event => {
    if (!active || event.defaultPrevented || event.isComposing ||
        event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (event.key !== 'Escape' && event.code !== 'Space') return;
    // Let the native zoom picker dismiss itself or accept its selection.
    if (CSS.supports('selector(select:open)') && zoom.matches(':open')) return;
    event.preventDefault();
    if (!event.repeat) send('viewAction', event.key === 'Escape' ? 'closeFloat' : 'transport', 0);
});
addEventListener('resize', layout);
bridge.bindInlet('frame', frame);
bridge.bindInlet('spectra', updateSpectra);
bridge.bindInlet('opened', () => {active = true; previousRange = ''; layout();});
bridge.bindInlet('closed', () => {active = false;});
layout();
send('browserReady');
