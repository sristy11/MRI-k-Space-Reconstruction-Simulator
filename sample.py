import h5py

f = h5py.File("file1000007.h5", "r")

print(list(f.keys()))
print(type(f['ismrmrd_header']))