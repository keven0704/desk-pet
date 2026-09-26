import numpy as np
from PIL import Image, ImageFilter
from collections import deque

# -*- coding: utf-8 -*-
# 针对「噜噜2.png」：源图为自带 alpha 的 RGBA PNG（本体 alpha≈250-254，
# 外围是 alpha 渐变的半透明白晕）。
# 管线：alpha>=245 取本体 -> MinFilter(5)+GaussianBlur(1.2) 收边（与用户确认过的版本一致）
#       -> 裁 6px 边距、LANCZOS 缩至高 480
import numpy as np
from PIL import Image, ImageFilter
from collections import deque

SRC = r"C:\Users\hp\Desktop\噜噜2.png"
DST = r"c:\Users\hp\desk-pet\assets\pet.png"

img = Image.open(SRC).convert("RGBA")
arr = np.asarray(img)
a = arr[..., 3]

# 最大连通体，防残块（8 邻接 BFS）
solid = a >= 245
h, w = solid.shape
labels = np.zeros((h, w), dtype=np.int32)
cur = 0
sizes = {}
for y in range(h):
    for x in range(w):
        if solid[y, x] and labels[y, x] == 0:
            cur += 1
            q = deque([(y, x)])
            labels[y, x] = cur
            n = 0
            while q:
                cy, cx = q.popleft()
                n += 1
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        ny, nx = cy + dy, cx + dx
                        if 0 <= ny < h and 0 <= nx < w and solid[ny, nx] and labels[ny, nx] == 0:
                            labels[ny, nx] = cur
                            q.append((ny, nx))
            sizes[cur] = n

best = max(sizes, key=sizes.get) if sizes else None
print("components:", sorted(sizes.values(), reverse=True)[:5])
keep = labels == best

alpha = np.where(keep, arr[..., 3], 0).astype(np.uint8)
a_img = Image.fromarray(alpha, "L")

# 收边去残晕 + 羽化（参数与用户确认过的上一版一致）
a_img = a_img.filter(ImageFilter.MinFilter(5)).filter(ImageFilter.GaussianBlur(1.2))

out = img.copy()
out.putalpha(a_img)

# 裁剪到内容区（留 6px 边距）
bbox = a_img.getbbox()
if bbox:
    l, t, r, b = bbox
    l = max(0, l - 6); t = max(0, t - 6)
    r = min(w, r + 6); b = min(h, b + 6)
    out = out.crop((l, t, r, b))

# 缩放到高 480
ratio = 480 / out.height
out = out.resize((max(1, round(out.width * ratio)), 480), Image.LANCZOS)
out.save(DST)
print("saved", DST, out.size)

