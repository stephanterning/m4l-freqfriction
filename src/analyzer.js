// Main device. Audio from the helper is read from its capture buffer on the same analysis tick.
inlets = 1;
outlets = bankSize;

const scope = this;
const sources = new Map();
let sourceList = [], reference, monitor, view, request = 0;
let helperAvailable = false, overCapacity = 0;
const selectedTap = 2;
let assignmentSignature = '', localFrame, audioCursor;
let captureWarningUntil = 0;
let monitorRange, savedRowHeight, nextTopologyCheck = 0, selectionWarning = '';
let song, selectionKey, selectionPath, selections = new Set();
const buffers = new Map();
let trackMetadata = new Map(), trackHandles = new Map(), colorScan, nextColorScan = 0;

function updateTrackColors(now) {
    if (!song || !monitor) return;
    if (!colorScan) {
        if (now < nextColorScan) return;
        const own = liveIds(song.get('tracks'));
        const returns = liveIds(song.get('return_tracks'));
        const master = liveIds(song.get('master_track'));
        colorScan = {ids: [...own, ...returns, ...master], regularCount: own.length, returns,
            master: master[0], cursor: 0, colors: new Map(), depths: new Map(), handles: new Map()};
    }
    const scan = colorScan;
    function add(name, rgb, depth = 0) {
        if (!scan.colors.has(name)) scan.colors.set(name, []);
        scan.colors.get(name).push({rgb, depth});
    }
    for (let n = 0; n < 8 && scan.cursor < scan.ids.length; ++n) {
        const index = scan.cursor++;
        const id = scan.ids[index];
        const track = trackHandles.get(id) || new LiveAPI(null, 'id ' + id);
        scan.handles.set(id, track);
        if (index < scan.regularCount && !Number(track.get('has_audio_output'))) continue;
        const rawName = track.get('name');
        const name = Array.isArray(rawName) ? rawName.join(' ') : String(rawName || '');
        const rgb = Number(track.get('color'));
        if (!name || !Number.isInteger(rgb) || rgb < 0 || rgb > 0xffffff) continue;
        let depth = 0;
        if (index < scan.regularCount && Number(track.get('is_grouped'))) {
            const parent = liveIds(track.get('group_track'))[0];
            if (parent) depth = (scan.depths.get(parent) || 0) + 1;
        }
        scan.depths.set(id, depth);
        add(name, rgb, depth);
        const returnIndex = scan.returns.indexOf(id);
        if (returnIndex >= 0) {
            const letter = String.fromCharCode(65 + returnIndex);
            const bare = name.replace(new RegExp('^' + letter + '[- ]'), '');
            for (const alias of [letter + ' ' + bare, letter + '-' + bare])
                if (alias !== name && !scan.colors.has(alias)) add(alias, rgb);
        }
        if (id === scan.master) {
            for (const alias of ['Main', 'Master'])
                if (!scan.colors.has(alias)) add(alias, rgb);
        }
    }
    if (scan.cursor === scan.ids.length) {
        trackMetadata = scan.colors;
        trackHandles = scan.handles;
        colorScan = null;
        nextColorScan = now + 1500;
    }
}

function loadSelections() {
    if (song) return;
    const liveSet = new LiveAPI(null, 'live_set');
    if (!(Number(liveSet.id) > 0)) return;
    song = liveSet;
    const path = song.get('file_path');
    const setPath = Array.isArray(path) ? path.join(' ') : String(path || '');
    selectionKey = 'selected-' + song.id;
    selectionPath = setPath ? setPath + '.freqfriction.json' : '';
    const cached = readShared(selectionKey, null);
    if (cached) {
        selections = new Set(cached.tracks);
    } else if (selectionPath) {
        const file = new File(selectionPath, 'read');
        if (file.isopen) {
            try {
                const saved = JSON.parse(file.readstring(file.eof));
                if (Array.isArray(saved.tracks)) selections = new Set(saved.tracks);
            } catch (error) {
                selectionWarning = 'Could not read saved sources';
            } finally { file.close(); }
        }
    }
}

