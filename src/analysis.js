// Shared time-domain and spectral analysis for both input banks.
const bands = 80;
const warningCeilingHz = 18000;
const floor = -78;
const size = 4096;
const hz = b => 30 * Math.pow(600, b / (bands - 1));

const warningBandCount = 1 + Math.floor((bands - 1) * Math.log(warningCeilingHz / 30) / Math.log(600));

const activityFloor = Math.pow(10, -65 / 10);
// Use a decaying peak so the recording level alone does not determine whether a tail counts.
const relativeActivityFloor = Math.pow(10, -20 / 10);
const peakReleaseDbPerSecond = 18;
const warningThreshold = 0.16;

// Max runs this callback on Live's UI thread. Cross into compiled code once
// per transform or resampling block, never once per sample.
function loadDSP() {
    if (typeof WebAssembly !== 'object') return null;
    try {
        return new WebAssembly.Module(new Uint8Array(kernelBytes));
    } catch {
        // Some hosts expose WebAssembly but disable dynamic compilation.
        return null;
    }
}
const dspModule = loadDSP();

function dspWorkspace(layout) {
    if (!dspModule) return null;
    const {exports} = new WebAssembly.Instance(dspModule);
    let end = exports.__heap_base.value;
    const offsets = {};
    for (const [name, type, count] of layout) {
        end = Math.ceil(end / 8) * 8;
        offsets[name] = end;
        end += type.BYTES_PER_ELEMENT * count;
    }
    const extra = end - exports.memory.buffer.byteLength;
    if (extra > 0) exports.memory.grow(Math.ceil(extra / 65536));
    const result = {exports};
    for (const [name, type, count] of layout)
        result[name] = new type(exports.memory.buffer, offsets[name], count);
    return result;
}

// Reuse FFT workspaces for the display and the shorter overlap measurements.
function fftWorkspace(length) {
    const native = dspWorkspace([
        ['input', Float64Array, length], ['window', Float64Array, length],
        ['reversed', Int32Array, length], ['cos', Float64Array, length / 2],
        ['sin', Float64Array, length / 2], ['real', Float64Array, length],
        ['imag', Float64Array, length], ['power', Float64Array, length / 2]
    ]);
    const reversed = native?.reversed ?? new Int32Array(length);
    const cos = native?.cos ?? new Float64Array(length / 2);
    const sin = native?.sin ?? new Float64Array(length / 2);
    for (let i = 1; i < length; i++)
        reversed[i] = (reversed[i >> 1] >> 1) | ((i & 1) * (length >> 1));
    for (let i = 0; i < length / 2; i++) {
        cos[i] = Math.cos(-2 * Math.PI * i / length);
        sin[i] = Math.sin(-2 * Math.PI * i / length);
    }
    if (native) {
        for (let i = 0; i < length; i++)
            native.window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / length);
        return {...native, length};
    }
    return {length, reversed, cos, sin, real: new Float64Array(length),
        imag: new Float64Array(length), power: new Float64Array(length / 2),
        window: Float64Array.from({length}, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / length))};
}

const displayFFT = fftWorkspace(size);
const slices = 7;
const overlapFFT = fftWorkspace(size / 4);
const windowFn = displayFFT.window;

function accumulate(fft, input, offset) {
    const {length, reversed, cos, sin, real, imag, power, window} = fft;
    if (fft.exports) {
        fft.input.set(input.subarray(offset, offset + length));
        fft.exports.fftpower(fft.input.byteOffset, window.byteOffset, reversed.byteOffset,
            cos.byteOffset, sin.byteOffset, real.byteOffset, imag.byteOffset, power.byteOffset, length);
        return;
    }
    for (let i = 0; i < length; i++) real[reversed[i]] = window[i] * input[offset + i];
    imag.fill(0);
    for (let span = 2; span <= length; span *= 2) {
        const half = span / 2;
        for (let block = 0; block < length; block += span) {
            for (let j = 0; j < half; j++) {
                const a = block + j, b = a + half, w = j * length / span;
                const r = real[b] * cos[w] - imag[b] * sin[w];
                const t = real[b] * sin[w] + imag[b] * cos[w];
                real[b] = real[a] - r; imag[b] = imag[a] - t;
                real[a] += r; imag[a] += t;
            }
        }
    }
    for (let k = 0; k < power.length; k++)
        power[k] += real[k] * real[k] + imag[k] * imag[k];
}

