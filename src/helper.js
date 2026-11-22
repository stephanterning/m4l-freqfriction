// Helper receives the overflow assignment and publishes the phase of its own capture buffer.
inlets = 1;
outlets = bankSize;
const scope = this;
let requestedBy, sequence, lastHeartbeat = 0;

function bankChanged() {
    const assignment = readShared('targets', null);
    if (assignment?.helper === token) {
        setTargets(Array.from({length: bankSize}, (_, i) => assignment.sources[i]), assignment.tap);
        captureRequested = assignment.capture === true;
    } else {
        setTargets([], tapIndex);
        captureRequested = false;
    }
    updateCapture();
    if (!bufferName || !device) return;
    const now = Date.now();
    if (now - lastHeartbeat < 100) return;
    lastHeartbeat = now;
    writeShared('helper', {
        token, time: now, buffer: bufferName, catalog: bankStatus ? [] : catalog,
        slots: slotStates()
    });
}

function capture(owner, index) {
    if (!recording || Date.now() - recordingStartedAt < 150) return;
    requestedBy = owner;
    sequence = index;
    scope.patcher.getnamed('head').message('bang');
}

function msg_float(phase) {
    if (!requestedBy) return;
    writeShared('snapshot', {owner: requestedBy, sequence, helper: token, phase, time: Date.now()});
    requestedBy = null;
}

function notifydeleted() {
    if (readShared('helper', null)?.token === token) exchange.remove('helper');
}
