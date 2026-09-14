from fastapi import APIRouter

from io_utils.dataset_library import list_datasets

router = APIRouter(prefix="/datasets", tags=["Datasets"])


@router.get("/")
async def get_datasets():
    """List the .h5 scans available in data/datasets, for the dataset picker."""
    return {"datasets": list_datasets()}