function measureBands(fft, rate, left, right, offset, output, index) {
    const {length, power} = fft;
    power.fill(0);
    accumulate(fft, left, offset);
    accumulate(fft, right, offset);
    if (fft.rate !== rate) {
        fft.rate = rate;
        fft.edges = Array.from({length: bands + 1}, (_, b) =>
            Math.max(1, (b === bands ? Math.floor(warningCeilingHz * length / rate) + 1 : Math.round(hz(b - 0.5) * length / rate))));
    }
    for (let b = 0; b < bands; b++) {
        const lo = fft.edges[b], hi = Math.min(power.length, Math.max(lo + 1, fft.edges[b + 1]));
        let peak = 0;
        for (let k = lo; k < hi; k++) peak = Math.max(peak, power[k]);
        output[index + b] = Math.max(floor, 10 * Math.log10(1e-12 + peak * 8 / (length * length)));
    }
}

// Keep both FFTs on the 44.1 kHz time/frequency grid used for calibration.
const analysisRate = 44100;
// A short, frequency-selective energy envelope checks when the low notes sound.
// The long FFT still determines which display bands can warn. Two overlapping
// probes keep an upper harmonic from supplying timing evidence for a sub note.
const bassHop = 64;
const bassSteps = size / bassHop;
const bassDecimation = 16;
const bassProbes = [65, 130].map(frequency => {
    const half = Math.round(analysisRate / (frequency * bassDecimation));
    const cosine = [], sine = [], window = [];
    let dc = 0, total = 0;
    for (let k = -half; k <= half; k++) {
        const w = 0.5 + 0.5 * Math.cos(Math.PI * k / half);
        const phase = 2 * Math.PI * frequency * k * bassDecimation / analysisRate;
        window.push(w);
        cosine.push(w * Math.cos(phase));
        sine.push(w * Math.sin(phase));
        dc += cosine[cosine.length - 1];
        total += w;
    }
    for (let j = 0; j < cosine.length; j++) cosine[j] -= window[j] * dc / total;
    return {half, cosine, sine};
});
const bassWeights = Array.from({length: bands}, (_, b) => {
    const position = Math.max(0, Math.log2(hz(b) / 65));
    return [Math.max(0, 1 - position), Math.max(0, 1 - Math.abs(position - 1))];
});
const bassSamples = new Float64Array(size / bassDecimation);

const bassBandCount = bassWeights.findIndex(([low, upper]) => low + upper === 0);
// A fading protected note can occupy the same band as a much louder new note.
// Track its recent level locally. A sustained quiet note sets its own reference.
const bassPeakReleaseDbPerSecond = 48;
const bassTailAllowanceDb = 3;

const bassKernelSize = bassProbes[0].cosine.length;
const bassNative = dspWorkspace([
    ['input', Float64Array, size], ['samples', Float64Array, bassSamples.length],
    ['cosine', Float64Array, bassKernelSize * bassProbes.length],
    ['sine', Float64Array, bassKernelSize * bassProbes.length],
    ['power', Float64Array, bassSteps * bassProbes.length]
]);
if (bassNative) bassProbes.forEach((probe, i) => {
    bassNative.cosine.set(probe.cosine, i * bassKernelSize);
    bassNative.sine.set(probe.sine, i * bassKernelSize);
});

// Triangular low-pass before decimation (two box filters). Keep both stereo
// channels' power, including opposite polarity and hard-panned sources.
function addBassPower(input, envelopes) {
    if (bassNative) {
        const {input: block, samples, exports, cosine, sine} = bassNative;
        block.set(input);
        exports.decimate(block.byteOffset, samples.byteOffset, samples.length, bassDecimation);
        for (let p = 0; p < bassProbes.length; p++) {
            const offset = p * bassKernelSize * Float64Array.BYTES_PER_ELEMENT;
            exports.probepower(samples.byteOffset, samples.length, cosine.byteOffset + offset,
                sine.byteOffset + offset, bassProbes[p].half, bassHop / bassDecimation,
                envelopes.byteOffset + p * bassSteps * Float64Array.BYTES_PER_ELEMENT, bassSteps);
        }
        return;
    }
    let previousTail = 0;
    for (let i = 0; i < bassSamples.length; i++) {
        let head = 0, sum = 0;
        for (let k = 0; k < bassDecimation; k++) {
            const sample = input[i * bassDecimation + k];
            sum += sample;
            head += sum;
        }
        bassSamples[i] = (previousTail + head) / (bassDecimation * bassDecimation);
        previousTail = sum * bassDecimation - head;
    }
    for (let p = 0; p < bassProbes.length; p++) {
        const {half, cosine, sine} = bassProbes[p];
        for (let t = 0; t < bassSteps; t++) {
            const mid = (t + 0.5) * bassHop / bassDecimation;
            let re = 0, im = 0;
            const last = Math.min(half, bassSamples.length - 1 - mid);
            for (let k = Math.max(-half, -mid); k <= last; k++) {
                const sample = bassSamples[mid + k];
                re += sample * cosine[k + half];
                im += sample * sine[k + half];
            }
            envelopes[p * bassSteps + t] += re * re + im * im;
        }
    }
}

