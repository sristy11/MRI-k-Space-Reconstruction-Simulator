// ============================================================
// MRIK SPACE - CANVAS RENDERER
// ============================================================
// Smooth visual rendering for:
//
// 1. Original MRI image
// 2. K-space
// 3. Undersampled k-space
// 4. Reconstructed image
// 5. Error map
//
// Input:
//     array2d = 2D JavaScript array
//     values should normally be in [0, 1]
// ============================================================


// ============================================================
// ANIMATION MANAGEMENT
// ============================================================

// Keep one animation per canvas.
//
// This is important because controls.js may call the renderer
// several times while an older animation is still running.

const canvasAnimations = new WeakMap();


// ============================================================
// CANCEL EXISTING ANIMATION
// ============================================================

function _cancelCanvasAnimation(canvas) {

    if (!canvas) {
        return;
    }

    const oldAnimation =
        canvasAnimations.get(canvas);

    if (oldAnimation !== undefined) {

        cancelAnimationFrame(oldAnimation);

        canvasAnimations.delete(canvas);
    }
}


// ============================================================
// VALIDATE 2D ARRAY
// ============================================================

function _validateArray(array2d) {

    if (!array2d) {

        console.error(
            "canvasRender: array2d is undefined."
        );

        return false;
    }


    if (!Array.isArray(array2d)) {

        console.error(
            "canvasRender: array2d is not an array.",
            array2d
        );

        return false;
    }


    if (array2d.length === 0) {

        console.error(
            "canvasRender: array2d is empty."
        );

        return false;
    }


    if (!Array.isArray(array2d[0])) {

        console.error(
            "canvasRender: first row is not an array.",
            array2d[0]
        );

        return false;
    }


    if (array2d[0].length === 0) {

        console.error(
            "canvasRender: array width is zero."
        );

        return false;
    }


    const width =
        array2d[0].length;


    for (
        let y = 0;
        y < array2d.length;
        y++
    ) {

        if (!Array.isArray(array2d[y])) {

            console.error(
                "canvasRender: invalid row:",
                y
            );

            return false;
        }


        if (array2d[y].length !== width) {

            console.error(
                "canvasRender: rows have different widths."
            );

            return false;
        }
    }


    return true;
}


// ============================================================
// CREATE IMAGE DATA
// ============================================================

function _createImageData(
    width,
    height,
    array2d,
    colorFn
) {

    const imageData =
        new ImageData(
            width,
            height
        );


    for (
        let y = 0;
        y < height;
        y++
    ) {

        const row =
            array2d[y];


        for (
            let x = 0;
            x < width;
            x++
        ) {

            let value =
                Number(row[x]);


            // Protect against NaN
            if (!Number.isFinite(value)) {

                value = 0;
            }


            // Clamp to [0, 1]
            value =
                Math.max(
                    0,
                    Math.min(
                        1,
                        value
                    )
                );


            const rgb =
                colorFn(value);


            const r =
                Math.round(rgb[0]);

            const g =
                Math.round(rgb[1]);

            const b =
                Math.round(rgb[2]);


            const index =
                (y * width + x) * 4;


            imageData.data[index] =
                r;

            imageData.data[index + 1] =
                g;

            imageData.data[index + 2] =
                b;

            imageData.data[index + 3] =
                255;
        }
    }


    return imageData;
}


// ============================================================
// EASING
// ============================================================

// Makes the animation start slowly,
// accelerate,
// then slow down.

function _easeInOut(t) {

    return (
        t < 0.5
            ? 2 * t * t
            : 1 -
              Math.pow(
                  -2 * t + 2,
                  2
              ) / 2
    );
}


// ============================================================
// MAIN RENDER FUNCTION
// ============================================================

