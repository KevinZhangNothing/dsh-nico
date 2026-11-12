from PIL import Image
import os
d = "assets/sprite"
for f in sorted(os.listdir(d)):
    if not f.endswith(".png"):
        continue
    im = Image.open(os.path.join(d, f))
    px = im.convert("RGBA").load()
    w, h = im.size
    corners = [px[0, 0], px[w-1, 0], px[0, h-1], px[w-1, h-1]]
    print(f, im.mode, im.size, corners)
