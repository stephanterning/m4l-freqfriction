// Run after building the device: node tests/band-overlap.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const device = fs.readFileSync(path.join(__dirname, '..', 'FreqFriction.amxd'));
const patch = JSON.parse(device.subarray(32, -1));
const script = patch.patcher.boxes.find(({box}) => box.id === 'plot').box.textfile.text;
const context = vm.createContext({Dict: function () {}, Task: function () {}});
const measureSource = script + `
    (function (bufferA, bufferB) {
        const a = makeSource({identifier: 1}), b = makeSource({identifier: 2});
        analyze(a, bufferA, 0, 1000);
        analyze(b, bufferB, 0, 1000);
        const overlap = temporalOverlap(a, b);
        const coincidence = bassCoincidence(a, b);
        return Array.from(a.spectrum, (_, band) => ({
            hz: hz(band), old: risk(a.spectrum[band], b.spectrum[band]) * overlap,
            reference: referenceBandRisk(a, b, band, overlap),
            warning: bandRisk(a, b, band, overlap, coincidence)
        }));
    })`;
const measure = vm.runInContext(measureSource, context);
const fallback = vm.createContext({Dict: function () {}, Task: function () {}, WebAssembly: undefined});
const measureFallback = vm.runInContext(measureSource, fallback);
assert(vm.runInContext('!!displayFFT.exports && !!overlapFFT.exports', context));
assert(vm.runInContext('!displayFFT.exports && !overlapFFT.exports', fallback));

// Both tracks sustain the same upper tone. Their low notes either alternate
// or overlap. Opposite stereo polarity guards against accidentally summing to mono.
function buffer(rate, sub, early) {
    const length = Math.round(rate / 2);
    return {
        channelcount: () => 2, framecount: () => length, length: () => 1000 * length / rate,
        peek(channel, start, count) {
            return Float64Array.from({length: count}, (_, i) => {
                const n = (start + i - length) * 44100 / rate + 4096 + 256;
                const onset = sub ? (early ? 700 : 2150) : 0;
                const end = sub ? 4096 : 1960;
                const envelope = Math.max(0, Math.min(1, (n - onset) / 120, (end - n) / 120));
                const phase = 2 * Math.PI * n / 44100;
                return (channel === 1 ? 1 : -1) * (0.3 * envelope * Math.sin(70 * phase)
                    + 0.22 * Math.sin(2400 * phase));
            });
        }
    };
}

for (const rate of [44100, 48000, 96000]) {
    for (const early of [false, true]) {
        const values = measure(buffer(rate, false, early), buffer(rate, true, early));
        // Compare all 80 bands across VM realms, including subthreshold scores
        // and the final warning, with and without the compiled DSP kernels.
        const expected = measureFallback(buffer(rate, false, early), buffer(rate, true, early));
        assert.equal(JSON.stringify(values), JSON.stringify(expected));
        const low = values.filter(v => v.hz > 55 && v.hz < 90);
        assert(low.some(v => v.old >= 0.16), 'fixture must reproduce the broadband false positive');
        assert.equal(low.some(v => v.warning > 0), early, 'sub warning at ' + rate);
        assert(values.some(v => v.hz > 2000 && v.hz < 2800 && v.warning > 0), 'upper tones coincide');
    }
}

// Steady-state response of a complementary first-order 825 Hz crossover to
// each sinusoid. Only its low output is ducked. The high output still contains
// a real, attenuated 65 Hz component. Full-band ducking is the negative control.
function duckedPair(rate, cut, early, split, phase) {
    const frames = rate / 2;
    function track(kick) {
        return {channelcount: () => 2, framecount: () => frames, length: () => 500,
            peek(channel, start, count) {
                return Float64Array.from({length: count}, (_, i) => {
                    const t = (start + i - frames) / rate + (4096 + 256) / 44100;
                    const ms = 1000 * t;
                    const startMs = kick ? cut - 20 : cut - early;
                    const endMs = kick ? cut : cut + 34;
                    const ramp = Math.max(0, Math.min(1, (ms - startMs) / 2, (endMs - ms) / 2));
                    const gain = (1 - Math.cos(Math.PI * ramp)) / 2;
                    const subPhase = 2 * Math.PI * 65 * t + phase;
                    if (kick) return 0.3 * gain * Math.sin(subPhase);
                    let bass = 0;
                    for (const [hz, angle] of [[65, subPhase], [1800, 2 * Math.PI * 1800 * t]]) {
                        const x = Math.sin(angle);
                        const ratio = hz / 825;
                        const low = (x - ratio * Math.cos(angle)) / (1 + ratio * ratio);
                        bass += 0.5 * (split ? x - low + gain * low : gain * x);
                    }
                    return channel === 1 ? bass : -bass;
                });
            }};
    }
    return [track(true), track(false)];
}

