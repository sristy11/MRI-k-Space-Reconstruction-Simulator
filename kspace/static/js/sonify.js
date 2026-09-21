/*
 * K-SPACE sonification
 * --------------------
 * Turns the images in the console (source, k-space, undersampled k-space,
 * mask, reconstruction, error map) into sound, and lets you compare two of
 * them by ear.
 *
 * Two mappings:
 *
 *   spectral  every image row is a pitch (top = high, bottom = low) and the
 *             image is played left -> right as time. Brightness = volume.
 *             A bright horizontal line is a steady note, a bright vertical
 *             line is a burst of many notes at once, and noise is a hiss
 *             across all pitches.
 *
 *   contour   one voice follows the image left -> right. Pitch = where the
 *             brightness is concentrated in that column (top = high),
 *             volume = how bright the column is on average.
 *
 * The file has two halves: pure functions (resample / render / WAV export,
 * no browser needed) and the "Sound" tab, which builds itself inside
 * #soundLab and only runs in a browser. It also draws four graphs:
 * a pitch-time map for each sound, an overlaid waveform, and a pitch profile.
 */
(function (root) {
    "use strict";

    // ------------------------------------------------------------------
    // constants
    // ------------------------------------------------------------------
    const SAMPLE_RATE = 22050;
    const BANDS = 48;          // pitch resolution (image rows are averaged into this many bands)
    const STEPS = 96;          // time resolution (image columns are averaged into this many steps)
    const F_LOW = 110;         // Hz, bottom row  (A2)
    const F_HIGH = 3520;       // Hz, top row     (A7) -> 5 octaves
    const GAMMA = 1.5;         // brightness -> loudness curve (emphasises bright detail over faint haze)
    const GAP_SECONDS = 0.6;   // silence between sound 1 and sound 2 in "one after the other"
    const DIFF_MIN_RANGE = 0.2; // difference sound is boosted up to 5x so small differences are audible

    // ------------------------------------------------------------------
    // pure functions
    // ------------------------------------------------------------------

    // Frequency of a band. index 0 = top row = highest pitch. Fractional
    // indices are allowed (used by the contour mapping).
    function bandFreq(index, bands) {
        bands = bands || BANDS;
        const t = bands > 1 ? index / (bands - 1) : 0;
        return F_LOW * Math.pow(F_HIGH / F_LOW, 1 - t);
    }

    function clamp01(v) {
        return v < 0 ? 0 : v > 1 ? 1 : v;
    }

    // Area-average a w x h image (Float32Array, row-major, values 0..1) down to
    // bands x steps. Result is band-major: out[band * steps + step].
    function resample(data, w, h, bands, steps) {
        bands = bands || BANDS;
        steps = steps || STEPS;
        const out = new Float32Array(bands * steps);
        for (let b = 0; b < bands; b++) {
            const y0 = Math.floor((b * h) / bands);
            const y1 = Math.min(h, Math.max(y0 + 1, Math.floor(((b + 1) * h) / bands)));
            for (let s = 0; s < steps; s++) {
                const x0 = Math.floor((s * w) / steps);
                const x1 = Math.min(w, Math.max(x0 + 1, Math.floor(((s + 1) * w) / steps)));
                let sum = 0;
                let count = 0;
                for (let y = y0; y < y1; y++) {
                    for (let x = x0; x < x1; x++) {
                        sum += data[y * w + x];
                        count++;
                    }
                }
                out[b * steps + s] = count ? sum / count : 0;
            }
        }
        return out;
    }

    function absDiff(a, b) {
        const out = new Float32Array(a.length);
        let max = 0;
        for (let i = 0; i < a.length; i++) {
            out[i] = Math.abs(a[i] - b[i]);
            if (out[i] > max) max = out[i];
        }
        // Boost small differences (up to 5x) so they can be heard; identical
        // inputs stay exactly silent because max is 0.
        if (max > 0) {
            const gain = 1 / Math.max(max, DIFF_MIN_RANGE);
            for (let i = 0; i < out.length; i++) out[i] = clamp01(out[i] * gain);
        }
        return out;
    }

    // Fixed, per-band phase so the same picture always gives the same sound
    // (needed for a fair A/B comparison) without all bands starting in phase.
    function bandPhase(b) {
        const x = Math.sin((b + 1) * 12.9898) * 43758.5453;
        return 2 * Math.PI * (x - Math.floor(x));
    }

    function finalize(out, sampleRate) {
        const n = out.length;
        for (let i = 0; i < n; i++) out[i] = Math.tanh(out[i]);   // soft limiter
        const fade = Math.min(Math.floor(0.015 * sampleRate), n >> 1);
        for (let i = 0; i < fade; i++) {
            const g = i / fade;
            out[i] *= g;
            out[n - 1 - i] *= g;
        }
        return out;
    }

    // spectral mapping: row -> pitch, brightness -> volume, column -> time
    function renderSpectral(mat, duration, opts) {
        opts = opts || {};
        const bands = opts.bands || BANDS;
        const steps = opts.steps || STEPS;
        const sr = opts.sampleRate || SAMPLE_RATE;
        const n = Math.max(1, Math.round(duration * sr));
        const out = new Float32Array(n);
        const stepLen = n / steps;
        const norm = 0.9 / Math.sqrt(bands);
        const amps = new Float32Array(steps);

        for (let b = 0; b < bands; b++) {
            let peak = 0;
            for (let s = 0; s < steps; s++) {
                const a = Math.pow(clamp01(mat[b * steps + s]), GAMMA);
                amps[s] = a;
                if (a > peak) peak = a;
            }
            if (peak < 1e-4) continue;   // silent row

            const w = (2 * Math.PI * bandFreq(b, bands)) / sr;
            const ph = bandPhase(b);
            for (let i = 0; i < n; i++) {
                // amplitude glides linearly between the centres of neighbouring time steps
                const pos = i / stepLen - 0.5;
                const s0 = Math.floor(pos);
                const fr = pos - s0;
                const i0 = s0 < 0 ? 0 : s0 >= steps ? steps - 1 : s0;
                const i1 = s0 + 1 < 0 ? 0 : s0 + 1 >= steps ? steps - 1 : s0 + 1;
                out[i] += norm * (amps[i0] + (amps[i1] - amps[i0]) * fr) * Math.sin(ph + w * i);
            }
        }
        return finalize(out, sr);
    }

    // contour mapping: one voice; pitch = brightness centroid of the column,
    // volume = mean brightness of the column
    function renderContour(mat, duration, opts) {
        opts = opts || {};
        const bands = opts.bands || BANDS;
        const steps = opts.steps || STEPS;
        const sr = opts.sampleRate || SAMPLE_RATE;
        const n = Math.max(1, Math.round(duration * sr));
        const out = new Float32Array(n);
        const stepLen = n / steps;

        const logF = new Float64Array(steps);
        const vol = new Float64Array(steps);
        let lastLog = Math.log(bandFreq((bands - 1) / 2, bands));
        for (let s = 0; s < steps; s++) {
            let sum = 0;
            let weighted = 0;
            for (let b = 0; b < bands; b++) {
                const v = clamp01(mat[b * steps + s]);
                sum += v;
                weighted += v * b;
            }
            if (sum > 1e-6) lastLog = Math.log(bandFreq(weighted / sum, bands));
            logF[s] = lastLog;
            const mean = sum / bands;
            vol[s] = Math.min(1, Math.pow(mean, 0.7) * 1.3) * 0.45;
        }

        let phase = 0;
        for (let i = 0; i < n; i++) {
            const pos = i / stepLen - 0.5;
            const s0 = Math.floor(pos);
            const fr = pos - s0;
            const i0 = s0 < 0 ? 0 : s0 >= steps ? steps - 1 : s0;
            const i1 = s0 + 1 < 0 ? 0 : s0 + 1 >= steps ? steps - 1 : s0 + 1;
            const f = Math.exp(logF[i0] + (logF[i1] - logF[i0]) * fr);
            const v = vol[i0] + (vol[i1] - vol[i0]) * fr;
            phase += (2 * Math.PI * f) / sr;
            out[i] = (v * (Math.sin(phase) + 0.35 * Math.sin(2 * phase) + 0.15 * Math.sin(3 * phase))) / 1.5;
        }
        return finalize(out, sr);
    }

    function render(mat, duration, mapping, opts) {
        return mapping === "contour" ? renderContour(mat, duration, opts) : renderSpectral(mat, duration, opts);
    }

    // 16-bit PCM WAV. channels = array of Float32Array (all the same length).
    function encodeWav(channels, sampleRate) {
        sampleRate = sampleRate || SAMPLE_RATE;
        const nch = channels.length;
        const n = channels[0].length;
        const buffer = new ArrayBuffer(44 + n * nch * 2);
        const view = new DataView(buffer);
        const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
        str(0, "RIFF");
        view.setUint32(4, 36 + n * nch * 2, true);
        str(8, "WAVE");
        str(12, "fmt ");
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, nch, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * nch * 2, true);
        view.setUint16(32, nch * 2, true);
        view.setUint16(34, 16, true);
        str(36, "data");
        view.setUint32(40, n * nch * 2, true);
        let off = 44;
        for (let i = 0; i < n; i++) {
            for (let c = 0; c < nch; c++) {
                const v = Math.max(-1, Math.min(1, channels[c][i]));
                view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
                off += 2;
            }
        }
        return buffer;
    }

    const api = {
        SAMPLE_RATE, BANDS, STEPS, F_LOW, F_HIGH, GAP_SECONDS,
        bandFreq, resample, absDiff, renderSpectral, renderContour, render, encodeWav,
    };

    root.KSonify = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (typeof document === "undefined") return;   // Node / tests: pure functions only

    // ------------------------------------------------------------------
    // "Sound" tab (browser only)
    // ------------------------------------------------------------------

    // The six pictures in the console. `array` = exact data when the app keeps
    // it; otherwise we read the pixels of the canvas that is on screen.
    // (The error map uses the "hot" colormap, where (r+g+b)/765 is exactly the
    // original 0..1 value, so reading pixels loses nothing but 8-bit rounding.)
    const BUILTIN = [
        { key: "source", name: "Source image",         letter: "A", canvas: "canvasOriginal",    empty: "emptyOriginal" },
        { key: "kfull",  name: "k-space, full",        letter: "B", canvas: "canvasKspaceFull",  empty: "emptyKspaceFull",  array: () => window.LAST_KSPACE_FULL },
        { key: "kunder", name: "Undersampled k-space", letter: "C", canvas: "canvasKspaceUnder", empty: "emptyKspaceUnder" },
        { key: "mask",   name: "Sampling mask",        letter: "D", canvas: "canvasMask",        empty: "emptyMask" },
        { key: "recon",  name: "Reconstruction",       letter: "E", canvas: "canvasRecon",       empty: "emptyRecon",       array: () => window.LAST_RECON },
        { key: "error",  name: "Error map",            letter: "F", canvas: "canvasError",       empty: "emptyError" },
    ];

    const MAPPINGS = [
        { value: "spectral", text: "Spectral (row = pitch)" },
        { value: "contour",  text: "Contour (one moving voice)" },
    ];

    const MODES = [
        { value: "then",   text: "One after the other" },
        { value: "stereo", text: "Together (1 left, 2 right)" },
        { value: "live",   text: "Live switch (jump 1 / 2)" },
        { value: "diff",   text: "Difference only" },
    ];

    const COL = { one: "#38BDF8", two: "#F5A524", diff: "#C4B5FD", text: "#8593A6", grid: "rgba(255,255,255,0.07)", plot: "#070A0F", bg: "#0B1017" };

    function makeLut(stops) {
        const lut = new Uint8Array(256 * 3);
        for (let i = 0; i < 256; i++) {
            const t = i / 255;
            let k = 0;
            while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
            const [t0, c0] = stops[k];
            const [t1, c1] = stops[k + 1];
            const f = Math.max(0, Math.min(1, (t - t0) / (t1 - t0 || 1)));
            for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.round(c0[c] + (c1[c] - c0[c]) * f);
        }
        return lut;
    }
    const LUT1 = makeLut([[0, [7, 12, 22]], [0.5, [24, 96, 160]], [0.82, [70, 190, 250]], [1, [236, 250, 255]]]);   // ice   (sound 1)
    const LUT2 = makeLut([[0, [16, 9, 4]],  [0.5, [170, 96, 8]],  [0.82, [248, 176, 46]], [1, [255, 244, 216]]]);   // amber (sound 2)

    const LUT3 = makeLut([[0, [9, 6, 20]],  [0.5, [96, 60, 190]], [0.82, [176, 150, 245]], [1, [245, 240, 255]]]);   // violet (difference)

    const MAX_SNAPSHOTS = 6;
    const snapshots = [];
    let snapshotCounter = 0;

    let audio = null;         // AudioContext
    let masterNode = null;    // current master GainNode (so the volume slider works while playing)
    let playing = null;       // { stop(), setLive() } for the current playback
    let lastRender = null;    // { channels, name } for the WAV export

    const S = { p1: null, p2: null, diff: null };   // prepared sounds (cached) + optional difference sound
    const geom = {};                                 // plot rectangles per chart (for playheads)

    const $ = (id) => document.getElementById(id);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // ---------- reading the pictures ----------
    function isReady(def) {
        const el = $(def.empty);
        return !!el && el.style.display === "none";
    }

    function currentParamsText() {
        if (typeof pipelineParams === "undefined") return "";
        const p = pipelineParams;
        const parts = [];
        if (p.pattern && p.pattern !== "full" && p.pattern !== "custom") parts.push(`${p.pattern} ×${p.acceleration}`);
        else if (p.pattern) parts.push(p.pattern);
        if (p.noise_level > 0) parts.push(`noise ${Number(p.noise_level).toFixed(1)}%`);
        return parts.join(" · ");
    }

    function arrayToImage(array2d) {
        const h = array2d.length;
        const w = array2d[0].length;
        const data = new Float32Array(w * h);
        for (let y = 0; y < h; y++) {
            const row = array2d[y];
            for (let x = 0; x < w; x++) {
                const v = Number(row[x]);
                data[y * w + x] = Number.isFinite(v) ? clamp01(v) : 0;
            }
        }
        return { data, w, h };
    }

    // The renderers fade new images in; wait for that to finish so we read the final picture.
    async function settle(canvas) {
        for (let i = 0; i < 40; i++) {
            if (typeof canvasAnimations === "undefined" || !canvasAnimations.has(canvas)) return;
            await sleep(50);
        }
    }

    async function canvasToImage(canvas) {
        await settle(canvas);
        const w = canvas.width;
        const h = canvas.height;
        const px = canvas.getContext("2d").getImageData(0, 0, w, h).data;
        const data = new Float32Array(w * h);
        let any = false;
        for (let i = 0, j = 0; i < data.length; i++, j += 4) {
            if (px[j + 3] > 0) any = true;
            data[i] = (px[j] + px[j + 1] + px[j + 2]) / 765;
        }
        return any ? { data, w, h } : null;
    }

    async function readSource(key) {
        const snap = snapshots.find((s) => s.key === key);
        if (snap) return { data: snap.data, w: snap.w, h: snap.h, label: snap.label };

        const def = BUILTIN.find((d) => d.key === key);
        if (!def || !isReady(def)) return null;
        const label = `${def.name} (${def.letter})`;

        const arr = def.array ? def.array() : null;
        if (arr && arr.length && arr[0] && arr[0].length) return Object.assign(arrayToImage(arr), { label });

        const img = await canvasToImage($(def.canvas));
        return img ? Object.assign(img, { label }) : null;
    }

    // ---------- statistics ----------
    function levelStats(mat, samples) {
        let s = 0;
        for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
        const rms = Math.sqrt(s / Math.max(1, samples.length));
        let ws = 0;
        let wl = 0;
        let active = 0;
        for (let b = 0; b < BANDS; b++) {
            let row = 0;
            for (let t = 0; t < STEPS; t++) {
                const v = mat[b * STEPS + t];
                row += v;
                if (v > 0.05) active++;
            }
            row /= STEPS;
            ws += row;
            wl += row * Math.log(bandFreq(b));
        }
        return {
            db: rms > 1e-9 ? 20 * Math.log10(rms) : -Infinity,
            centre: ws > 1e-9 ? Math.exp(wl / ws) : null,          // brightness-weighted pitch centre, Hz
            active: active / (BANDS * STEPS),                       // share of the picture that makes sound
        };
    }

    function checksum(mat) {
        let s = 0;
        for (let i = 0; i < mat.length; i += 7) s += mat[i] * ((i % 89) + 1);
        return s.toFixed(5);
    }

    const fmtDb = (db) => (db === -Infinity ? "silent" : `${db.toFixed(1)} dB`);
    const fmtHz = (f) => (f === null ? "—" : f >= 1000 ? `${(f / 1000).toFixed(2)} kHz` : `${Math.round(f)} Hz`);
    const sign = (v) => (v > 0 ? "+" : v < 0 ? "−" : "±");

    // ---------- styles ----------
    function injectStyles() {
        if ($("sonifyStyles")) return;
        const css = `
        .sl{display:flex;flex-direction:column;gap:14px}
        .sl-card{background:var(--panel,#10161F);border:1px solid var(--line,#232D3B);border-radius:14px;padding:16px}
        .sl-strips{display:grid;grid-template-columns:minmax(0,1fr) 158px minmax(0,1fr);gap:14px;align-items:stretch}
        .sl-strip{position:relative;display:flex;gap:14px;align-items:center;padding:14px 14px 14px 18px;border:1px solid var(--line,#232D3B);border-radius:12px;background:var(--panel-2,#151C27);overflow:hidden}
        .sl-strip::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--c)}
        .sl-strip--1{--c:${COL.one}} .sl-strip--2{--c:${COL.two}}
        .sl-thumb{flex:none;width:88px;height:88px;border-radius:9px;background:#000;border:1px solid var(--line,#232D3B);overflow:hidden}
        .sl-thumb canvas{display:block;width:100%;height:100%}
        .sl-strip__body{flex:1;min-width:0;display:flex;flex-direction:column;gap:9px}
        .sl-strip__title{white-space:nowrap;display:flex;align-items:center;gap:8px;font-size:11px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--text-2,#A7B3C4)}
        .sl-chip{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:6px;background:var(--c);color:#06121A;font-family:var(--font-mono,monospace);font-size:11px;font-weight:700;letter-spacing:0}
        .sl-stats{display:flex;flex-wrap:wrap;gap:3px 14px;font-family:var(--font-mono,monospace);font-size:11px;color:var(--text-3,#6F7C8F)}
        .sl-stats b{color:var(--text,#E8EEF6);font-weight:600}
        .sl-select{appearance:none;-webkit-appearance:none;width:100%;height:36px;padding:0 32px 0 11px;border:1px solid var(--line-strong,#34435A);border-radius:8px;background-color:var(--panel,#10161F);color:var(--text,#E8EEF6);font-size:12.5px;cursor:pointer;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236F7C8F' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center}
        .sl-select:hover{border-color:#46587A}
        .sl-compare{display:flex;flex-direction:column;align-items:stretch;justify-content:center;gap:7px;text-align:center}
        .sl-swap{align-self:center;height:30px;padding:0 12px;border:1px solid var(--line-strong,#34435A);border-radius:8px;background:var(--panel-2,#151C27);color:var(--text-2,#A7B3C4);font-size:12px;font-weight:500;cursor:pointer}
        .sl-swap:hover{background:var(--panel-3,#1C2634);color:var(--text,#E8EEF6)}
        .sl-delta{padding:6px 8px;border:1px solid var(--line-soft,#19212C);border-radius:8px;background:var(--panel,#10161F)}
        .sl-delta span{display:block;font-size:9.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3,#6F7C8F)}
        .sl-delta b{display:block;margin-top:1px;font-family:var(--font-mono,monospace);font-size:12.5px;font-weight:600;color:var(--text,#E8EEF6)}
        .sl-transport{display:flex;flex-direction:column;gap:16px}
        .sl-buttons{display:flex;flex-wrap:wrap;gap:8px}
        .sl-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:40px;padding:0 18px;border:1px solid var(--line-strong,#34435A);border-radius:10px;background:var(--panel-2,#151C27);color:var(--text,#E8EEF6);font-size:13px;font-weight:600;cursor:pointer;transition:background .14s,border-color .14s,transform .06s}
        .sl-btn:hover{background:var(--panel-3,#1C2634);border-color:#4A5C7C}
        .sl-btn:active{transform:translateY(1px)}
        .sl-btn svg{width:14px;height:14px;fill:currentColor;flex:none}
        .sl-btn--play{border-color:transparent;background:linear-gradient(180deg,#34E0CB,#14B8A6);color:#04231F;box-shadow:0 6px 18px rgba(20,184,166,.28)}
        .sl-btn--play:hover{background:linear-gradient(180deg,#5EEAD4,#19C9B3);border-color:transparent}
        .sl-btn--cmp{border-color:rgba(245,165,36,.5);background:rgba(245,165,36,.1);color:${COL.two}}
        .sl-btn--cmp:hover{background:rgba(245,165,36,.18);border-color:${COL.two}}
        .sl-btn--small{height:32px;padding:0 13px;font-size:12px;font-weight:500;border-radius:8px}
        .sl-opts{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px 18px}
        .sl-opt label,.sl-opt .sl-opt__lab{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;font-size:11.5px;font-weight:500;color:var(--text-2,#A7B3C4)}
        .sl-opt .sl-opt__val{padding:1px 7px;border-radius:6px;background:var(--panel-3,#1C2634);border:1px solid var(--line,#232D3B);font-family:var(--font-mono,monospace);font-size:10.5px;color:var(--text,#E8EEF6)}
        .sl-switch{display:none;gap:10px;margin-top:2px}
        .sl-switch.is-visible{display:flex}
        .sl-hear{flex:1;height:46px;border:1px solid var(--line-strong,#34435A);border-radius:11px;background:var(--panel-2,#151C27);color:var(--text-2,#A7B3C4);font-size:13px;font-weight:600;cursor:pointer;transition:all .12s}
        .sl-hear[data-side="1"].is-on{background:rgba(56,189,248,.16);border-color:${COL.one};color:${COL.one}}
        .sl-hear[data-side="2"].is-on{background:rgba(245,165,36,.16);border-color:${COL.two};color:${COL.two}}
        .sl-graphs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
        .sl-fig{margin:0;padding:12px 12px 8px;border:1px solid var(--line,#232D3B);border-radius:12px;background:var(--panel,#10161F);min-width:0}
        .sl-fig__cap{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;font-size:12px;font-weight:600;color:var(--text,#E8EEF6)}
        .sl-fig__cap small{font-weight:400;font-size:10.5px;color:var(--text-3,#6F7C8F);white-space:nowrap}
        .sl-dot{display:inline-block;width:8px;height:8px;margin-right:7px;border-radius:50%;background:var(--c)}
        .sl-fig__frame{position:relative;height:196px}
        .sl-fig--full{grid-column:1/-1}
        .sl-fig--full .sl-fig__frame{height:150px}
        .sl-fig__frame canvas{display:block;width:100%;height:100%}
        .sl-head{position:absolute;width:2px;margin-left:-1px;background:#FFB020;box-shadow:0 0 8px #FFB020;display:none;pointer-events:none}
        .sl-foot{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px}
        .sl-status{flex:1;min-width:240px;margin:0;font-size:12px;line-height:1.5;color:var(--text-2,#A7B3C4)}
        .sl-hint{margin:0;font-size:11px;line-height:1.55;color:var(--text-3,#6F7C8F)}
        @media (max-width:1180px){.sl-strips{grid-template-columns:1fr}.sl-compare{flex-direction:row;flex-wrap:wrap;justify-content:center}.sl-delta{flex:1;min-width:110px}}
        @media (max-width:900px){.sl-graphs{grid-template-columns:1fr}}
        `;
        const style = document.createElement("style");
        style.id = "sonifyStyles";
        style.textContent = css;
        document.head.appendChild(style);
    }

    const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
    const ICON_STOP = '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="1.5"/></svg>';
    const ICON_CMP  = '<svg viewBox="0 0 24 24"><path d="M3 12h4l3-8 4 16 3-8h4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    function buildLab(host) {
        host.innerHTML = `
        <div class="sl" id="sonifyPanel">

          <div class="sl-card">
            <div class="sl-strips">
              <div class="sl-strip sl-strip--1">
                <div class="sl-thumb"><canvas id="slThumb1" width="88" height="88"></canvas></div>
                <div class="sl-strip__body">
                  <div class="sl-strip__title"><span class="sl-chip">1</span>Sound 1</div>
                  <select id="sonSel1" class="sl-select" aria-label="picture for sound 1"></select>
                  <div class="sl-stats" id="slStats1"><span>choose a picture</span></div>
                </div>
              </div>

              <div class="sl-compare">
                <button type="button" class="sl-swap" id="sonSwap" title="swap sound 1 and sound 2">⇄ swap</button>
                <div class="sl-delta"><span>loudness 2 vs 1</span><b id="slDLoud">—</b></div>
                <div class="sl-delta"><span>pitch centre</span><b id="slDPitch">—</b></div>
                <div class="sl-delta"><span>difference</span><b id="slDSim">—</b></div>
              </div>

              <div class="sl-strip sl-strip--2">
                <div class="sl-thumb"><canvas id="slThumb2" width="88" height="88"></canvas></div>
                <div class="sl-strip__body">
                  <div class="sl-strip__title"><span class="sl-chip">2</span>Sound 2</div>
                  <select id="sonSel2" class="sl-select" aria-label="picture for sound 2"></select>
                  <div class="sl-stats" id="slStats2"><span>optional</span></div>
                </div>
              </div>
            </div>
          </div>

          <div class="sl-card">
            <div class="sl-transport">
              <div class="sl-buttons">
                <button type="button" class="sl-btn sl-btn--play" id="sonPlay1">${ICON_PLAY}<span>Play sound 1</span></button>
                <button type="button" class="sl-btn sl-btn--cmp" id="sonCompare">${ICON_CMP}<span>Compare 1 vs 2</span></button>
                <button type="button" class="sl-btn" id="sonStop">${ICON_STOP}<span>Stop</span></button>
              </div>
              <div class="sl-opts">
                <div class="sl-opt"><label for="sonMapping">Data → sound</label><select id="sonMapping" class="sl-select">${MAPPINGS.map((m) => `<option value="${m.value}">${m.text}</option>`).join("")}</select></div>
                <div class="sl-opt"><label for="sonMode">Compare mode</label><select id="sonMode" class="sl-select">${MODES.map((m) => `<option value="${m.value}">${m.text}</option>`).join("")}</select></div>
                <div class="sl-opt"><div class="sl-opt__lab"><span>Duration</span><span class="sl-opt__val" id="sonDurValue">6 s</span></div><input type="range" id="sonDur" min="3" max="15" step="1" value="6" class="slider"></div>
                <div class="sl-opt"><div class="sl-opt__lab"><span>Volume</span><span class="sl-opt__val" id="sonVolValue">60%</span></div><input type="range" id="sonVol" min="0" max="100" step="1" value="60" class="slider"></div>
              </div>
            </div>
            <div class="sl-switch" id="sonSwitch" style="margin-top:14px">
              <button type="button" class="sl-hear is-on" id="sonHear1" data-side="1">Hearing sound 1 · key 1</button>
              <button type="button" class="sl-hear" id="sonHear2" data-side="2">Hearing sound 2 · key 2</button>
            </div>
          </div>

          <div class="sl-graphs">
            <figure class="sl-fig">
              <figcaption class="sl-fig__cap"><span><i class="sl-dot" style="--c:${COL.one}"></i>Pitch–time map · sound 1</span><small>brightness = volume</small></figcaption>
              <div class="sl-fig__frame"><canvas id="slMap1"></canvas><div class="sl-head" id="sonHead1"></div></div>
            </figure>
            <figure class="sl-fig">
              <figcaption class="sl-fig__cap"><span><i class="sl-dot" style="--c:${COL.two}"></i>Pitch–time map · sound 2</span><small>brightness = volume</small></figcaption>
              <div class="sl-fig__frame"><canvas id="slMap2"></canvas><div class="sl-head" id="sonHead2"></div></div>
            </figure>
            <figure class="sl-fig">
              <figcaption class="sl-fig__cap"><span id="slWaveCap"><i class="sl-dot" style="--c:${COL.one}"></i><i class="sl-dot" style="--c:${COL.two}"></i>Waveform · 1 vs 2</span><small>same scale</small></figcaption>
              <div class="sl-fig__frame"><canvas id="slWave"></canvas><div class="sl-head" id="sonHeadW"></div></div>
            </figure>
            <figure class="sl-fig">
              <figcaption class="sl-fig__cap"><span><i class="sl-dot" style="--c:${COL.one}"></i><i class="sl-dot" style="--c:${COL.two}"></i>Pitch profile · 1 vs 2</span><small>average level per pitch</small></figcaption>
              <div class="sl-fig__frame"><canvas id="slProfile"></canvas></div>
            </figure>
            <figure class="sl-fig sl-fig--full">
              <figcaption class="sl-fig__cap"><span><i class="sl-dot" style="--c:${COL.diff}"></i>Where the two sounds differ · |1 − 2|</span><small>brighter = bigger difference (boosted up to ×5)</small></figcaption>
              <div class="sl-fig__frame"><canvas id="slMapD"></canvas><div class="sl-head" id="sonHeadD"></div></div>
            </figure>
          </div>

          <div class="sl-foot">
            <p class="sl-status" id="sonStatus">Pick a picture for sound 1 and press play. Add a sound 2 to compare.</p>
            <button type="button" class="sl-btn sl-btn--small" id="sonSnap">📌 Save sound 1 as snapshot</button>
            <button type="button" class="sl-btn sl-btn--small" id="sonWav">⬇ Export .wav</button>
          </div>
          <p class="sl-hint" id="slHint"></p>
        </div>`;
    }

    let sel1, sel2, mapSel, modeSel, durSlider, volSlider, statusEl;
    let lastSignature = "";

    function setStatus(text) {
        statusEl.textContent = text;
    }

    function paintRange(el) {
        const min = parseFloat(el.min) || 0;
        const max = parseFloat(el.max) || 100;
        el.style.setProperty("--p", `${((parseFloat(el.value) - min) / (max - min)) * 100}%`);
    }

    function pageActive() {
        const page = $("pageSound");
        return !!page && page.classList.contains("is-active");
    }

    // ---------- option lists ----------
    function optionSpecs(withNone) {
        const specs = [];
        if (withNone) specs.push({ value: "", text: "— none —" });
        BUILTIN.forEach((d) => specs.push({ value: d.key, text: `${d.name} (${d.letter})${isReady(d) ? "" : "  · not ready yet"}` }));
        snapshots.forEach((s) => specs.push({ value: s.key, text: `📌 ${s.label}` }));
        return specs;
    }

    function refreshOptions(force) {
        const specs1 = optionSpecs(false);
        const specs2 = optionSpecs(true);
        const signature = JSON.stringify([specs1, specs2]);
        if (!force && signature === lastSignature) return false;
        lastSignature = signature;

        const fill = (sel, specs) => {
            const keep = sel.value;
            sel.innerHTML = "";
            specs.forEach((s) => {
                const o = document.createElement("option");
                o.value = s.value;
                o.textContent = s.text;
                sel.appendChild(o);
            });
            if (specs.some((s) => s.value === keep)) sel.value = keep;
        };
        fill(sel1, specs1);
        fill(sel2, specs2);
        return true;
    }

    // ---------- preparing sounds (cached) ----------
    async function prepare(key, slot) {
        if (!key) return null;
        const src = await readSource(key);
        if (!src) return { key, missing: true };
        const mapping = mapSel.value;
        const dur = parseInt(durSlider.value, 10);
        const mat = resample(src.data, src.w, src.h);
        const sig = `${key}|${mapping}|${dur}|${checksum(mat)}`;
        const prev = S["p" + slot];
        if (prev && prev.sig === sig) return prev;
        const samples = render(mat, dur, mapping);
        return { key, label: src.label, src, mat, audio: samples, sig, stats: levelStats(mat, samples) };
    }

    let refreshTimer = 0;
    let refreshing = false;
    let refreshAgain = false;
    let stale = true;

    function scheduleRefresh(ms) {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(refreshGraphs, ms === undefined ? 200 : ms);
    }

    async function refreshGraphs() {
        if (!pageActive() || playing) { stale = true; return; }   // draw when the tab is visible and idle
        if (refreshing) { refreshAgain = true; return; }
        refreshing = true;
        try {
            do {
                refreshAgain = false;
                const p1 = await prepare(sel1.value, 1);
                const p2 = await prepare(sel2.value, 2);
                S.p1 = p1;
                S.p2 = p2;
                S.diff = null;
                drawAll();
            } while (refreshAgain);
            stale = false;
        } finally {
            refreshing = false;
        }
    }

    // ---------- canvas helpers ----------
    function fitCanvas(canvas) {
        const r = canvas.getBoundingClientRect();
        if (r.width < 20 || r.height < 20) return null;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const W = Math.round(r.width * dpr);
        const H = Math.round(r.height * dpr);
        if (canvas.width !== W) canvas.width = W;
        if (canvas.height !== H) canvas.height = H;
        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { ctx, w: r.width, h: r.height };
    }

    const M = { l: 46, r: 10, t: 8, b: 22 };   // plot margins (CSS px)
    const FONT = '10px "JetBrains Mono", ui-monospace, monospace';
    const fmtTick = (f) => (f >= 1000 ? `${(f / 1000).toFixed(1).replace(".0", "")}k` : `${f}`);
    const PITCH_TICKS = [110, 220, 440, 880, 1760, 3520];

    function frame(id) {
        const canvas = $(id);
        const g = fitCanvas(canvas);
        if (!g) return null;
        const { ctx, w, h } = g;
        ctx.fillStyle = COL.bg;
        ctx.fillRect(0, 0, w, h);
        const pw = w - M.l - M.r;
        const ph = h - M.t - M.b;
        ctx.fillStyle = COL.plot;
        ctx.fillRect(M.l, M.t, pw, ph);
        geom[id] = { x0: M.l, x1: M.l + pw, y0: M.t, y1: M.t + ph };
        return { ctx, w, h, pw, ph };
    }

    function message(ctx, g, text) {
        ctx.fillStyle = COL.text;
        ctx.font = "12px Inter, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, M.l + g.pw / 2, M.t + g.ph / 2);
    }

    function timeAxis(ctx, g, dur) {
        const step = dur <= 6 ? 1 : dur <= 10 ? 2 : 3;
        ctx.font = FONT;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        for (let t = 0; t <= dur; t += step) {
            const x = M.l + (t / dur) * g.pw;
            ctx.strokeStyle = COL.grid;
            ctx.beginPath(); ctx.moveTo(x, M.t); ctx.lineTo(x, M.t + g.ph); ctx.stroke();
            ctx.fillStyle = COL.text;
            ctx.fillText(`${t}s`, x, M.t + g.ph + 6);
        }
    }

    function pitchAxisY(ctx, g) {
        ctx.font = FONT;
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        PITCH_TICKS.forEach((f) => {
            const y = M.t + (1 - Math.log2(f / F_LOW) / Math.log2(F_HIGH / F_LOW)) * g.ph;
            ctx.strokeStyle = COL.grid;
            ctx.beginPath(); ctx.moveTo(M.l, y); ctx.lineTo(M.l + g.pw, y); ctx.stroke();
            ctx.fillStyle = COL.text;
            ctx.fillText(`${fmtTick(f)}`, M.l - 6, y);
        });
    }

    const offscreen = document.createElement("canvas");

    function drawMap(id, prep, lut, dur, emptyText) {
        const g = frame(id);
        if (!g) return;
        const { ctx } = g;
        if (prep && prep.mat) {
            offscreen.width = STEPS;
            offscreen.height = BANDS;
            const octx = offscreen.getContext("2d");
            const img = octx.createImageData(STEPS, BANDS);
            for (let i = 0; i < STEPS * BANDS; i++) {
                const v = Math.round(clamp01(Math.pow(prep.mat[i], 0.8)) * 255) * 3;
                img.data[i * 4] = lut[v];
                img.data[i * 4 + 1] = lut[v + 1];
                img.data[i * 4 + 2] = lut[v + 2];
                img.data[i * 4 + 3] = 255;
            }
            octx.putImageData(img, 0, 0);
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = "high";
            ctx.drawImage(offscreen, M.l, M.t, g.pw, g.ph);
        } else {
            message(ctx, g, emptyText);
        }
        pitchAxisY(ctx, g);
        timeAxis(ctx, g, dur);
        ctx.strokeStyle = "rgba(255,255,255,0.12)";
        ctx.strokeRect(M.l + 0.5, M.t + 0.5, g.pw - 1, g.ph - 1);
    }

    function drawWave(traces, dur) {
        const g = frame("slWave");
        if (!g) return;
        const { ctx } = g;
        const live = traces.filter((t) => t.data);
        let peak = 0;
        live.forEach((t) => { for (let i = 0; i < t.data.length; i += 3) peak = Math.max(peak, Math.abs(t.data[i])); });
        const scale = Math.max(0.05, peak * 1.12);
        const mid = M.t + g.ph / 2;

        // grid + amplitude labels
        ctx.font = FONT;
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        [[1, "+" + scale.toFixed(2)], [0, "0"], [-1, "−" + scale.toFixed(2)]].forEach(([k, label]) => {
            const y = mid - (k * g.ph) / 2;
            ctx.strokeStyle = k === 0 ? "rgba(255,255,255,0.16)" : COL.grid;
            ctx.beginPath(); ctx.moveTo(M.l, y); ctx.lineTo(M.l + g.pw, y); ctx.stroke();
            ctx.fillStyle = COL.text;
            ctx.fillText(label, M.l - 6, Math.max(M.t + 6, Math.min(M.t + g.ph - 6, y)));
        });
        timeAxis(ctx, g, dur);

        if (!live.length) { message(ctx, g, "play or select a sound to see its waveform"); return; }

        live.forEach((t, idx) => {
            const n = t.data.length;
            const top = new Float32Array(Math.ceil(g.pw));
            const bot = new Float32Array(Math.ceil(g.pw));
            for (let x = 0; x < top.length; x++) {
                const i0 = Math.floor((x / top.length) * n);
                const i1 = Math.max(i0 + 1, Math.floor(((x + 1) / top.length) * n));
                let mx = -1;
                let mn = 1;
                for (let i = i0; i < i1 && i < n; i++) { const v = t.data[i]; if (v > mx) mx = v; if (v < mn) mn = v; }
                top[x] = mx;
                bot[x] = mn;
            }
            const yTop = (x) => mid - (top[x] / scale) * (g.ph / 2);
            const yBot = (x) => mid - (bot[x] / scale) * (g.ph / 2);
            if (t.outline) {
                // sound 2 is drawn as an outline on top of sound 1's fill, so the two stay distinguishable
                ctx.strokeStyle = t.color;
                ctx.lineWidth = 1.4;
                [yTop, yBot].forEach((yOf) => {
                    ctx.beginPath();
                    for (let x = 0; x < top.length; x++) { if (x === 0) ctx.moveTo(M.l + x, yOf(x)); else ctx.lineTo(M.l + x, yOf(x)); }
                    ctx.stroke();
                });
                ctx.lineWidth = 1;
            } else {
                ctx.beginPath();
                for (let x = 0; x < top.length; x++) ctx.lineTo(M.l + x, yTop(x));
                for (let x = top.length - 1; x >= 0; x--) ctx.lineTo(M.l + x, yBot(x));
                ctx.closePath();
                ctx.globalAlpha = 0.6;
                ctx.fillStyle = t.color;
                ctx.fill();
                ctx.globalAlpha = 1;
            }
        });
        ctx.strokeStyle = "rgba(255,255,255,0.12)";
        ctx.strokeRect(M.l + 0.5, M.t + 0.5, g.pw - 1, g.ph - 1);
    }

    function drawProfile(items) {
        const g = frame("slProfile");
        if (!g) return;
        const { ctx } = g;
        const live = items.filter((t) => t.mat);
        const profiles = live.map((t) => {
            const out = new Float32Array(BANDS);
            for (let b = 0; b < BANDS; b++) {
                let s = 0;
                for (let k = 0; k < STEPS; k++) s += t.mat[b * STEPS + k];
                out[b] = s / STEPS;
            }
            return out;
        });
        let top = 0;
        profiles.forEach((p) => p.forEach((v) => { if (v > top) top = v; }));
        top = Math.max(0.1, Math.ceil(top * 1.15 * 10) / 10);

        const xOf = (f) => M.l + (Math.log2(f / F_LOW) / Math.log2(F_HIGH / F_LOW)) * g.pw;
        ctx.font = FONT;
        ctx.textBaseline = "top";
        ctx.textAlign = "center";
        PITCH_TICKS.forEach((f) => {
            const x = xOf(f);
            ctx.strokeStyle = COL.grid;
            ctx.beginPath(); ctx.moveTo(x, M.t); ctx.lineTo(x, M.t + g.ph); ctx.stroke();
            ctx.fillStyle = COL.text;
            ctx.fillText(fmtTick(f), x, M.t + g.ph + 6);
        });
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        [0, 0.5, 1].forEach((k) => {
            const y = M.t + g.ph - k * g.ph;
            ctx.strokeStyle = COL.grid;
            ctx.beginPath(); ctx.moveTo(M.l, y); ctx.lineTo(M.l + g.pw, y); ctx.stroke();
            ctx.fillStyle = COL.text;
            ctx.fillText((k * top).toFixed(2), M.l - 6, Math.max(M.t + 6, Math.min(M.t + g.ph - 6, y)));
        });

        if (!profiles.length) { message(ctx, g, "select a picture to see its pitch profile"); return; }

        profiles.forEach((p, idx) => {
            const color = live[idx].color;
            ctx.beginPath();
            for (let b = BANDS - 1; b >= 0; b--) {       // b = 0 is the top row = highest pitch, so walk low -> high
                const x = xOf(bandFreq(b));
                const y = M.t + g.ph - (Math.min(p[b], top) / top) * g.ph;
                if (b === BANDS - 1) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.lineTo(xOf(F_HIGH), M.t + g.ph);
            ctx.lineTo(xOf(F_LOW), M.t + g.ph);
            ctx.closePath();
            ctx.globalAlpha = 0.16;
            ctx.fillStyle = color;
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.beginPath();
            for (let b = BANDS - 1; b >= 0; b--) {
                const x = xOf(bandFreq(b));
                const y = M.t + g.ph - (Math.min(p[b], top) / top) * g.ph;
                if (b === BANDS - 1) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.8;
            ctx.stroke();
            ctx.lineWidth = 1;
        });
        ctx.strokeStyle = "rgba(255,255,255,0.12)";
        ctx.strokeRect(M.l + 0.5, M.t + 0.5, g.pw - 1, g.ph - 1);
    }

    function drawThumb(id, src) {
        const canvas = $(id);
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const size = Math.round(88 * dpr);
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, size, size);
        if (!src) return;
        const tmp = document.createElement("canvas");
        tmp.width = src.w;
        tmp.height = src.h;
        const tctx = tmp.getContext("2d");
        const img = tctx.createImageData(src.w, src.h);
        for (let i = 0; i < src.w * src.h; i++) {
            const v = Math.round(clamp01(src.data[i]) * 255);
            img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
        }
        tctx.putImageData(img, 0, 0);
        const k = Math.min(size / src.w, size / src.h);
        const dw = src.w * k;
        const dh = src.h * k;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(tmp, (size - dw) / 2, (size - dh) / 2, dw, dh);
    }

    function statsHtml(p, emptyText) {
        if (!p) return `<span>${emptyText}</span>`;
        if (p.missing) return "<span>not ready: run that step first</span>";
        const s = p.stats;
        return `<span>loudness <b>${fmtDb(s.db)}</b></span><span>pitch centre <b>${fmtHz(s.centre)}</b></span><span>active <b>${Math.round(s.active * 100)}%</b></span>`;
    }

    const HINTS = {
        spectral: "How to read the graphs: left → right is time, bottom → top is pitch, brighter is louder. A hiss shows up as a haze across all pitches; skipped k-space lines show up as gaps between pitches.",
        contour: "Contour plays one voice: its pitch follows where the picture is bright (top = high) and its volume follows how bright each column is. The graphs still show the full pitch–time picture.",
    };

    function drawAll() {
        const dur = parseInt(durSlider.value, 10);
        $("slHint").textContent = HINTS[mapSel.value] || HINTS.spectral;
        const p1 = S.p1 && !S.p1.missing ? S.p1 : null;
        const p2 = S.p2 && !S.p2.missing ? S.p2 : null;

        drawThumb("slThumb1", p1 && p1.src);
        drawThumb("slThumb2", p2 && p2.src);
        $("slStats1").innerHTML = statsHtml(S.p1, "choose a picture");
        $("slStats2").innerHTML = statsHtml(S.p2, "optional");

        drawMap("slMap1", p1, LUT1, dur, sel1.value ? "not ready: run that step first" : "choose a picture for sound 1");
        drawMap("slMap2", p2, LUT2, dur, sel2.value ? "not ready: run that step first" : "choose a sound 2 to compare");

        const traces = [{ data: p1 && p1.audio, color: COL.one }, { data: p2 && p2.audio, color: COL.two, outline: true }];
        if (S.diff) traces.push({ data: S.diff.audio, color: COL.diff, outline: true });
        drawWave(traces, dur);
        $("slWaveCap").innerHTML = S.diff
            ? `<i class="sl-dot" style="--c:${COL.diff}"></i>Waveform · difference sound over 1 and 2`
            : `<i class="sl-dot" style="--c:${COL.one}"></i><i class="sl-dot" style="--c:${COL.two}"></i>Waveform · 1 vs 2`;

        drawProfile([{ mat: p1 && p1.mat, color: COL.one }, { mat: p2 && p2.mat, color: COL.two }]);

        // where the two differ
        const dmat = p1 && p2 ? absDiff(p1.mat, p2.mat) : null;
        drawMap("slMapD", dmat ? { mat: dmat } : null, LUT3, dur, p1 && p2 ? "" : "choose a sound 2 to see where the two sounds differ");

        // comparison chips
        if (p1 && p2) {
            const a = p1.stats;
            const b = p2.stats;
            const dl = a.db === -Infinity || b.db === -Infinity ? null : b.db - a.db;
            const dp = a.centre && b.centre ? 12 * Math.log2(b.centre / a.centre) : null;
            $("slDLoud").textContent = dl === null ? "—" : `${sign(dl)}${Math.abs(dl).toFixed(1)} dB`;
            $("slDPitch").textContent = dp === null ? "—" : `${sign(dp)}${Math.abs(dp).toFixed(1)} semitones`;
            let meanDiff = 0;
            for (let i = 0; i < p1.mat.length; i++) meanDiff += Math.abs(p1.mat[i] - p2.mat[i]);
            meanDiff /= p1.mat.length;
            $("slDSim").textContent = meanDiff < 0.0005 ? "identical" : `${(meanDiff * 100).toFixed(meanDiff < 0.1 ? 1 : 0)}%`;
        } else {
            ["slDLoud", "slDPitch", "slDSim"].forEach((id) => { $(id).textContent = "—"; });
        }
    }

    // ---------- playheads ----------
    const HEAD_CHART = { sonHead1: "slMap1", sonHead2: "slMap2", sonHeadW: "slWave", sonHeadD: "slMapD" };

    function movePlayhead(id, fraction) {
        const el = $(id);
        if (!el) return;
        const g = geom[HEAD_CHART[id]];
        if (fraction === null || !g) {
            el.style.display = "none";
            return;
        }
        el.style.display = "block";
        el.style.left = `${g.x0 + fraction * (g.x1 - g.x0)}px`;
        el.style.top = `${g.y0}px`;
        el.style.height = `${g.y1 - g.y0}px`;
    }

    // ---------- audio ----------
    function getAudio() {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        if (!audio) audio = new AC();
        if (audio.state === "suspended" && audio.resume) audio.resume();
        return audio;
    }

    function stopPlayback() {
        if (playing) {
            const p = playing;
            playing = null;
            p.stop();
        }
        Object.keys(HEAD_CHART).forEach((id) => movePlayhead(id, null));
        $("sonSwitch").classList.remove("is-visible");
    }

    function makeBuffer(ctx, channels) {
        const buf = ctx.createBuffer(channels.length, channels[0].length, SAMPLE_RATE);
        channels.forEach((data, c) => {
            if (buf.copyToChannel) buf.copyToChannel(data, c);
            else buf.getChannelData(c).set(data);
        });
        return buf;
    }

    async function start(kind) {
        stopPlayback();

        const key1 = sel1.value;
        const key2 = sel2.value;
        const compare = kind === "compare";
        if (!key1) return setStatus("Choose a picture for sound 1.");
        if (compare && !key2) return setStatus("Choose a sound 2 to compare with.");

        const ctx = getAudio();
        if (!ctx) return setStatus("This browser has no Web Audio support.");

        setStatus("Preparing sound…");
        await sleep(20);   // let the status paint before the (short) synthesis work

        const p1 = await prepare(key1, 1);
        if (!p1 || p1.missing) return setStatus("Sound 1 isn't ready yet: run that step in the console first.");
        let p2 = S.p2;
        if (compare) {
            p2 = await prepare(key2, 2);
            if (!p2 || p2.missing) return setStatus("Sound 2 isn't ready yet: run that step in the console first.");
        }
        S.p1 = p1;
        if (compare) S.p2 = p2;
        S.diff = null;

        const dur = parseInt(durSlider.value, 10);
        const mapping = mapSel.value;
        const mode = modeSel.value;

        const master = ctx.createGain();
        master.gain.value = parseInt(volSlider.value, 10) / 100;
        master.connect(ctx.destination);
        masterNode = master;

        const sources = [];
        let channelsForWav;
        let name;
        let totalSeconds = dur;
        let segments;          // playhead schedule: [{from, to, id}]
        let loop = false;
        let live = null;

        const bufferSource = (channels, opts) => {
            const src = ctx.createBufferSource();
            src.buffer = makeBuffer(ctx, channels);
            if (opts && opts.loop) src.loop = true;
            sources.push(src);
            return src;
        };

        if (!compare) {
            channelsForWav = [p1.audio];
            name = `sound1_${p1.label}`;
            bufferSource([p1.audio]).connect(master);
            segments = [{ from: 0, to: dur, id: "sonHead1" }];
        } else if (mode === "then") {
            const gap = new Float32Array(Math.round(GAP_SECONDS * SAMPLE_RATE));
            const joined = new Float32Array(p1.audio.length + gap.length + p2.audio.length);
            joined.set(p1.audio, 0);
            joined.set(p2.audio, p1.audio.length + gap.length);
            channelsForWav = [joined];
            name = "1_then_2";
            bufferSource([joined]).connect(master);
            totalSeconds = joined.length / SAMPLE_RATE;
            segments = [
                { from: 0, to: dur, id: "sonHead1" },
                { from: dur + GAP_SECONDS, to: totalSeconds, id: "sonHead2" },
            ];
        } else if (mode === "stereo") {
            channelsForWav = [p1.audio, p2.audio];
            name = "1_left_2_right";
            bufferSource([p1.audio, p2.audio]).connect(master);
            segments = [{ from: 0, to: dur, id: "sonHead1" }, { from: 0, to: dur, id: "sonHead2" }];
        } else if (mode === "live") {
            channelsForWav = [p1.audio, p2.audio];
            name = "1_left_2_right";
            const gA = ctx.createGain();
            const gB = ctx.createGain();
            gA.gain.value = 1;
            gB.gain.value = 0;
            bufferSource([p1.audio], { loop: true }).connect(gA);
            bufferSource([p2.audio], { loop: true }).connect(gB);
            gA.connect(master);
            gB.connect(master);
            loop = true;
            segments = [{ from: 0, to: dur, id: "sonHead1" }, { from: 0, to: dur, id: "sonHead2" }];
            live = { gA, gB };
        } else {   // diff
            const d = absDiff(p1.mat, p2.mat);
            const a = render(d, dur, mapping);
            S.diff = { mat: d, audio: a };
            channelsForWav = [a];
            name = "difference_1_vs_2";
            bufferSource([a]).connect(master);
            segments = [{ from: 0, to: dur, id: "sonHead1" }, { from: 0, to: dur, id: "sonHead2" }];
        }

        lastRender = { channels: channelsForWav, name };
        drawAll();

        const setLive = (which) => {
            if (!live) return;
            const t = ctx.currentTime;
            live.gA.gain.setTargetAtTime(which === 1 ? 1 : 0, t, 0.012);
            live.gB.gain.setTargetAtTime(which === 2 ? 1 : 0, t, 0.012);
            $("sonHear1").classList.toggle("is-on", which === 1);
            $("sonHear2").classList.toggle("is-on", which === 2);
        };

        const t0 = ctx.currentTime + 0.05;
        let raf = 0;
        const tick = () => {
            if (!playing) return;
            let t = ctx.currentTime - t0;
            if (loop && t > 0) t = t % totalSeconds;
            let waveFraction = null;
            segments.forEach((seg) => {
                if (t >= seg.from && t <= seg.to) {
                    const f = (t - seg.from) / (seg.to - seg.from);
                    movePlayhead(seg.id, f);
                    if (waveFraction === null) waveFraction = f;
                } else {
                    movePlayhead(seg.id, null);
                }
            });
            movePlayhead("sonHeadW", waveFraction);
            movePlayhead("sonHeadD", waveFraction);
            raf = requestAnimationFrame(tick);
        };

        const handle = {
            stop() {
                cancelAnimationFrame(raf);
                sources.forEach((s) => { try { s.onended = null; s.stop(); } catch (e) { /* already stopped */ } });
                try { master.disconnect(); } catch (e) { /* ignore */ }
                live = null;
                setStatus("Stopped.");
            },
            setLive,
        };
        playing = handle;

        // end of (non-looping) playback
        sources[0].onended = () => {
            if (playing !== handle) return;
            playing = null;
            cancelAnimationFrame(raf);
            Object.keys(HEAD_CHART).forEach((id) => movePlayhead(id, null));
            $("sonSwitch").classList.remove("is-visible");
            setStatus("Finished. Change the noise or sampling, re-run, and play again to hear the difference.");
            if (stale) scheduleRefresh(100);
        };

        sources.forEach((s) => s.start(t0));
        raf = requestAnimationFrame(tick);

        if (live) {
            $("sonHear1").classList.add("is-on");
            $("sonHear2").classList.remove("is-on");
            $("sonSwitch").classList.add("is-visible");
            setStatus("Looping. Press 1 or 2 (keys or buttons) to jump between the two sounds at the same moment.");
        } else if (!compare) {
            setStatus(`Playing sound 1: ${p1.label}`);
        } else if (mode === "stereo") {
            setStatus(`Playing 1 in the left ear and 2 in the right (use headphones): ${p1.label} | ${p2.label}`);
        } else if (mode === "then") {
            setStatus(`Playing 1, a short pause, then 2: ${p1.label} → ${p2.label}`);
        } else {
            setStatus("Playing what differs between 1 and 2. Silence means they are identical.");
        }
    }

    // ---------- snapshot + wav ----------
    async function takeSnapshot() {
        const key = sel1.value;
        const src = await readSource(key);
        if (!src) return setStatus("Nothing to snapshot yet: run that step first.");
        const params = currentParamsText();
        const dependsOnParams = ["kunder", "mask", "recon", "error"].includes(key);
        snapshotCounter += 1;
        const label = `#${snapshotCounter} ${src.label}${dependsOnParams && params ? " · " + params : ""}`;
        snapshots.push({ key: `snap${snapshotCounter}`, label, data: src.data, w: src.w, h: src.h });
        while (snapshots.length > MAX_SNAPSHOTS) snapshots.shift();
        refreshOptions(true);
        sel2.value = `snap${snapshotCounter}`;
        scheduleRefresh(50);
        setStatus(`Saved "${label}". It is now selected as sound 2. Change a setting, re-run, and compare.`);
    }

    function saveWav() {
        if (!lastRender) return setStatus("Play something first, then export it.");
        const blob = new Blob([encodeWav(lastRender.channels, SAMPLE_RATE)], { type: "audio/wav" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `kspace_${lastRender.name.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 60)}.wav`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        setStatus("Exported the last sound as a .wav file.");
    }

    // ---------- init ----------
    function init() {
        const host = $("soundLab");
        if (!host || $("sonifyPanel")) {
            if (!host) console.warn("K-SPACE sonification: #soundLab not found in index.html (is templates/index.html up to date?)");
            return;
        }
        injectStyles();
        buildLab(host);

        sel1 = $("sonSel1");
        sel2 = $("sonSel2");
        mapSel = $("sonMapping");
        modeSel = $("sonMode");
        durSlider = $("sonDur");
        volSlider = $("sonVol");
        statusEl = $("sonStatus");

        refreshOptions(true);
        sel1.value = "recon";
        [durSlider, volSlider].forEach(paintRange);

        durSlider.addEventListener("input", () => {
            $("sonDurValue").textContent = `${durSlider.value} s`;
            paintRange(durSlider);
            scheduleRefresh(250);
        });
        volSlider.addEventListener("input", () => {
            $("sonVolValue").textContent = `${volSlider.value}%`;
            paintRange(volSlider);
            if (masterNode && playing) masterNode.gain.value = parseInt(volSlider.value, 10) / 100;
        });
        [sel1, sel2, mapSel].forEach((el) => el.addEventListener("change", () => scheduleRefresh(80)));
        [sel1, sel2].forEach((el) => el.addEventListener("change", () => { el.title = el.selectedOptions[0] ? el.selectedOptions[0].textContent : ""; }));

        $("sonSwap").addEventListener("click", () => {
            const a = sel1.value;
            const b = sel2.value;
            if (!b) return setStatus("Choose a sound 2 first, then swap.");
            sel1.value = b;
            sel2.value = a;
            scheduleRefresh(50);
        });

        $("sonPlay1").addEventListener("click", () => start("single"));
        $("sonCompare").addEventListener("click", () => start("compare"));
        $("sonStop").addEventListener("click", () => { stopPlayback(); if (stale) scheduleRefresh(100); });
        $("sonSnap").addEventListener("click", takeSnapshot);
        $("sonWav").addEventListener("click", saveWav);
        $("sonHear1").addEventListener("click", () => playing && playing.setLive(1));
        $("sonHear2").addEventListener("click", () => playing && playing.setLive(2));

        document.addEventListener("keydown", (e) => {
            if (!playing || (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName))) return;
            if (e.key === "1") playing.setLive(1);
            if (e.key === "2") playing.setLive(2);
        });

        const reset = $("btnReset");
        if (reset) {
            reset.addEventListener("click", () => {
                stopPlayback();
                snapshots.length = 0;
                lastRender = null;
                S.p1 = S.p2 = S.diff = null;
                refreshOptions(true);
                sel1.value = "recon";
                sel2.value = "";
                drawAll();
                setStatus("Pick a picture for sound 1 and press play. Add a sound 2 to compare.");
            });
        }

        // charts follow the pipeline: redraw whenever the app logs something or the status changes
        const onPipelineChange = () => { stale = true; scheduleRefresh(450); };
        const logEl = $("logList");
        if (logEl) new MutationObserver(onPipelineChange).observe(logEl, { childList: true });
        const statusText = $("statusText");
        if (statusText) new MutationObserver(onPipelineChange).observe(statusText, { childList: true, characterData: true, subtree: true });

        // draw when the tab becomes visible / the window is resized
        const graphs = host.querySelector(".sl-graphs");
        if (window.ResizeObserver && graphs) {
            new ResizeObserver(() => {
                if (!pageActive()) return;
                if (stale) scheduleRefresh(30);
                else drawAll();
            }).observe(graphs);
        }
        document.querySelectorAll('.viewer-nav__step, .viewer-nav__arrow').forEach((b) => {
            b.addEventListener("click", () => setTimeout(() => { if (pageActive() && stale) scheduleRefresh(60); }, 30));
        });

        // keep the "not ready yet" labels in step with the pipeline
        setInterval(() => { if (refreshOptions(false)) { stale = true; scheduleRefresh(250); } }, 700);

        drawAll();
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
})(typeof window !== "undefined" ? window : globalThis);