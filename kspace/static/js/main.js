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