// Shared canvas drawing helpers for the k-space viewport grid.
// All functions expect a 2D JS array (rows of values) matching the
// canvas's width/height, with float values already scaled to [0, 1].

function _putArrayOnCanvas(canvas, array2d, colorFn) {
    const ctx = canvas.getContext("2d");
    const height = array2d.length;
    const width = array2d[0].length;

    const imageData = ctx.createImageData(width, height);

    for (let y = 0; y < height; y++) {
        const row = array2d[y];
        for (let x = 0; x < width; x++) {
            const value = row[x];
            const [r, g, b] = colorFn(value);
            const idx = (y * width + x) * 4;
            imageData.data[idx] = r;
            imageData.data[idx + 1] = g;
            imageData.data[idx + 2] = b;
            imageData.data[idx + 3] = 255;
        }
    }

    // canvas element size may differ from the array size; draw via an
    // offscreen canvas at native resolution, then scale onto the visible one.
    const off = document.createElement("canvas");
    off.width = width;
    off.height = height;
    off.getContext("2d").putImageData(imageData, 0, 0);

    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(off, 0, 0, width, height, 0, 0, canvas.width, canvas.height);
}

function _grayscale(value) {
    const v = Math.max(0, Math.min(1, value)) * 255;
    return [v, v, v];
}

// Rough approximation of matplotlib's "hot" colormap: black -> red -> yellow -> white.
function _hot(value) {
    const v = Math.max(0, Math.min(1, value));
    let r, g, b;

    if (v < 1 / 3) {
        r = v * 3 * 255;
        g = 0;
        b = 0;
    } else if (v < 2 / 3) {
        r = 255;
        g = (v - 1 / 3) * 3 * 255;
        b = 0;
    } else {
        r = 255;
        g = 255;
        b = (v - 2 / 3) * 3 * 255;
    }

    return [r, g, b];
}

function renderGrayscale(canvas, array2d) {
    _putArrayOnCanvas(canvas, array2d, _grayscale);
}

function renderHot(canvas, array2d) {
    _putArrayOnCanvas(canvas, array2d, _hot);
}

function clearCanvas(canvas) {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
}