function saveSelections() {
    if (!selectionKey) return;
    const saved = {tracks: Array.from(selections)};
    writeShared(selectionKey, saved);
    if (!selectionPath) return;
    const file = new File(selectionPath, 'write');
    if (!file.isopen) {
        selectionWarning = 'Sources remembered for this Live session only';
        return;
    }
    try {
        file.position = 0;
        file.writestring(JSON.stringify(saved));
        file.eof = file.position;
        selectionWarning = '';
    } catch (error) {
        selectionWarning = 'Sources remembered for this Live session only';
    } finally { file.close(); }
}

function stereoBuffer(prefix, slot) {
    const name = prefix + '-' + slot;
    if (!buffers.has(name)) buffers.set(name, new Buffer(name));
    return buffers.get(name);
}
const renderFrame = new Task(analyzeFrame, this);
const monitorFrame = new Dict();
let layoutSignature = '';

function makeSource(item) {
    return {
        key: sourceKey(item), label: item.display_name, shown: false, context: false,
        bassPeakDb: new Float32Array(bassBandCount).fill(floor),
        bassTiming: new Float64Array(bassProbes.length * bassSteps),
        sliceDb: new Float32Array(slices * bands), activity: new Float64Array(size), spectrum: new Float32Array(bands).fill(floor),
        peakPower: 0, lastFrameTime: 0, held: new Float32Array(bands), expires: new Float64Array(bands), masks: new Float32Array(bands)
    };
}

function updateSources() {
    const now = Date.now();
    const helper = readShared('helper', null);
    helperAvailable = !!helper && now - helper.time < 2500;
    const remoteCatalog = helperAvailable ? helper.catalog : [];
    const localIds = new Set(catalog.map(sourceKey));
    const remoteIds = new Set(remoteCatalog.map(sourceKey));
    const items = [...catalog, ...remoteCatalog.filter(item => !localIds.has(sourceKey(item)))];
    const local = Array(bankSize).fill(null);
    const remote = Array(bankSize).fill(null);
    const occurrences = new Map();
    overCapacity = 0;
    sourceList = items.map(item => {
        const key = sourceKey(item);
        let source = sources.get(key);
        if (!source) {
            source = makeSource(item);
            sources.set(key, source);
        }
        source.label = item.display_name;
        const occurrence = (occurrences.get(source.label) || 0) + 1;
        occurrences.set(source.label, occurrence);
        source.selection = JSON.stringify([source.label, occurrence]);
        const metadata = trackMetadata.get(source.label)?.[occurrence - 1];
        source.color = metadata?.rgb ?? -1;
        source.depth = metadata?.depth ?? 0;
        source.shown = selections.has(source.selection);
        source.item = item;
        return source;
    });
    // Retain existing slot assignments so enabling or disabling one source does not reroute others.
    for (const source of sourceList) {
        if (!source.shown || source.slot == null || source.slot < 0) continue;
        const canKeep = (source.remote ? remoteIds : localIds).has(source.key);
        const assigned = source.remote ? remote : local;
        if (canKeep && !assigned[source.slot]) assigned[source.slot] = source.item;
    }
    for (const source of sourceList) {
        let slot = -1, isRemote = false;
        if (source.shown) {
            slot = local.indexOf(source.item);
            if (slot < 0) {
                slot = remote.indexOf(source.item);
                isRemote = slot >= 0;
            }
            if (slot < 0 && localIds.has(source.key)) {
                slot = local.indexOf(null);
                if (slot >= 0) local[slot] = source.item;
            }
            if (slot < 0 && remoteIds.has(source.key)) {
                slot = remote.indexOf(null);
                if (slot >= 0) {
                    remote[slot] = source.item;
                    isRemote = true;
                }
            }
            if (slot < 0) overCapacity++;
        }
        if (source.slot !== slot || source.remote !== isRemote) {
            source.fresh = false;
            source.peakPower = 0;
            source.bassPeakDb.fill(floor);
        }
        source.slot = slot;
        source.remote = isRemote;
    }
    if (!sourceList.some(source => source.key === reference && source.shown))
        reference = sourceList.find(source => source.shown)?.key;
    setTargets(local, selectedTap);
    const remoteTargets = Object.fromEntries(remote.flatMap((item, i) => item ? [[i, item]] : []));
    const signature = JSON.stringify([helperAvailable ? helper.token : '', selectedTap, captureRequested, remoteTargets]);
    if (signature !== assignmentSignature) {
        assignmentSignature = signature;
        writeShared('targets', {owner: token, helper: helper?.token || '', tap: selectedTap,
            capture: captureRequested, sources: remoteTargets});
    }
}

