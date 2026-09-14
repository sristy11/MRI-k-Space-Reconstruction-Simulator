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

        const ctx = canvasOriginal.getContext("2d");

        ctx.clearRect(
            0,
            0,
            canvasOriginal.width,
            canvasOriginal.height
        );

        ctx.drawImage(
            image,
            0,
            0,
            256,
            256
        );

        emptyOriginal.style.display = "none";

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

    const entry = document.createElement("li");

    entry.className = "log__entry";

    entry.textContent = message;

    logList.appendChild(entry);
}


// ---- input source toggle (upload vs dataset) ----

const sourceToggleButtons = document.querySelectorAll(".segmented__option[data-source]");
const uploadSourceBlock = document.getElementById("uploadSourceBlock");
const datasetSourceBlock = document.getElementById("datasetSourceBlock");

// A real .h5 scan's k-space is already the measured data — there's nothing to
// "forward FFT" from, unlike an uploaded photo where we synthesize k-space
// ourselves. So that button (and step) only makes sense in upload mode.
function setForwardFFTVisibility(source) {
    if (typeof btnTransform !== "undefined" && btnTransform) {
        btnTransform.style.display = source === "dataset" ? "none" : "";
    }
}

sourceToggleButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
        sourceToggleButtons.forEach((b) => {
            b.classList.remove("is-active");
            b.setAttribute("aria-checked", "false");
        });
        btn.classList.add("is-active");
        btn.setAttribute("aria-checked", "true");

        const choice = btn.dataset.source;
        uploadSourceBlock.style.display = choice === "upload" ? "" : "none";
        datasetSourceBlock.style.display = choice === "dataset" ? "" : "none";
        setForwardFFTVisibility(choice);
    });
});


// ---- dataset picker ----

const datasetSelect = document.getElementById("datasetSelect");
const sliceField = document.getElementById("sliceField");
const sliceSlider = document.getElementById("sliceSlider");
const sliceValue = document.getElementById("sliceValue");
const btnLoadDataset = document.getElementById("btnLoadDataset");

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

btnLoadDataset.addEventListener("click", async () => {
    const dataset = datasetSelect.value;

    if (!dataset) {
        statusText.textContent = "no dataset selected";
        addLog("error: no dataset selected");
        return;
    }

    const sliceIndex = parseInt(sliceSlider.value, 10);

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
            addLog("k-space shown: raw measured data (no FFT needed)");
        } catch (err) {
            addLog(`error loading k-space: ${err.message}`);
        }
    } catch (error) {
        console.error("Dataset load failed:", error);
        statusText.textContent = "dataset load failed";
        addLog(`error: ${error.message}`);
    }
});

loadDatasetList();