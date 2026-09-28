// Shared state read by controls.js — which source the pipeline should use.
window.APP_STATE = { source: null, filename: null, dataset: null, sliceIndex: null };

const fileInput = document.getElementById("fileInput");
const canvasOriginal = document.getElementById("canvasOriginal");
const emptyOriginal = document.getElementById("emptyOriginal");

const statusText = document.getElementById("statusText");
const logList = document.getElementById("logList");


fileInput.addEventListener("change", () => {

    if (fileInput.files.length > 0) {

        const file = fileInput.files[0];
        if (window.clearMRIComparison) window.clearMRIComparison();

        console.log("Selected file:", file);

        // Show image in Canvas A
        displayImage(file);

        // Upload image to FastAPI
        uploadImage(file);
    }
});


function displayImage(file) {

    const image = new Image();

    image.onload = function () {

        // Dataset previews can resize this same canvas to a non-square shape
        // (for example 368x640). If an uploaded photo is drawn afterwards
        // without restoring the backing store, drawImage(..., 256, 256) only
        // fills the top-left corner and the old dataset aspect ratio remains.
        // Reset BOTH the canvas and its frame before drawing the upload.
        const uploadSize = 256;
        canvasOriginal.width = uploadSize;
        canvasOriginal.height = uploadSize;

        const frame = canvasOriginal.closest(".viewcell__frame");
        if (frame) {
            frame.style.setProperty("--ar", "1");
        }

        const ctx = canvasOriginal.getContext("2d");
        ctx.clearRect(0, 0, uploadSize, uploadSize);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";

        // The upload pipeline also converts the photo to 256x256, so the
        // preview now has exactly the same dimensions as the data used for FFT.
        ctx.drawImage(
            image,
            0,
            0,
            uploadSize,
            uploadSize
        );

        emptyOriginal.style.display = "none";
        if (typeof showStep === "function") showStep("canvasOriginal");

        URL.revokeObjectURL(image.src);
    };

    image.src = URL.createObjectURL(file);
}


async function uploadImage(file) {

    statusText.textContent = "uploading...";

    const formData = new FormData();

    formData.append("file", file);

    try {

        const response = await fetch("/upload/", {
            method: "POST",
            body: formData
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.detail || "Upload failed");
        }

        console.log("Server response:", data);

        statusText.textContent = "image loaded";

        window.APP_STATE = { source: "upload", filename: data.filename, dataset: null, sliceIndex: null };

        setForwardFFTVisibility("upload");

        addLog(`uploaded: ${data.filename}`);

    } catch (error) {

        console.error("Upload failed:", error);

        statusText.textContent = "upload failed";

        addLog(`error: ${error.message}`);
    }
}


function addLog(message) {

    // Resolve the live list at write time.  The workspace layout can move
    // panels between containers, so this is more robust than relying only on
    // the reference captured during initial script evaluation.
    const target = document.getElementById("logList") || logList;
    if (!target) return;

    // Remove the startup placeholder as soon as the first real event arrives.
    const idle = target.querySelector(".log__entry--muted");
    if (idle && /console idle/i.test(idle.textContent || "")) idle.remove();

    const entry = document.createElement("li");
    entry.className = "log__entry";
    entry.textContent = message;
    target.appendChild(entry);

    // Keep the newest activity visible while still allowing manual scrolling.
    target.scrollTop = target.scrollHeight;
}


// ---- input source toggle (upload vs dataset) ----

const sourceToggleButtons = document.querySelectorAll(".segmented__option[data-source]");
const uploadSourceBlock = document.getElementById("uploadSourceBlock");
const h5UploadSourceBlock = document.getElementById("h5UploadSourceBlock");
const datasetSourceBlock = document.getElementById("datasetSourceBlock");
const datasetPickerField = document.getElementById("datasetPickerField");
const h5FileInput = document.getElementById("h5FileInput");
const h5Dropzone = document.getElementById("h5Dropzone");
const h5DropzoneLabel = document.getElementById("h5DropzoneLabel");
const h5DropzoneHint = document.getElementById("h5DropzoneHint");
let uploadedH5Dataset = null;
let uploadedH5Meta = null;
let h5UploadInFlight = false;
let activeInputChoice = "upload";

