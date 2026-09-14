from pathlib import Path

# Import the function that actually loads the image,
# converts it to grayscale, resizes it, and normalizes
# its pixel values.
from kspace_core.fft import load_image_as_array


def load_uploaded_image(
    filename: str,
    upload_dir: str = "uploads",
    size: int = 256
):
    """
    Load an image that was previously uploaded by the user.

    The uploaded image is converted into a normalized
    grayscale NumPy array so that it can be used by
    the MRI k-space processing pipeline.

    filename:
        Name of the uploaded image file.

    upload_dir:
        Folder where uploaded images are stored.
        Default is "uploads".

    size:
        Desired image size.
        Default is 256 x 256 pixels.
    """

    # Create the path to the uploaded image.
    #
    # For example:
    #
    # upload_dir = "uploads"
    # filename   = "brain.png"
    #
    # Then:
    #
    # path = uploads/brain.png
    path = Path(upload_dir) / filename

    # Check whether the uploaded image actually exists.
    #
    # .exists() returns:
    # True  -> file exists
    # False -> file does not exist
    if not path.exists():

        # If the file doesn't exist, stop the function
        # and tell the program that the file was not found.
        raise FileNotFoundError(
            f"Uploaded file not found: {path}"
        )

    # Load the image using load_image_as_array().
    #
    # This function handles the actual image processing:
    #
    # 1. Open the image
    # 2. Convert it to grayscale
    # 3. Resize it to 256 x 256
    # 4. Convert it into a NumPy array
    # 5. Normalize pixel values
    #
    # str(path) converts the Path object into a normal string.
    #
    # Example:
    # Path("uploads/brain.png")
    #
    # becomes:
    # "uploads/brain.png"
    return load_image_as_array(
        str(path),
        size=size
    )
