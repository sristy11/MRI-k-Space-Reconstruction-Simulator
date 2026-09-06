from fastapi import APIRouter, UploadFile, File, HTTPException
from pathlib import Path
import shutil


router = APIRouter(
    prefix="/upload",
    tags=["Upload"]
)


UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


@router.post("/")
async def upload_image(file: UploadFile = File(...)):

    # Check that the uploaded file is an image
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(
            status_code=400,
            detail="Please upload an image file."
        )

    filename = Path(file.filename).name
    file_path = UPLOAD_DIR / filename

    with file_path.open("wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    return {
        "message": "Image uploaded successfully",
        "filename": filename,
        "path": str(file_path)
    }