function bankChanged() {
    const now = Date.now();
    if (now < nextTopologyCheck) return;
    nextTopologyCheck = now + 300;
    loadSelections();
    updateTrackColors(now);
    updateSources();
    publish();
}

// Display cutoffs for the same directional masking score. High is the reference detector.
const sensitivityThresholds = [0.33, 0.23, warningThreshold];
let sensitivity = 1, hold = 1;
const holdTimes = [0, 2000, 5000];

function applyControl(action, value, extra) {
    if (action === 'closeFloat') {
        if (monitor) scope.patcher.getnamed('floatToggle').message(0);
        return;
    }
    if (action === 'transport') {
        if (monitor && song) song.call(Number(song.get('is_playing')) ? 'stop_playing' : 'start_playing');
        return;
    }
    if (action === 'sensitivity') {
        if (Number.isInteger(value) && value >= 0 && value < sensitivityThresholds.length) {
            sensitivity = value;
            for (const source of sourceList) source.expires.fill(0);
            publish();
        }
        return;
    }
    if (action === 'hold') {
        if (!Number.isInteger(value) || value < 0 || value >= holdTimes.length) return;
        hold = value;
    } else {
        const source = sources.get(String(value));
        if (!source) return;
        if (action === 'visibility') {
            if (source.shown) selections.delete(source.selection);
            else selections.add(source.selection);
            saveSelections();
        }
        else if (action === 'reference' && source.shown) {
            if (extra) source.context = !source.context;
            else reference = source.key;
        }
    }
    for (const source of sourceList) {
        source.masks.fill(0);
        source.expires.fill(0);
    }
    updateSources();
    publish();
}

function msg_float(phase) {
    if (!monitorRange || !bufferName) return;
    const helper = helperAvailable ? readShared('helper', null) : null;
    const shown = sourceList.filter(source => source.shown);
    const analyzing = new Set();
    const [start, count] = monitorRange;
    for (const source of shown.slice(start, start + count)) analyzing.add(source);
    if (reference) analyzing.add(sources.get(reference));
    localFrame = {phase, time: Date.now(), helper, sequence: 0, analyzing};
    if (helper?.buffer && [...analyzing].some(source => source.remote)) {
        localFrame.sequence = ++request;
        messnamed('FreqFriction.Stereo.Capture', 'capture', token, localFrame.sequence);
        renderFrame.schedule(5);
    } else analyzeFrame();
}

function engineRate(rate) {
    if (!(rate > 0) || rate === engineSampleRate) return;
    engineSampleRate = rate;
    audioCursor = null;
    for (const source of sourceList) {
        source.fresh = false;
        source.peakPower = 0;
        source.bassPeakDb.fill(floor);
        source.masks.fill(0);
        source.expires.fill(0);
    }
}

