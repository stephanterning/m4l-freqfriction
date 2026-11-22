// One device per bank. Both devices use Live's own DeviceIO routing options.
const bankSize = 31;
const taps = ['Pre FX', 'Post FX', 'Post Mixer'];
const token = String(Date.now()) + '-' + Math.random().toString(36).slice(2);
const exchange = new Dict('FreqFriction.Stereo.Inputs');
exchange.quiet = true;
const routingScope = this;
const routeWriteInterval = 120;
const slots = Array.from({length: bankSize}, () => ({id: 0, command: '', readyAt: 0}));
let device, bufferName, bankStatus = 'Waiting for Live', updateCursor = 0;
let catalog = [], targets = [], tapIndex = 2;
let recording = false, captureRequested = false, recordingStartedAt = 0;

function readShared(key, fallback) {
    const value = exchange.get(key);
    return value ? JSON.parse(value.stringify()) : fallback;
}

function writeShared(key, value) {
    exchange.setparse(key, JSON.stringify(value));
}

function read(io, key) {
    const raw = io.get(key);
    if (raw && !Array.isArray(raw) && typeof raw === 'object') return raw[key] ?? raw;
    const parts = Array.isArray(raw) ? raw : [raw];
    const value = parts[0] === 'dictionary'
        ? JSON.parse(new Dict(String(parts[1])).stringify())
        : JSON.parse(parts.join(' '));
    return value[key] ?? value;
}

function sourceKey(item) { return String(item.identifier); }
function liveIds(raw) {
    return (Array.isArray(raw) ? raw.join(' ') : String(raw))
        .match(/\bid\s+\d+/g)?.map(value => Number(value.slice(3))).filter(Boolean) || [];
}
function sameSource(a, b) { return a != null && b != null && sourceKey(a) === sourceKey(b); }
function internalSource(item) {
    return item.identifier != null && item.display_name &&
        !/^(?:Ext\. In|No Input|Resampling)$/i.test(item.display_name);
}

function setRoute(index, key, value) {
    const slot = slots[index];
    const now = Date.now();
    if (now < Number(exchange.get('nextRouteWrite') || 0)) return false;
    exchange.replace('nextRouteWrite', now + routeWriteInterval);
    if (!slot.bound) {
        outlet(index, 'id', slot.id);
        slot.bound = true;
    }
    const dict = new Dict();
    dict.parse(JSON.stringify(value));
    outlet(index, 'set', key, 'dictionary', dict.name);
    return true;
}

function port(slot) {
    if (!slot.io) slot.io = new LiveAPI(null, 'id ' + slot.id);
    return slot.io;
}

function bindDevice(selector, id) {
    if (selector !== 'id' || !(Number(id) > 0)) return;
    try {
        if (!device || Number(device.id) !== Number(id)) device = new LiveAPI(null, 'id ' + id);
        const ids = liveIds(device.get('audio_inputs'));
        if (ids.length !== bankSize && ids.length !== bankSize + 1)
            throw Error('waiting for ' + bankSize + ' stereo inputs (' + ids.length + ' returned)');
        ids.slice(-bankSize).forEach((slotId, index) => {
            if (slots[index].id === slotId) return;
            slots[index] = {id: slotId, command: '', readyAt: 0};
        });
        catalog = read(port(slots[0]), 'available_routing_types').filter(internalSource);
        bankStatus = '';
    } catch (error) {
        bankStatus = 'Routing: ' + error.message;
    }
    bankChanged();
}

function setTargets(next, tap) {
    targets = next;
    tapIndex = tap;
}

function updateRouting() {
    if (bankStatus || !slots[0].id) return;
    if (Date.now() < Number(exchange.get('nextRouteWrite') || 0)) {
        bankChanged();
        return;
    }
    try {
        for (let k = 0; k < 6; ++k) {
            const index = updateCursor++ % bankSize;
            const slot = slots[index], target = targets[index];
            const wanted = target ? sourceKey(target) + '/' + tapIndex : '';
            if (slot.wanted !== wanted) {
                slot.wanted = wanted;
                slot.command = '';
                slot.attempts = 0;
                slot.retryAt = 0;
                slot.readyAt = 0;
                slot.state = target ? 'Routing…' : '';
            }
            if (!target) {
                if (slot.assigned) {
                    const none = read(port(slot), 'available_routing_types').find(value => value.display_name === 'No Input');
                    slot.assigned = false;
                    if (none && setRoute(index, 'routing_type', none)) break;
                }
                continue;
            }
            if (slot.state !== 'Routing…' || Date.now() < slot.retryAt) continue;
            const io = port(slot);
            const route = read(io, 'routing_type');
            if (!sameSource(route, target)) {
                if (slot.attempts >= 3) { slot.state = 'Routing rejected'; continue; }
                const choice = read(io, 'available_routing_types').find(item => sameSource(item, target));
                if (!choice) { slot.state = 'Source unavailable'; continue; }
                if (setRoute(index, 'routing_type', choice)) {
                    slot.command = 'source';
                    slot.assigned = true;
                    slot.attempts++;
                    slot.retryAt = Date.now() + 300;
                    break;
                }
                continue;
            }
            slot.assigned = true;
            const tap = read(io, 'available_routing_channels').find(item => item.display_name === taps[tapIndex]);
            if (!tap) { slot.state = 'Tap unavailable'; continue; }
            if (!sameSource(read(io, 'routing_channel'), tap)) {
                if (slot.command !== 'tap') slot.attempts = 0;
                if (slot.attempts >= 3) { slot.state = 'Tap rejected'; continue; }
                if (setRoute(index, 'routing_channel', tap)) {
                    slot.command = 'tap';
                    slot.attempts++;
                    slot.retryAt = Date.now() + 300;
                    break;
                }
                continue;
            }
            slot.state = 'Ready';
            slot.readyAt = Date.now() + 150;
        }
    } catch (error) { bankStatus = 'Routing: ' + error.message; }
    updateCapture();
    bankChanged();
}

function updateCapture() {
    const captureNeeded = captureRequested && slots.some((slot, index) =>
        targets[index] && slot.wanted === sourceKey(targets[index]) + '/' + tapIndex && slot.state === 'Ready');
    if (captureNeeded !== recording) {
        routingScope.patcher.getnamed('capture').message(captureNeeded ? 1 : 0);
        recording = captureNeeded;
        recordingStartedAt = captureNeeded ? Date.now() : 0;
    }
}

function slotStates() {
    return slots.map(slot => ({wanted: slot.wanted || '', state: slot.state || '', readyAt: slot.readyAt}));
}

function buffername(name) {
    bufferName = name;
}