// A real .h5 scan's k-space is already measured data — there is no forward
// FFT step. The same rule applies to an H5 uploaded from Studio and a scan
// selected from the persistent dataset library.
function setForwardFFTVisibility(source) {
    const isRawDataset = source === "dataset" || source === "h5";
    if (typeof btnTransform !== "undefined" && btnTransform) {
        btnTransform.style.display = isRawDataset ? "none" : "";
    }
    if (typeof setSourceLayout === "function") setSourceLayout(isRawDataset ? "dataset" : "upload");
}

function syncInputSourceUI(choice) {
    activeInputChoice = choice;
    uploadSourceBlock.style.display = choice === "upload" ? "" : "none";
    h5UploadSourceBlock.style.display = choice === "h5" ? "" : "none";
    datasetSourceBlock.style.display = (choice === "dataset" || choice === "h5") ? "" : "none";

    if (datasetPickerField) datasetPickerField.style.display = choice === "dataset" ? "" : "none";

    // Until an H5 upload succeeds, do not show controls that would otherwise
    // operate on whichever library dataset happened to be selected earlier.
    const hasH5 = Boolean(uploadedH5Dataset);
    if (choice === "h5") {
        if (sliceField) sliceField.style.display = hasH5 ? "" : "none";
        if (btnLoadDataset) btnLoadDataset.style.display = hasH5 ? "" : "none";
        const reel = document.getElementById("sliceVideoReel");
        if (reel) reel.style.display = hasH5 ? "" : "none";
        if (hasH5) {
            datasetSelect.value = uploadedH5Dataset;
            updateSliceSliderForSelection();
        }
    } else if (choice === "dataset") {
        if (btnLoadDataset) btnLoadDataset.style.display = "";
        const reel = document.getElementById("sliceVideoReel");
        if (reel) reel.style.display = "";
        updateSliceSliderForSelection();
    }

    setForwardFFTVisibility(choice);
}

sourceToggleButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
        sourceToggleButtons.forEach((b) => {
            b.classList.remove("is-active");
            b.setAttribute("aria-checked", "false");
        });
        btn.classList.add("is-active");
        btn.setAttribute("aria-checked", "true");
        syncInputSourceUI(btn.dataset.source);
    });
});


// ---- dataset picker ----

const datasetSelect = document.getElementById("datasetSelect");
const sliceField = document.getElementById("sliceField");
const sliceSlider = document.getElementById("sliceSlider");
const sliceValue = document.getElementById("sliceValue");
const btnLoadDataset = document.getElementById("btnLoadDataset");

function upsertDatasetOption(filename, numSlices) {
    let option = Array.from(datasetSelect.options).find((opt) => opt.value === filename);
    if (!option) {
        option = document.createElement("option");
        datasetSelect.appendChild(option);
    }
    option.value = filename;
    option.dataset.numSlices = String(numSlices);
    option.textContent = `${filename} (${numSlices} slices)`;
    datasetSelect.value = filename;
    updateSliceSliderForSelection();
}

async function readJSONResponse(response) {
    const text = await response.text();
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch (_) {
        return { detail: text };
    }
}

function setH5UploadBusy(isBusy, fileName = "") {
    h5UploadInFlight = isBusy;
    if (h5FileInput) h5FileInput.disabled = isBusy;
    if (h5Dropzone) {
        h5Dropzone.classList.toggle("is-uploading", isBusy);
        h5Dropzone.setAttribute("aria-busy", isBusy ? "true" : "false");
        h5Dropzone.style.pointerEvents = isBusy ? "none" : "";
    }
    if (isBusy) {
        if (h5DropzoneLabel) h5DropzoneLabel.textContent = `Uploading ${fileName || "dataset"}…`;
        if (h5DropzoneHint) h5DropzoneHint.textContent = "uploading and validating k-space — please wait";
    }
}

function ensureUploadedH5Option() {
    if (!uploadedH5Meta || !uploadedH5Dataset) return;
    upsertDatasetOption(uploadedH5Dataset, uploadedH5Meta.num_slices);
    datasetSelect.value = uploadedH5Dataset;
}