function measureBassTiming(source, left, right) {
    const envelopes = bassNative?.power ?? source.bassTiming;
    envelopes.fill(0);
    addBassPower(left, envelopes);
    addBassPower(right, envelopes);
    for (let p = 0; p < bassProbes.length; p++) {
        const offset = p * bassSteps;
        let energy = 0;
        for (let t = 0; t < bassSteps; t++) {
            envelopes[offset + t] *= windowFn[t * bassHop + bassHop / 2] ** 2;
            energy += envelopes[offset + t];
        }
        if (energy > 0) for (let t = 0; t < bassSteps; t++) envelopes[offset + t] /= energy;
    }
    if (bassNative) source.bassTiming.set(envelopes);
}

function bassCoincidence(first, second) {
    return bassProbes.map((_, p) => {
        let common = 0;
        for (let i = p * bassSteps; i < (p + 1) * bassSteps; i++)
            common += Math.min(first.bassTiming[i], second.bassTiming[i]);
        // Prototype calibration: retain full credit once half the normalized
        // energy profiles coincide. A hand-off gets proportionally less.
        return Math.min(1, 2 * common);
    });
}

let lastFormat, engineSampleRate = 0;
function bufferRate(buffer) {
    return engineSampleRate || buffer.framecount() * 1000 / buffer.length();
}
function analysisFormat(rate) {
    if (lastFormat?.rate === rate) return lastFormat;
    const step = rate / analysisRate;
    const radius = rate === analysisRate ? 0 : Math.ceil(24 * Math.max(1, step));
    const margin = Math.max(radius, Math.round(256 * step));
    const span = Math.ceil(size * step);
    const format = {rate, step, radius, span, margin, hop: size * 0.75 * step};
    if (radius) {
        // Cache fractional-delay Hann-windowed sinc kernels. Narrow the cutoff
        // when downsampling so ultrasonic input cannot fold into the warning bands.
        const cutoff = Math.min(1, 1 / step);
        format.offsets = new Int32Array(size);
        format.kernelAt = new Int32Array(size);
        format.kernels = Array.from({length: 257}, (_, phase) => {
            const taps = Float64Array.from({length: radius * 2}, (_, k) => {
                const x = k - radius + 1 - phase / 256;
                const sinc = x === 0 ? cutoff : Math.sin(Math.PI * cutoff * x) / (Math.PI * x);
                return sinc * (0.5 + 0.5 * Math.cos(Math.PI * x / radius));
            });
            const sum = taps.reduce((a, b) => a + b, 0);
            return taps.map(v => v / sum);
        });
        for (let i = 0; i < size; i++) {
            const pos = span - (size - i) * step;
            format.offsets[i] = Math.floor(pos) + 1;
            format.kernelAt[i] = Math.round((pos - Math.floor(pos)) * 256);
        }
        const taps = radius * 2;
        const native = dspWorkspace([
            ['input', Float64Array, span + taps], ['output', Float64Array, size],
            ['kernels', Float64Array, taps * format.kernels.length],
            ['offsets', Int32Array, size], ['phase', Int32Array, size]
        ]);
        if (native) {
            native.offsets.set(format.offsets);
            native.phase.set(format.kernelAt);
            format.kernels.forEach((kernel, i) => native.kernels.set(kernel, i * taps));
            format.native = native;
        }
    }
    return lastFormat = format;
}

function frame(buffer, channel, start, frames, format) {
    const {radius, span} = format;
    const count = span + 2 * radius;
    const first = Math.min(count, frames - start);
    let data = buffer.peek(channel, start, first);
    if (first < count) {
        const joined = new Float64Array(count);
        joined.set(first === 1 ? [data] : data);
        const rest = buffer.peek(channel, 0, count - first);
        joined.set(count - first === 1 ? [rest] : rest, first);
        data = joined;
    }
    if (!radius) return ArrayBuffer.isView(data) ? data : Float64Array.from(data);
    const native = format.native;
    if (native) {
        native.input.set(data);
        native.exports.resample(native.input.byteOffset, native.kernels.byteOffset,
            native.offsets.byteOffset, native.phase.byteOffset, native.output.byteOffset, size, radius * 2);
        // Both stereo channels must remain available until the FFTs have finished.
        return native.output.slice();
    }
    const output = new Float64Array(size);
    for (let i = 0; i < size; i++) {
        const offset = format.offsets[i], taps = format.kernels[format.kernelAt[i]];
        let sum = 0;
        for (let k = 0; k < taps.length; k++) sum += data[offset + k] * taps[k];
        output[i] = sum;
    }
    return output;
}

