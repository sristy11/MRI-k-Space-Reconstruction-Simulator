import numpy as np


def radial_mask(shape, acceleration=4):
    """
    Radial undersampling: sample along spokes passing through the center,
    at various angles, rather than along horizontal lines like Cartesian.
    Radial trajectories naturally oversample the center (low frequencies)
    and undersample the edges (high frequencies), which tends to produce
    streak-like artifacts instead of Cartesian's line-ghosting.

    shape: (rows, cols) of the k-space array
    acceleration: higher = fewer spokes = more undersampling
    """
    rows, cols = shape
    mask = np.zeros((rows, cols), dtype=np.float64)

    center_row, center_col = rows // 2, cols // 2
    # Max radius needed to reach the corners of the array
    max_radius = int(np.ceil(np.sqrt(center_row**2 + center_col**2)))

    # Number of spokes: full sampling would use ~pi * max(rows,cols) spokes
    # for Nyquist-like coverage; we divide by acceleration to undersample
    num_spokes = max(1, int((np.pi * max(rows, cols)) / acceleration))

    angles = np.linspace(0, np.pi, num_spokes, endpoint=False)

    for theta in angles:
        dx, dy = np.cos(theta), np.sin(theta)
        for r in range(-max_radius, max_radius + 1):
            row = int(round(center_row + r * dy))
            col = int(round(center_col + r * dx))
            if 0 <= row < rows and 0 <= col < cols:
                mask[row, col] = 1

    return mask