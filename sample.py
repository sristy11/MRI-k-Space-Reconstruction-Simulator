import h5py

with h5py.File("kspace/data/datasets/file1000007.h5", "r") as f:

    def print_structure(name, obj):
        print(name, "->", obj)

    # Print the complete structure of the HDF5 file
    f.visititems(print_structure)

    # Print only the top-level keys
    print("Top-level keys:", list(f.keys()))