// Keep the analysis grid on the recorded audio when the UI timer jitters.
function windowLags(bank, buffer, phase, time) {
    const frames = buffer.framecount(), rate = bufferRate(buffer);
    const duration = frames * 1000 / rate;
    if (!frames || duration <= 0) return [];
    const {span, margin, radius, hop} = analysisFormat(rate);
    const available = frames - span - margin - radius - 1;
    if (available < 0) return [];
    const head = Math.floor(phase * frames) % frames;
    const previous = audioCursor;
    audioCursor = {bank, frames, duration, head, time, remainder: 0};
    if (!previous || previous.bank !== bank || previous.frames !== frames ||
        previous.duration !== duration) return [0];

    const advance = (head - previous.head + frames) % frames;
    let pending = advance + previous.remainder;
    // A stalled scheduler can outlive the ring. Resume with resident audio only.
    if (time - previous.time >= duration || pending > available + hop) {
        pending = available;
        captureWarningUntil = time + 2000;
    }
    const lags = [];
    for (let lag = pending - hop; lag >= 0; lag -= hop) lags.push(Math.round(lag));
    audioCursor.remainder = pending % hop;
    return lags;
}

function analyzeFrame() {
    if (!monitor || !localFrame) return;
    const {phase, time, helper, sequence, analyzing} = localFrame;
    let remotePhase;
    if (sequence) {
        const snapshot = readShared('snapshot', null);
        if (snapshot && snapshot.owner === token && snapshot.sequence === sequence &&
            snapshot.helper === helper.token && Math.abs(time - snapshot.time) < 12) {
            remotePhase = snapshot.phase;
        }
    }
    const now = Date.now();
    const localStates = slotStates();
    const ready = [];
    for (const source of sourceList) {
        const state = source.slot < 0 ? null :
            (source.remote ? helper?.slots : localStates)?.[source.slot];
        const wanted = source.key + '/' + selectedTap;
        source.state = source.slot < 0 ? (helperAvailable ? 'Awaiting input' : 'Add input helper') :
            state?.wanted === wanted ? state.state : 'Routing…';
        const hasFrame = source.remote ? Number.isFinite(remotePhase) :
            recording && now - recordingStartedAt >= 150;
        if (analyzing.has(source) && hasFrame && state?.wanted === wanted &&
                state.state === 'Ready' && now >= state.readyAt) {
            const bank = source.remote ? helper.buffer : bufferName;
            ready.push({source, bank, buffer: stereoBuffer(bank, source.slot),
                phase: source.remote ? remotePhase : phase, readyAt: state.readyAt});
        } else {
            source.fresh = false;
            if (analyzing.has(source) && source.state === 'Ready')
                source.state = hasFrame ? 'Waiting for audio' : 'Waiting for helper audio';
        }
    }
    if (ready.length) {
        const clock = ready.find(entry => !entry.source.remote) || ready[0];
        const lags = windowLags(clock.bank, clock.buffer, clock.phase, time);
        const samplesPerMs = bufferRate(clock.buffer) / 1000;
        const target = sources.get(reference);
        if (lags.length) for (const {source} of ready) source.masks.fill(0);
        for (const lag of lags) {
            const frameTime = time - lag / samplesPerMs;
            for (const entry of ready) {
                entry.source.fresh = frameTime >= entry.readyAt &&
                    analyze(entry.source, entry.buffer, entry.phase, frameTime, lag);
            }
            if (!target?.fresh) continue;
            for (const {source} of ready) {
                if (!source.fresh || source === target || source.context) continue;
                const overlap = temporalOverlap(target, source);
                if (overlap < warningThreshold) continue;
                const coincidence = bassCoincidence(target, source);
                for (let b = 0; b < warningBandCount; b++)
                    source.masks[b] = Math.max(source.masks[b], bandRisk(target, source, b, overlap, coincidence));
            }
        }
        if (hold && lags.length && target?.fresh) {
            for (const {source} of ready) {
                if (!source.fresh || source === target || source.context) continue;
                for (let b = 0; b < warningBandCount; b++) {
                    const score = source.masks[b];
                    if (score < sensitivityThresholds[sensitivity]) continue;
                    source.held[b] = score;
                    source.expires[b] = now + holdTimes[hold];
                }
            }
        }
    } else {
        audioCursor = null;
        captureWarningUntil = 0;
    }
    publish();
}