async function uploadH5Dataset(file) {
    if (!file || h5UploadInFlight) return;

    const lowerName = (file.name || "").toLowerCase();
    if (!(lowerName.endsWith(".h5") || lowerName.endsWith(".hdf5"))) {
        statusText.textContent = "invalid H5 file";
        addLog("error: choose an .h5 or .hdf5 dataset");
        return;
    }
    if (!file.size) {
        statusText.textContent = "empty H5 file";
        addLog("error: selected H5 file is empty");
        return;
    }

    const formData = new FormData();
    formData.append("file", file, file.name);
    statusText.textContent = "uploading H5 dataset...";
    setH5UploadBusy(true, file.name);

    try {
        const response = await fetch("/upload/h5", { method: "POST", body: formData });
        const data = await readJSONResponse(response);
        if (!response.ok) throw new Error(data.detail || `H5 upload failed (${response.status})`);

        uploadedH5Dataset = data.filename;
        uploadedH5Meta = {
            filename: data.filename,
            num_slices: Number(data.num_slices) || 1,
            kspace_shape: Array.isArray(data.kspace_shape) ? data.kspace_shape : [],
        };

        // Do not rely on the initial /datasets request finishing in a particular
        // order. Re-insert/select the uploaded H5 after every refresh so a stale
        // library response cannot make a successful upload look like it failed.
        ensureUploadedH5Option();

        if (sliceField) sliceField.style.display = "";
        if (btnLoadDataset) btnLoadDataset.style.display = "";
        const reel = document.getElementById("sliceVideoReel");
        if (reel) reel.style.display = "";

        const middleSlice = Math.floor(uploadedH5Meta.num_slices / 2);
        sliceSlider.max = Math.max(0, uploadedH5Meta.num_slices - 1);
        sliceSlider.value = middleSlice;
        sliceValue.textContent = String(middleSlice);

        if (h5DropzoneLabel) h5DropzoneLabel.textContent = data.filename;
        if (h5DropzoneHint) {
            const shape = uploadedH5Meta.kspace_shape.length ? uploadedH5Meta.kspace_shape.join(" × ") : "k-space";
            const reuseText = data.reused ? "already available · reused" : "uploaded";
            h5DropzoneHint.textContent = `${uploadedH5Meta.num_slices} slices · ${shape} · ${reuseText}`;
        }
        statusText.textContent = data.reused
            ? `H5 ready · existing file reused · ${uploadedH5Meta.num_slices} slices`
            : `H5 ready · ${uploadedH5Meta.num_slices} slices`;
        addLog(data.reused
            ? `H5 already exists: reused ${data.filename} (${uploadedH5Meta.num_slices} slices)`
            : `uploaded H5: ${data.filename} (${uploadedH5Meta.num_slices} slices)`);

        // Use explicit values rather than reading the select element again. This
        // removes the race with the asynchronous dataset-library refresh.
        await loadSelectedDatasetSlice(uploadedH5Dataset, middleSlice);

        // A list request that began before this upload may finish later; keeping
        // this option in metadata lets loadDatasetList() restore it deterministically.
        ensureUploadedH5Option();
    } catch (error) {
        console.error("H5 upload failed:", error);
        statusText.textContent = "H5 upload failed";
        addLog(`error: ${error.message}`);
        if (h5DropzoneLabel) h5DropzoneLabel.textContent = "Upload an H5 MRI dataset";
        if (h5DropzoneHint) h5DropzoneHint.textContent = ".h5 / .hdf5 · requires a complex-valued “kspace” dataset";
    } finally {
        setH5UploadBusy(false);
        if (h5FileInput) h5FileInput.value = "";
    }
}

if (h5FileInput) {
    h5FileInput.addEventListener("change", () => {
        if (h5FileInput.files && h5FileInput.files[0]) uploadH5Dataset(h5FileInput.files[0]);
    });
}

if (h5Dropzone) {
    ["dragenter", "dragover"].forEach((eventName) => {
        h5Dropzone.addEventListener(eventName, (event) => {
            event.preventDefault();
            h5Dropzone.classList.add("is-dragover");
        });
    });
    ["dragleave", "drop"].forEach((eventName) => {
        h5Dropzone.addEventListener(eventName, (event) => {
            event.preventDefault();
            h5Dropzone.classList.remove("is-dragover");
        });
    });
    h5Dropzone.addEventListener("drop", (event) => {
        const file = event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files[0] : null;
        if (file) uploadH5Dataset(file);
    });
}