function analyze(source, buffer, phase, now, lag = 0) {
    const frames = buffer.framecount(), length = buffer.length();
    if (buffer.channelcount() !== 2 || !frames || length <= 0) return false;
    const format = analysisFormat(bufferRate(buffer));
    const history = format.span + format.margin + format.radius;
    if (frames <= history + lag) return false;
    const start = (frames + Math.floor(phase * frames) - history - lag) % frames;
    const left = frame(buffer, 1, start, frames, format);
    const right = frame(buffer, 2, start, frames, format);
    const rate = analysisRate;
    const samplePower = source.activity;
    let framePeak = 0;
    for (let n = 0; n < size; n++) {
        samplePower[n] = (left[n] * left[n] + right[n] * right[n]) / 2;
        framePeak = Math.max(framePeak, samplePower[n]);
    }
    const elapsed = Math.max(0, now - source.lastFrameTime) / 1000;
    source.lastFrameTime = now;
    const retention = Math.pow(10, -peakReleaseDbPerSecond * elapsed / 10);
    source.peakPower = Math.max(framePeak, source.peakPower * retention);
    const gate = Math.max(activityFloor, source.peakPower * relativeActivityFloor);
    source.energy = 0;
    for (let n = 0; n < size; n++) {
        samplePower[n] = Math.max(0, samplePower[n] - gate) * windowFn[n] ** 2;
        source.energy += samplePower[n];
    }
    if (framePeak <= 1e-12) source.spectrum.fill(floor);
    else measureBands(displayFFT, rate, left, right, 0, source.spectrum, 0);
    for (let b = 0; b < bassBandCount; b++) {
        source.bassPeakDb[b] = Math.max(source.spectrum[b],
            source.bassPeakDb[b] - elapsed * bassPeakReleaseDbPerSecond);
    }
    // Inactive frames cannot enter the overlap comparison.
    if (source.energy === 0) return true;
    measureBassTiming(source, left, right);
    for (let i = 0; i < slices; i++)
        measureBands(overlapFFT, rate, left, right, i * overlapFFT.length / 2, source.sliceDb, i * bands);
    return true;
}

function temporalOverlap(first, second) {
    if (!first.energy || !second.energy) return 0;
    const firstScale = 1 / first.energy, secondScale = 1 / second.energy;
    let overlap = 0;
    for (let n = 0; n < size; n++)
        overlap += Math.min(first.activity[n] * firstScale, second.activity[n] * secondScale);
    return Math.min(1, overlap);
}

function risk(target, other) {
    const strength = db => Math.min(1, Math.max(0, (db + 65) / 20));
    return strength(target) * strength(other) * Math.max(0, Math.min(1, (other - target + 18) / 24));
}

// The long FFT localizes a warning in frequency. Short, aligned windows decide
// whether both sources actually contributed energy there at the same time.
function referenceBandRisk(first, second, band, overlap) {
    if (band >= warningBandCount) return 0;
    const full = risk(first.spectrum[band], second.spectrum[band]);
    if (full * overlap < warningThreshold) return 0;
    let targetPeak = floor, otherPeak = floor;
    for (let i = band; i < slices * bands; i += bands) {
        targetPeak = Math.max(targetPeak, first.sliceDb[i]);
        otherPeak = Math.max(otherPeak, second.sliceDb[i]);
    }
    let shared = 0, targetEnergy = 0;
    for (let i = band; i < slices * bands; i += bands) {
        const target = first.sliceDb[i], other = second.sliceDb[i];
        const weight = Math.pow(10, (target - targetPeak) / 10);
        targetEnergy += weight;
        // Attenuate the tapered edges between two alternating notes.
        const simultaneous = Math.min(weight, Math.pow(10, (other - otherPeak) / 10));
        shared += simultaneous * risk(target, other);
    }
    const score = Math.min(full * overlap, shared / targetEnergy);
    return score >= warningThreshold ? score : 0;
}

function bandRisk(first, second, band, overlap, coincidence) {
    const referenceScore = referenceBandRisk(first, second, band, overlap);
    if (!referenceScore) return 0;
    const [low, upper] = bassWeights[band];
    if (!(low + upper)) return referenceScore;
    const factors = coincidence ?? bassCoincidence(first, second);
    const fadeDb = Math.max(0, first.bassPeakDb[band] - first.spectrum[band] - bassTailAllowanceDb);
    const prominence = Math.pow(10, -fadeDb / 20);
    const score = referenceScore * (1 - low - upper + prominence * (low * factors[0] + upper * factors[1]));
    return score >= warningThreshold ? score : 0;
}
