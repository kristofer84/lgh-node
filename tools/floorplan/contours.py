import numpy as np, json
from scipy import ndimage
SCALE=8
owner=np.load('owner.npy'); names=json.load(open('names.json'))
H,W=owner.shape

def trace(mask):
    """Moore-neighbour boundary trace of the largest component; returns pixel loop."""
    lab,n=ndimage.label(mask)
    if n==0: return None
    sizes=ndimage.sum(mask,lab,range(1,n+1))
    mask=(lab==int(np.argmax(sizes))+1)
    ys,xs=np.nonzero(mask)
    sy,sx=ys.min(), xs[ys==ys.min()].min()
    nb=[(0,1),(1,1),(1,0),(1,-1),(0,-1),(-1,-1),(-1,0),(-1,1)]
    start=(sy,sx); cur=start; bdir=4; out=[start]
    for _ in range(4*mask.sum()+10):
        found=False
        for k in range(8):
            d=(bdir+1+k)%8
            ny,nx=cur[0]+nb[d][0], cur[1]+nb[d][1]
            if 0<=ny<H and 0<=nx<W and mask[ny,nx]:
                bdir=(d+4+1)%8 if False else (d+5)%8
                cur=(ny,nx); out.append(cur); found=True; break
        if not found: break
        if cur==start and len(out)>2: break
    return out

def dp(pts, eps):
    """Douglas-Peucker."""
    if len(pts)<3: return pts
    a=np.array(pts,dtype=float)
    def rec(i,j):
        if j<=i+1: return [i]
        p,q=a[i],a[j]; d=q-p; L=np.hypot(*d)
        if L==0: dist=np.hypot(*(a[i+1:j]-p).T)
        else: dist=np.abs(np.cross(d, a[i+1:j]-p))/L
        m=int(np.argmax(dist))
        if dist[m]>eps:
            k=i+1+m
            return rec(i,k)+rec(k,j)
        return [i]
    idx=rec(0,len(a)-1)+[len(a)-1]
    return [pts[i] for i in idx]

rooms={}
for i,n in enumerate(names):
    if i==0: continue
    m=owner==i
    if m.sum()<200: 
        rooms[n]={'skip':'too small','px':int(m.sum())}; continue
    # close small notches so the outline is clean
    m=ndimage.binary_closing(m, np.ones((5,5)))
    loop=trace(m)
    if not loop: continue
    simp=dp(loop, 3.0)          # 3 px tolerance
    pts=[(round(x/SCALE,2), round(y/SCALE,2)) for (y,x) in simp]
    # drop duplicate consecutive
    ded=[pts[0]]
    for p in pts[1:]:
        if p!=ded[-1]: ded.append(p)
    rooms[n]={'points':ded,'raw':len(loop),'simplified':len(ded)}
json.dump(rooms, open('rooms.json','w'), ensure_ascii=False, indent=1)
for n,v in rooms.items():
    print(f"{n:<14} {v.get('simplified','-'):>4} pts (from {v.get('raw','-')})  {v.get('skip','')}")
