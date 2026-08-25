import numpy as np, json
from collections import deque

SCALE = 8
img = np.load('img.npy'); H, W = img.shape
free = (img > 250)

labels = json.load(open('seed_rooms.json'))
# Disambiguate the two Klk2 labels by vertical position
seen = {}
seeds = []
for name, x, y in labels:
    n = name
    if name in seen:
        seen[name] += 1
        n = f'{name}#{seen[name]}'
    else:
        seen[name] = 1
    seeds.append((n, int(x*SCALE), int(y*SCALE)))

owner = np.zeros((H, W), dtype=np.int16)   # 0 = unclaimed
names = ['']
q = deque()
for i, (n, px, py) in enumerate(seeds, start=1):
    names.append(n)
    # nudge to a free pixel near the label anchor (text baseline may sit on ink)
    found = False
    for r in range(0, 60):
        for dy in range(-r, r+1):
            for dx in range(-r, r+1):
                yy, xx = py+dy, px+dx
                if 0 <= yy < H and 0 <= xx < W and free[yy, xx] and owner[yy, xx] == 0:
                    owner[yy, xx] = i; q.append((yy, xx)); found = True; break
            if found: break
        if found: break
    if not found: print('NO SEED for', n)

# Multi-source BFS = geodesic Voronoi within free space; rooms split at doorways
while q:
    y, x = q.popleft()
    o = owner[y, x]
    if y > 0   and free[y-1, x] and owner[y-1, x] == 0: owner[y-1, x] = o; q.append((y-1, x))
    if y < H-1 and free[y+1, x] and owner[y+1, x] == 0: owner[y+1, x] = o; q.append((y+1, x))
    if x > 0   and free[y, x-1] and owner[y, x-1] == 0: owner[y, x-1] = o; q.append((y, x-1))
    if x < W-1 and free[y, x+1] and owner[y, x+1] == 0: owner[y, x+1] = o; q.append((y, x+1))

np.save('owner.npy', owner)
json.dump(names, open('names.json', 'w'))
print(f'{"room":<14}{"px area":>10}{"m2 approx":>12}')
for i, n in enumerate(names):
    if i == 0: continue
    a = int((owner == i).sum())
    print(f'{n:<14}{a:>10}{a/(SCALE*SCALE):>11.1f}u2')
