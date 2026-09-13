from pathlib import Path

from kspace_core.fft import load_image_as_array


def load_uploaded_image(filename: str, upload_dir: str = "uploads", size: int = 256):
    """
    Load a previously-uploaded image (see routes/upload.py) as a
    normalized grayscale array, ready to feed into the k-space pipeline.

    filename: name of the file as saved by the /upload/ route
    upload_dir: folder the upload route saves into (relative to CWD)
    size: resize target - must match the <canvas> dimensions in the UI (256x256)
    """
    path = Path(upload_dir) / filename

    if not path.exists():
        raise FileNotFoundError(f"Uploaded file not found: {path}")

    return load_image_as_array(str(path), size=size)