function _putArrayOnCanvas(
    canvas,
    array2d,
    colorFn,
    animate = true,
    animationType = "smooth"
) {

    // --------------------------------------------------------
    // Canvas check
    // --------------------------------------------------------

    if (!canvas) {

        console.error(
            "canvasRender: canvas not found."
        );

        return;
    }


    // --------------------------------------------------------
    // Array check
    // --------------------------------------------------------

    if (!_validateArray(array2d)) {

        return;
    }


    // --------------------------------------------------------
    // Cancel previous animation
    // --------------------------------------------------------

    _cancelCanvasAnimation(canvas);


    // --------------------------------------------------------
    // Dimensions
    // --------------------------------------------------------

    const height =
        array2d.length;

    const width =
        array2d[0].length;


    // --------------------------------------------------------
    // Create image
    // --------------------------------------------------------

    const imageData =
        _createImageData(
            width,
            height,
            array2d,
            colorFn
        );


    // --------------------------------------------------------
    // Offscreen canvas
    // --------------------------------------------------------

    const offscreen =
        document.createElement(
            "canvas"
        );


    offscreen.width =
        width;

    offscreen.height =
        height;


    const offCtx =
        offscreen.getContext("2d");


    offCtx.putImageData(
        imageData,
        0,
        0
    );


    // --------------------------------------------------------
    // Visible canvas
    // --------------------------------------------------------

    // Match the canvas backing store to the array's real shape so
    // non-square data (e.g. a 640x368 .h5 slice) isn't squashed into
    // the 256x256 default. CSS object-fit: contain letterboxes it.
    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
    }
    // Make the frame match the data's aspect ratio so there are no
    // letterbox bars around non-square (.h5) images.
    if (canvas.parentElement &&
        canvas.parentElement.classList.contains("viewcell__frame")) {
        canvas.parentElement.style.setProperty("--ar", width / height);
    }

    const ctx =
        canvas.getContext("2d");


    ctx.imageSmoothingEnabled =
        false;


    // ========================================================
    // INSTANT MODE
    // ========================================================

    if (!animate) {

        ctx.clearRect(
            0,
            0,
            canvas.width,
            canvas.height
        );


        ctx.drawImage(
            offscreen,

            0,
            0,
            width,
            height,

            0,
            0,
            canvas.width,
            canvas.height
        );


        return;
    }


    // ========================================================
    // ANIMATION PARAMETERS
    // ========================================================

    const duration =
        1200;


    const start =
        performance.now();


    // Clear previous image

    ctx.clearRect(
        0,
        0,
        canvas.width,
        canvas.height
    );


    // ========================================================
    // SMOOTH ANIMATION
    // ========================================================

    function frame(now) {

        const elapsed =
            now - start;


        let progress =
            elapsed / duration;


        progress =
            Math.max(
                0,
                Math.min(
                    1,
                    progress
                )
            );


        const eased =
            _easeInOut(progress);


        // ----------------------------------------------------
        // NORMAL SMOOTH REVEAL
        // ----------------------------------------------------

        if (
            animationType === "smooth" ||
            animationType === "reconstruction"
        ) {

            const visibleHeight =
                Math.max(
                    1,
                    Math.floor(
                        height * eased
                    )
                );


            ctx.clearRect(
                0,
                0,
                canvas.width,
                canvas.height
            );


            ctx.drawImage(

                offscreen,

                0,
                0,
                width,
                visibleHeight,

                0,
                0,
                canvas.width,
                canvas.height *
                    (
                        visibleHeight /
                        height
                    )
            );
        }


        // ----------------------------------------------------
        // FADE ANIMATION
        // ----------------------------------------------------

        else if (
            animationType === "fade"
        ) {

            ctx.clearRect(
                0,
                0,
                canvas.width,
                canvas.height
            );


            ctx.globalAlpha =
                eased;


            ctx.drawImage(
                offscreen,

                0,
                0,
                width,
                height,

                0,
                0,
                canvas.width,
                canvas.height
            );


            ctx.globalAlpha =
                1;
        }


        // ----------------------------------------------------
        // CENTER OUTWARD
        // ----------------------------------------------------

        else if (
            animationType === "center"
        ) {

            ctx.clearRect(
                0,
                0,
                canvas.width,
                canvas.height
            );


            const centerX =
                width / 2;

            const centerY =
                height / 2;


            const maxRadius =
                Math.sqrt(
                    centerX * centerX +
                    centerY * centerY
                );


            const radius =
                maxRadius * eased;


            const sourceX =
                Math.max(
                    0,
                    centerX - radius
                );


            const sourceY =
                Math.max(
                    0,
                    centerY - radius
                );


            const sourceRight =
                Math.min(
                    width,
                    centerX + radius
                );


            const sourceBottom =
                Math.min(
                    height,
                    centerY + radius
                );


            const sourceWidth =
                sourceRight -
                sourceX;


            const sourceHeight =
                sourceBottom -
                sourceY;


            if (
                sourceWidth > 0 &&
                sourceHeight > 0
            ) {

                ctx.drawImage(

                    offscreen,

                    sourceX,
                    sourceY,
                    sourceWidth,
                    sourceHeight,

                    sourceX *
                        canvas.width /
                        width,

                    sourceY *
                        canvas.height /
                        height,

                    sourceWidth *
                        canvas.width /
                        width,

                    sourceHeight *
                        canvas.height /
                        height
                );
            }
        }


        // ----------------------------------------------------
        // K-SPACE RADIAL / CENTER REVEAL
        // ----------------------------------------------------

        else if (
            animationType === "kspace"
        ) {

            ctx.clearRect(
                0,
                0,
                canvas.width,
                canvas.height
            );


            const centerX =
                width / 2;

            const centerY =
                height / 2;


            const maxRadius =
                Math.sqrt(
                    centerX * centerX +
                    centerY * centerY
                );


            const radius =
                maxRadius * eased;


            // Draw image first
            ctx.drawImage(
                offscreen,

                0,
                0,
                width,
                height,

                0,
                0,
                canvas.width,
                canvas.height
            );


            // Hide everything outside
            ctx.save();


            ctx.globalCompositeOperation =
                "destination-in";


            ctx.beginPath();


            ctx.arc(

                canvas.width / 2,
                canvas.height / 2,

                radius *
                    canvas.width /
                    width,

                0,
                Math.PI * 2
            );


            ctx.fill();


            ctx.restore();
        }


        // ----------------------------------------------------
        // Continue animation
        // ----------------------------------------------------

        if (progress < 1) {

            const id =
                requestAnimationFrame(
                    frame
                );


            canvasAnimations.set(
                canvas,
                id
            );

        } else {

            // Make absolutely sure the final
            // complete image is drawn.

            ctx.clearRect(
                0,
                0,
                canvas.width,
                canvas.height
            );


            ctx.drawImage(
                offscreen,

                0,
                0,
                width,
                height,

                0,
                0,
                canvas.width,
                canvas.height
            );


            canvasAnimations.delete(
                canvas
            );
        }
    }


    // Start animation

    const id =
        requestAnimationFrame(
            frame
        );


    canvasAnimations.set(
        canvas,
        id
    );
}


