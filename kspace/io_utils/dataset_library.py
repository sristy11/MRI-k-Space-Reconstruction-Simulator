from pathlib import Path

# Import the function that reads an H5 file
# and tells us how many MRI slices it contains.
from io_utils.h5_loader import get_num_slices


# Folder where all our .h5 MRI datasets are stored.
DATASET_DIR = Path("data/datasets")


def list_datasets():
    """
    Find all .h5 files inside the dataset folder
    and return their filename and number of slices.

    If a file is corrupted or cannot be opened,
    simply skip that file instead of crashing the program.
    """

    # Make sure the dataset folder exists.
    # If it doesn't exist, Python creates it.
    # parents=True  -> also create missing parent folders.
    # exist_ok=True -> don't give an error if the folder already exists.
    DATASET_DIR.mkdir(parents=True, exist_ok=True)

    # This list will store information about
    # all valid datasets.
    datasets = []

    # Find every file ending with .h5 inside DATASET_DIR.
    # sorted() keeps the files in alphabetical order.
    for path in sorted(DATASET_DIR.glob("*.h5")):

        try:
            # Get the number of MRI slices in this H5 file.
            num_slices = get_num_slices(path)

        except Exception:
            # If the file is corrupted, incomplete,
            # or cannot be opened, skip it.
            continue

        # Add information about this dataset to our list.
        datasets.append({
            "filename": path.name,
            "num_slices": num_slices
        })

    # Return the complete list of valid datasets.
    return datasets


def resolve_dataset_path(filename: str) -> Path:
    """
    Convert a dataset filename into its actual file path.

    This function also protects the application from
    path traversal attacks.

    Example of a dangerous request:
        ../../secrets.h5

    The user should only be able to access files
    inside data/datasets.
    """

    # Take only the filename part of the user's input.
    #
    # For example:
    # "brain.h5" -> "brain.h5"
    #
    # "../../secrets.h5" -> "secrets.h5"
    #
    # This prevents the user from directly including
    # directory paths in the filename.
    candidate = (
        DATASET_DIR / Path(filename).name
    ).resolve()

    # Convert our dataset directory into an absolute path.
    dataset_dir_resolved = DATASET_DIR.resolve()

    # Make sure the requested file is actually inside
    # the data/datasets directory.
    #
    # candidate.parents contains all parent folders
    # of the requested file.
    #
    # If the dataset directory is not one of those parents,
    # the requested path is considered invalid.
    if (
        dataset_dir_resolved not in candidate.parents
        and candidate != dataset_dir_resolved
    ):
        # Stop the function and report an invalid filename.
        raise FileNotFoundError(
            f"Invalid dataset filename: {filename}"
        )

    # Check whether the requested dataset actually exists.
    if not candidate.exists():

        # If it doesn't exist, stop and report the problem.
        raise FileNotFoundError(
            f"Dataset not found: {filename}"
        )

    # Everything is valid.
    # Return the real path of the dataset.
    return candidate