// Separate frequency experiment; does not overwrite the sampling controls.
(() => {
    const el = id => document.getElementById(id);
    const canvas = el('comparisonCanvas');
    const slider = el('comparisonSlider');
    const mode = el('comparisonMode');
    const cutoff = el('frequencyCutoff');
    let pipelinePair = null, experiment = null, generation = 0, timer;
    const sourceKey = () => JSON.stringify(window.APP_STATE);
    const bitmap = array => {
        const c = document.createElement('canvas');
        c.width = array[0].length; c.height = array.length;
        c.getContext('2d').putImageData(_createImageData(c.width, c.height, array, _grayscale), 0, 0);
        return c;
    };
    function draw() {
        const pair = mode.value === 'pipeline' ? pipelinePair : experiment && {
            original: experiment.original, recon: experiment[mode.value]
        };
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (pair) {
            if (canvas.width !== pair.original.width || canvas.height !== pair.original.height) {
                canvas.width = pair.original.width; canvas.height = pair.original.height;
            }
            ctx.drawImage(pair.recon, 0, 0, canvas.width, canvas.height);
            ctx.save(); ctx.beginPath();
            ctx.rect(0, 0, canvas.width * Number(slider.value) / 100, canvas.height);
            ctx.clip(); ctx.drawImage(pair.original, 0, 0, canvas.width, canvas.height); ctx.restore();
        }
        el('comparisonDivider').style.left = `${slider.value}%`;
        el('comparisonValue').textContent = `${slider.value}%`;
        el('comparisonRightLabel').textContent = mode.selectedOptions[0].textContent;
    }
    window.updateMRIComparison = data => {
        pipelinePair = { original: bitmap(data.reference), recon: bitmap(data.recon) };
        draw();
    };
    window.clearMRIComparison = () => {
        generation++; clearTimeout(timer); experiment = pipelinePair = null;
        ['frequencyLow', 'frequencyHigh', 'frequencyLowMask', 'frequencyHighMask'].forEach(id => clearCanvas(el(id)));
        el('frequencyStatus').textContent = 'Load an image or dataset slice, then reconstruct or apply the experiment.';
        draw();
    };
    window.clearFrequencyExperiment = () => {
        generation++; experiment = null;
        ['frequencyLow', 'frequencyHigh', 'frequencyLowMask', 'frequencyHighMask'].forEach(id => clearCanvas(el(id)));
        draw();
    };
    async function run() {
        if (!requireImage()) return;
        const ticket = ++generation, key = sourceKey();
        el('frequencyStatus').textContent = 'Reconstructing complementary frequency regions…';
        try {
            const data = await postJSON('/pipeline/frequency-experiment', {...sourcePayload(), cutoff: Number(cutoff.value) / 100});
            if (ticket !== generation || key !== sourceKey()) return;
            experiment = { original: bitmap(data.reference), low: bitmap(data.low.recon), high: bitmap(data.high.recon) };
            renderGrayscale(el('frequencyLow'), data.low.recon);
            renderGrayscale(el('frequencyHigh'), data.high.recon);
            renderGrayscale(el('frequencyLowMask'), data.low.mask);
            renderGrayscale(el('frequencyHighMask'), data.high.mask);
            if (mode.value === 'pipeline') mode.value = 'low';
            el('frequencyStatus').textContent = `Low frequencies retained: ${(data.low.density * 100).toFixed(1)}% · High frequencies retained: ${(data.high.density * 100).toFixed(1)}%.`;
            draw();
        } catch (error) {
            if (ticket === generation) el('frequencyStatus').textContent = `Experiment failed: ${error.message}`;
        }
    }
    slider.addEventListener('input', draw);
    mode.addEventListener('change', () => { draw(); if (mode.value !== 'pipeline' && !experiment) run(); });
    el('btnFrequency').addEventListener('click', run);
    cutoff.addEventListener('input', () => {
        el('frequencyCutoffValue').textContent = `${cutoff.value}%`;
        generation++; clearTimeout(timer);
        if (window.APP_STATE.source) timer = setTimeout(run, 180);
    });
    const stage = el('comparisonStage');
    function drag(event) {
        const rect = stage.getBoundingClientRect();
        slider.value = Math.max(0, Math.min(100, 100 * (event.clientX - rect.left) / rect.width));
        draw();
    }
    stage.addEventListener('pointerdown', event => { stage.setPointerCapture(event.pointerId); drag(event); });
    stage.addEventListener('pointermove', event => { if (stage.hasPointerCapture(event.pointerId)) drag(event); });
    stage.addEventListener('pointerup', event => { if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId); });
    draw();
})();