// ============================================================
// GRAYSCALE
// ============================================================

function _grayscale(value) {

    const v =
        Math.max(
            0,
            Math.min(
                1,
                value
            )
        ) * 255;


    return [
        v,
        v,
        v
    ];
}


// ============================================================
// HOT
// black → red → yellow → white
// ============================================================

function _hot(value) {

    const v =
        Math.max(
            0,
            Math.min(
                1,
                value
            )
        );


    let r;
    let g;
    let b;


    if (v < 1 / 3) {

        r =
            v * 3 * 255;

        g = 0;
        b = 0;

    } else if (v < 2 / 3) {

        r = 255;

        g =
            (v - 1 / 3)
            * 3
            * 255;

        b = 0;

    } else {

        r = 255;
        g = 255;

        b =
            (v - 2 / 3)
            * 3
            * 255;
    }


    return [
        r,
        g,
        b
    ];
}


// ============================================================
// JET
// blue → cyan → green → yellow → red
// ============================================================

function _jet(value) {

    const v =
        Math.max(
            0,
            Math.min(
                1,
                value
            )
        );


    const clamp01 =
        (x) =>
            Math.max(
                0,
                Math.min(
                    1,
                    x
                )
            );


    const r =
        clamp01(
            Math.min(
                4 * v - 1.5,
                -4 * v + 4.5
            )
        );


    const g =
        clamp01(
            Math.min(
                4 * v - 0.5,
                -4 * v + 3.5
            )
        );


    const b =
        clamp01(
            Math.min(
                4 * v + 0.5,
                -4 * v + 2.5
            )
        );


    return [
        r * 255,
        g * 255,
        b * 255
    ];
}


// ============================================================
// ORIGINAL IMAGE
// ============================================================

function renderOriginal(
    canvas,
    array2d,
    animate = true
) {

    _putArrayOnCanvas(
        canvas,
        array2d,
        _grayscale,
        animate,
        "fade"
    );
}


// ============================================================
// K-SPACE
// ============================================================

function renderKspace(
    canvas,
    array2d,
    animate = true
) {

    _putArrayOnCanvas(
        canvas,
        array2d,
        _grayscale,
        animate,
        "kspace"
    );
}


// ============================================================
// UNDERSAMPLED K-SPACE
// ============================================================

function renderUndersampled(
    canvas,
    array2d,
    animate = true
) {

    _putArrayOnCanvas(
        canvas,
        array2d,
        _grayscale,
        animate,
        "kspace"
    );
}


// ============================================================
// RECONSTRUCTION
// ============================================================

function renderReconstruction(
    canvas,
    array2d,
    animate = true
) {

    _putArrayOnCanvas(
        canvas,
        array2d,
        _grayscale,
        animate,
        "reconstruction"
    );
}


// ============================================================
// ERROR MAP
// ============================================================

function renderErrorMap(
    canvas,
    array2d,
    animate = true
) {

    _putArrayOnCanvas(
        canvas,
        array2d,
        _hot,
        animate,
        "smooth"
    );
}


// ============================================================
// GENERIC GRAYSCALE
// ============================================================

function renderGrayscale(
    canvas,
    array2d,
    animate = true
) {

    _putArrayOnCanvas(
        canvas,
        array2d,
        _grayscale,
        animate,
        "smooth"
    );
}


// ============================================================
// HOT
// ============================================================

function renderHot(
    canvas,
    array2d,
    animate = true
) {

    _putArrayOnCanvas(
        canvas,
        array2d,
        _hot,
        animate,
        "smooth"
    );
}


// ============================================================
// JET
// ============================================================

function renderJet(
    canvas,
    array2d,
    animate = true
) {

    _putArrayOnCanvas(
        canvas,
        array2d,
        _jet,
        animate,
        "smooth"
    );
}


// ============================================================
// CLEAR CANVAS
// ============================================================

function clearCanvas(canvas) {

    if (!canvas) {

        console.error(
            "canvasRender: canvas not found."
        );

        return;
    }


    _cancelCanvasAnimation(
        canvas
    );


    const ctx =
        canvas.getContext("2d");


    ctx.clearRect(
        0,
        0,
        canvas.width,
        canvas.height
    );
}