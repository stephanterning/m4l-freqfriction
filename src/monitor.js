// Max owns the Float window. Its onscreen browser owns the two scroll views.
inlets = 1;
outlets = 1;
const host = this;
let browser, ready = false, active = false, frameDict;
let surfaceWidth, surfaceHeight;

function fitWindow() {
    const window = host.patcher.wind;
    if (!browser || !window?.visible) return;
    const [width, height] = window.size;
    if (!(width > 0 && height > 0) || (width === surfaceWidth && height === surfaceHeight)) return;
    surfaceWidth = width;
    surfaceHeight = height;
    browser.message('presentation_rect', 0, 0, width, height);
}

function windowOpened() {
    active = true;
    if (!browser) {
        browser = host.patcher.newdefault(0, 0, 'jweb', '@rendermode', 1, '@presentation', 1);
        host.patcher.hiddenconnect(browser, 0, host.box, 0);
        browser.message('presentation_rect', 0, 0, 935, 594);
        browser.message('url', monitorURL);
    }
    fitWindow();
    if (ready) browser.message('opened');
}

function browserReady() {
    ready = true;
    browser.message(active ? 'opened' : 'closed');
    if (active && frameDict) browser.message('frame', frameDict.stringify());
}

function drawFrame(name) {
    if (!frameDict || frameDict.name !== name) frameDict = new Dict(name);
    fitWindow();
    if (active && ready) browser.message('frame', frameDict.stringify());
}

function drawSpectra(first, ...values) {
    if (first === 0) fitWindow();
    if (active && ready) browser.message('spectra', first, ...values);
}

function windowClosed() {
    active = false;
    if (ready) browser.message('closed');
    outlet(0, 'monitorClosed');
}

function viewAction(action, value, extra) {
    if (active) outlet(0, 'viewAction', action, value, extra || 0);
}
function viewRange(first, count) {
    if (active) outlet(0, 'viewRange', first, count);
}
function setRowHeight(height) {
    if (active) outlet(0, 'setRowHeight', height);
}
// jweb also reports navigation status at its outlet.
function anything() {}