for (const rate of [44100, 48000, 96000]) {
    let reproduced = false;
    for (const cut of [48, 58, 68]) for (const phase of [0, Math.PI / 2]) {
        for (const split of [false, true]) for (const early of [0, 15]) {
            const pair = duckedPair(rate, cut, early, split, phase);
            const scores = measure(...pair);
            if (split && cut === 58)
                assert.equal(JSON.stringify(scores), JSON.stringify(measureFallback(...pair)));
            const sub = scores.filter(v => v.hz >= 60 && v.hz <= 70);
            if (split && !early && sub.some(v => v.reference >= 0.23)) reproduced = true;
            if (!early) assert(sub.every(v => !v.warning), 'false sub warning at ' + rate);
            if (early) assert(sub.some(v => v.warning >= 0.23), 'missed early sub at ' + rate);
            assert(scores.every(v => v.hz < 260 || v.reference === v.warning));
        }
    }
    assert(reproduced, 'reference detector must warn on split signal at ' + rate);
}

// A loud bass note gives way to a much quieter, spectrally overlapping tail.
// Feed the same sources over successive frames so the detector sees the decay.
// Also exercise a fresh quiet target, recovery, and a masker hitting the attack.
const followNote = vm.runInContext(`(function (pairs) {
    const a = makeSource({identifier: 1}), b = makeSource({identifier: 2});
    const band = 10;
    return pairs.map(([target, masker], i) => {
        analyze(a, target, 0, 1000 + i * 70);
        analyze(b, masker, 0, 1000 + i * 70);
        const overlap = temporalOverlap(a, b);
        return [referenceBandRisk(a, b, band, overlap), bandRisk(a, b, band, overlap)];
    });
})`, context);
function levelBuffer(amplitude) {
    return {channelcount: () => 2, framecount: () => 22050, length: () => 500,
        peek(channel, offset, count) {
            return Float64Array.from({length: count}, (_, i) =>
                amplitude * Math.sin(2 * Math.PI * 65 * (i + offset) / 44100) +
                0.14 * Math.sin(2 * Math.PI * 1800 * (i + offset) / 44100));
        }};
}
const loud = levelBuffer(0.36), quiet = levelBuffer(0.018);
const steps = followNote([[loud, loud], ...Array.from({length: 12}, () => [quiet, loud])]);
assert(steps[0][1] >= 0.33, 'overlap on the protected attack must warn');
assert(steps[1][0] >= 0.33 && steps[1][1] < 0.16, 'a fading tail must lose weight');
assert(steps.at(-1)[1] >= 0.33, 'a sustained quiet target must recover');
assert(followNote([[quiet, loud]])[0][1] >= 0.33, 'a quiet target alone sets its own reference');