async function loadDatasetList() {
    try {
        const response = await fetch("/datasets/");
        const data = await response.json();

        datasetSelect.innerHTML = "";

        if (!data.datasets || data.datasets.length === 0) {
            const opt = document.createElement("option");
            opt.value = "";
            opt.textContent = "no datasets found in data/datasets";
            datasetSelect.appendChild(opt);
            sliceField.style.display = "none";
            return;
        }

        data.datasets.forEach((ds) => {
            const opt = document.createElement("option");
            opt.value = ds.filename;
            opt.dataset.numSlices = ds.num_slices;
            opt.textContent = `${ds.filename} (${ds.num_slices} slices)`;
            datasetSelect.appendChild(opt);
        });

        if (uploadedH5Meta && uploadedH5Dataset) {
            ensureUploadedH5Option();
        }
        if (activeInputChoice === "h5" && uploadedH5Dataset) {
            datasetSelect.value = uploadedH5Dataset;
        }
        updateSliceSliderForSelection();
    } catch (error) {
        console.error("Failed to load dataset list:", error);
        datasetSelect.innerHTML = '<option value="">failed to load datasets</option>';
    }
}

function updateSliceSliderForSelection() {
    const selectedOption = datasetSelect.options[datasetSelect.selectedIndex];
    const numSlices = selectedOption ? parseInt(selectedOption.dataset.numSlices, 10) : 0;

    if (!numSlices) {
        sliceField.style.display = "none";
        return;
    }

    sliceField.style.display = "";
    sliceSlider.max = numSlices - 1;
    sliceSlider.value = Math.floor(numSlices / 2);
    sliceValue.textContent = sliceSlider.value;
}

datasetSelect.addEventListener("change", updateSliceSliderForSelection);

sliceSlider.addEventListener("input", () => {
    sliceValue.textContent = sliceSlider.value;
});

async function loadSelectedDatasetSlice(datasetOverride = null, sliceIndexOverride = null) {
    // This function is also triggered from UI events. Never allow a click/
    // pointer Event object to become the dataset payload (FastAPI would reject
    // that with HTTP 422 because DatasetPreviewRequest.dataset must be a string).
    const explicitDataset = typeof datasetOverride === "string" ? datasetOverride.trim() : "";
    const dataset = explicitDataset || datasetSelect.value;

    if (!dataset) {
        statusText.textContent = "no dataset selected";
        addLog("error: no dataset selected");
        return;
    }

    const hasExplicitSlice = typeof sliceIndexOverride === "number" || typeof sliceIndexOverride === "string";
    const requestedSlice = hasExplicitSlice
        ? parseInt(sliceIndexOverride, 10)
        : parseInt(sliceSlider.value, 10);
    const sliceIndex = Number.isFinite(requestedSlice) ? requestedSlice : 0;

    if (window.clearMRIComparison) window.clearMRIComparison();
    statusText.textContent = "loading dataset slice...";

    try {
        const response = await fetch("/pipeline/dataset-preview", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dataset, slice_index: sliceIndex }),
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.detail || "Failed to load dataset slice");
        }

        renderGrayscale(canvasOriginal, data.reference);
        emptyOriginal.style.display = "none";
        if (typeof showStep === "function") showStep("canvasOriginal");

        sliceSlider.max = data.num_slices - 1;
        sliceSlider.value = data.slice_index;
        sliceValue.textContent = data.slice_index;

        window.APP_STATE = { source: "dataset", filename: null, dataset, sliceIndex: data.slice_index };

        setForwardFFTVisibility("dataset");

        statusText.textContent = `loaded ${dataset} · slice ${data.slice_index}`;
        addLog(`loaded ${dataset} (slice ${data.slice_index}/${data.num_slices - 1}) — showing actual scan`);

        // The k-space here is already the real measured data — no forward FFT
        // needed, just fetch and display it directly.
        try {
            const fftData = await postJSON("/pipeline/fft", {
                source: "dataset",
                dataset,
                slice_index: data.slice_index,
            });
            renderGrayscale(canvasKspaceFull, fftData.kspace_full);
            emptyKspaceFull.style.display = "none";
            if (typeof showStep === "function") showStep("canvasKspaceFull");
            addLog("k-space shown: raw measured data (no FFT needed)");

            window.LAST_KSPACE_FULL = fftData.kspace_full;
            if (typeof drawPaintCanvas === "function") drawPaintCanvas();
        } catch (err) {
            addLog(`error loading k-space: ${err.message}`);
        }
    } catch (error) {
        console.error("Dataset load failed:", error);
        statusText.textContent = "dataset load failed";
        addLog(`error: ${error.message}`);
    }
}

btnLoadDataset.addEventListener("click", () => loadSelectedDatasetSlice());

loadDatasetList();