function publish() {
    if (!monitor) return;
    const protectedSource = sources.get(reference);
    const displayTime = Date.now();
    view = {
        hold, sensitivity,
        rowHeight: savedRowHeight,
        warningCeilingHz,
        status: bankStatus || selectionWarning || (displayTime < captureWarningUntil ? 'Analysis skipped some audio' : '') || (overCapacity ? overCapacity + ' sources without an input' : ''),
        helper: helperAvailable,
        exceedsLocalCapacity: sourceList.length > bankSize,
        tracks: sourceList.map(({key,label,shown,color,depth}) => ({key,label,shown,color,depth})),
        rows: sourceList.filter(source => source.shown).map(source => {
            const eligible = source.fresh && protectedSource?.fresh && source.key !== reference && !source.context;
            const spectrum = source.fresh ? Array.from(source.spectrum) : [];
            const masks = eligible ? Array.from(source.masks, (score, b) => {
                if (!hold) return score >= sensitivityThresholds[sensitivity] ? score : 0;
                const remaining = (source.expires[b] - displayTime) / holdTimes[hold];
                return source.held[b] * Math.max(0, Math.min(1, remaining));
            }) : [];
            return {key: source.key, label: source.label, color: source.color, protectedRow: source.key === reference,
                context: source.context, status: source.fresh ? '' : source.state || 'Routing…',
                spectrum, masks};
        })
    };
    // Keep continuously changing numbers out of Max's permanent symbol table.
    // Only send labels, routing status and layout when they actually change.
    const layout = JSON.stringify({...view, rows: view.rows.map(({spectrum, masks, ...row}) => row)});
    const plot = monitor.getnamed('plot');
    if (layout !== layoutSignature) {
        layoutSignature = layout;
        monitorFrame.parse(layout);
        plot.message('drawFrame', monitorFrame.name);
    }
    if (!monitorRange || !view.rows.length) {
        plot.message('drawSpectra', 0);
        return;
    }
    // Bound the length of each Max message even if both input banks are visible.
    for (let first = 0; first < view.rows.length; first += 5) {
        const values = [];
        for (const {spectrum, masks} of view.rows.slice(first, first + 5))
            values.push(spectrum.length, masks.length, ...spectrum, ...masks);
        plot.message('drawSpectra', first, ...values);
    }
}

function monitorOpened() {
    if (!Number(scope.patcher.getnamed('floatToggle').getvalueof())) return;
    monitor = scope.patcher.getnamed('monitor').subpatcher();
    layoutSignature = '';
    captureRequested = true;
    scope.patcher.getnamed('poll').message(1);
    scope.patcher.getnamed('routingClock').message(1);
    scope.patcher.getnamed('clock').message(1);
    updateSources();
    updateCapture();
    monitor.getnamed('plot').message('windowOpened');
    publish();
}
function monitorClosed() {
    scope.patcher.getnamed('floatToggle').message('set', 0);
    monitor = null;
    monitorRange = null;
    audioCursor = null;
    captureWarningUntil = 0;
    captureRequested = false;
    scope.patcher.getnamed('poll').message(0);
    scope.patcher.getnamed('routingClock').message(0);
    for (const source of sourceList) source.fresh = false;
    scope.patcher.getnamed('clock').message(0);
    updateSources();
    updateCapture();
}
function viewRange(start, count) {
    if (monitor && Number.isInteger(start) && Number.isInteger(count)) monitorRange = [start, count];
}
function setRowHeight(height) {
    if (monitor && Number.isFinite(height)) savedRowHeight = height;
}
function notifydeleted() {
    if (readShared('targets', null)?.owner === token) exchange.remove('targets');
}
function viewAction(action, value, extra) { applyControl(action, value, extra); }