// Feed the packaged scheduler real ring positions, including wrap and late UI ticks.
// A burst can start and finish between ticks. Only a mask delivered to the UI counts.
const playback = vm.runInContext(`(function (ring, rate, ticks) {
    const a = makeSource({identifier: 1}), b = makeSource({identifier: 2});
    sourceList = [a,b];
    for (const [slot, source] of sourceList.entries()) {
        Object.assign(source, {shown: true, slot, remote: false});
        sources.set(source.key, source);
        slots[slot] = {wanted: source.key + '/' + selectedTap, state: 'Ready', readyAt: 0};
    }
    bufferName = 'test-bank';
    for (const slot of [0,1]) buffers.set(bufferName + '-' + slot, ring);
    reference = a.key;
    recording = true;
    recordingStartedAt = 0;
    monitor = {getnamed: () => ({message() {}})};
    monitorFrame.parse = () => {};
    monitorRange = [0,2];
    audioCursor = null;
    const events = [];
    for (const sample of ticks) {
        ring.advance(sample);
        Date.now = () => 1000 + sample / rate * 1000;
        const phase = (sample % ring.framecount()) / ring.framecount();
        msg_float(phase);
        events.push({masks: view.rows[1].masks, spectrum: view.rows[1].spectrum});
    }
    return events;
})`, context);
function burstRun(rate, onset, frequency) {
    const frames = Math.round(rate / 4);
    const ticks = [220, 305, 412, 480].map(ms => Math.round(rate * ms / 1000));
    const data = new Float64Array(frames);
    const start = Math.round(rate * onset / 1000);
    let head = 0;
    const ring = {channelcount: () => 2, framecount: () => frames, length: () => 250,
        advance(end) {
            for (; head < end; head++) {
                const n = head - start;
                data[head % frames] = n >= 0 && n < rate * 0.012
                    ? 0.6 * Math.sin(2 * Math.PI * n * frequency / rate) *
                        Math.sin(Math.PI * n / (rate * 0.012)) ** 2 : 0;
            }
        },
        peek(channel, index, count) { return data.subarray(index, index + count); }};
    return playback(ring, rate, ticks);
}
for (const rate of [44100, 48000, 96000]) {
    for (const onset of [225, 245, 265, 285, 310, 335, 360, 390]) {
        assert(burstRun(rate, onset, 2000).some(({masks}) =>
            masks.some((v, i) => v > 0 && Math.abs(30 * 600 ** (i / 79) - 2000) < 150)),
            'missed burst at ' + onset + ' ms, ' + rate + ' Hz');
    }
}
const upperBand = burstRun(96000, 260, 15500);
assert(upperBand.some(({masks}) => masks[77] > 0), 'lost warnings below the ceiling');
const high = burstRun(96000, 260, 17200);
assert(high.some(({masks}) => masks[78] > 0), 'missing 17.2 kHz warning');
assert(burstRun(96000, 260, 17950).some(({masks}) => masks[79] > 0), 'missing final warning band');
assert(burstRun(96000, 260, 19500).every(({masks}) => masks.every(v => v === 0)), 'warning above range');
assert(high.some(({spectrum}) => spectrum.slice(-2).some(v => v > -65)), 'lost upper spectrum');

// At 96 kHz a 300 ms scheduling delay should fit, but a 600 ms gap loses audio.
const scheduler = vm.runInContext(`(function () {
    audioCursor = null;
    captureWarningUntil = 0;
    const ring = {framecount: () => 48000, length: () => 500};
    windowLags('main', ring, 0, 1000);
    const catchup = windowLags('main', ring, 0.6, 1300);
    const healthy = captureWarningUntil === 0;
    windowLags('main', ring, 0.8, 1900);
    windowLags('main', ring, 0.97, 1985);
    return {healthy, windows: catchup.length, warningUntil: captureWarningUntil};
})()`, context);
assert(scheduler.healthy && scheduler.windows === 4);
assert.equal(scheduler.warningUntil, 3900);

// Compare the same physical tones at the same time, including a switch back.
let baseline;
for (const rate of [44100, 48000, 96000, 44100]) {
    const frames = rate / 2;
    // A Live audio-engine restart may leave different sample-rate metadata on the buffer.
    vm.runInContext('engineRate(' + rate + ')', context);
    function tone(hertz) {
        return {framecount: () => frames, length: () => frames * 1000 / 44100, channelcount: () => 2,
            peek(channel, start, count) {
                return Float64Array.from({length: count}, (_, i) =>
                    0.25 * Math.sin(2 * Math.PI * hertz * (start + i - frames) / rate));
            }};
    }
    const result = measure(tone(70), tone(95));
    const counts = [0.33, 0.23, 0.16].map(limit => result.filter(b => b.warning >= limit).length);
    if (!baseline) baseline = result;
    assert.deepEqual(counts, [3, 4, 4]);
    result.forEach((b, i) => assert(Math.abs(b.warning - baseline[i].warning) < 0.002));
}
