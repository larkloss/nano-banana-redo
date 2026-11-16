"""Builds local-edit test cases from real photos (scikit-image's sample
pictures, read from the installed package).

  python sim.py [scenario ids]   -> cases/<id>__<level>/

For each case:
  orig.png   - the picture being edited
  ideal.png  - orig with ONLY the intended edit applied (ground truth)
  result.png - what an image model might return: the edited picture,
               repainted as a whole (shift/scale, smooth warp, texture
               redraw, colour drift, JPEG), optionally at a lower resolution
  gt.png     - where the intended edit is (soft mask)
  meta.json  - arrow tips, regions that must stay untouched, expectation
"""
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'cases')


def photo_path(name):
    import skimage

    return os.path.join(os.path.dirname(skimage.__file__), 'data', name)


def load(name, scale):
    im = Image.open(photo_path(name)).convert('RGB')
    if scale != 1:
        im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
    return np.asarray(im).astype(np.float32)


def ellipse(H, W, cx, cy, rx, ry, angle=0.0):
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    x = xx - cx
    y = yy - cy
    a = np.deg2rad(angle)
    xr = x * np.cos(a) + y * np.sin(a)
    yr = -x * np.sin(a) + y * np.cos(a)
    return (xr / rx) ** 2 + (yr / ry) ** 2 <= 1.0


def rect(H, W, x0, y0, x1, y1):
    m = np.zeros((H, W), bool)
    m[int(y0):int(y1), int(x0):int(x1)] = True
    return m


# --- edits -------------------------------------------------------------------

def fill(img, mask, rng):
    """Object removal: fill the hole from its surroundings (coarse-to-fine
    normalised convolution), plus a little texture so it isn't flat."""
    known = (~mask).astype(np.float32)
    out = img.copy()
    est = None
    for sigma in [96, 48, 24, 12, 6, 3]:
        wgt = ndimage.gaussian_filter(known, sigma)
        cur = np.stack([ndimage.gaussian_filter(img[..., c] * known, sigma) for c in range(3)], -1)
        cur = cur / np.maximum(wgt, 1e-6)[..., None]
        ok = (wgt > 0.03)[..., None]
        est = cur if est is None else np.where(ok, cur, est)
    tex = ndimage.gaussian_filter(rng.normal(0, 5, img.shape[:2]), 1.0)[..., None]
    out[mask] = (est + tex)[mask]
    return out


def rgb_to_hsv(rgb):
    r, g, b = [rgb[..., i] / 255.0 for i in range(3)]
    mx = np.max(rgb / 255.0, -1)
    mn = np.min(rgb / 255.0, -1)
    d = mx - mn
    h = np.zeros_like(mx)
    nz = d > 1e-6
    rm = nz & (mx == r)
    gm = nz & (mx == g) & ~rm
    bm = nz & ~rm & ~gm
    h[rm] = ((g - b)[rm] / d[rm]) % 6
    h[gm] = (b - r)[gm] / d[gm] + 2
    h[bm] = (r - g)[bm] / d[bm] + 4
    h = h / 6.0
    s = np.where(mx > 1e-6, d / np.maximum(mx, 1e-6), 0)
    return np.stack([h, s, mx], -1)


def hsv_to_rgb(hsv):
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    i = np.floor(h * 6).astype(int) % 6
    f = h * 6 - np.floor(h * 6)
    p = v * (1 - s)
    q = v * (1 - f * s)
    t = v * (1 - (1 - f) * s)
    choices = [
        np.stack([v, t, p], -1), np.stack([q, v, p], -1), np.stack([p, v, t], -1),
        np.stack([p, q, v], -1), np.stack([t, p, v], -1), np.stack([v, p, q], -1),
    ]
    out = np.zeros(h.shape + (3,))
    for k in range(6):
        out[i == k] = choices[k][i == k]
    return out * 255.0


def recolor(img, mask, rng, shift=0.45, sat=1.25):
    hsv = rgb_to_hsv(img)
    hsv[..., 0] = (hsv[..., 0] + shift) % 1.0
    hsv[..., 1] = np.clip(np.maximum(hsv[..., 1], 0.35) * sat, 0, 1)
    out = img.copy()
    out[mask] = hsv_to_rgb(hsv)[mask]
    return out


def brighten(img, mask, rng, k=1.07):
    out = img.copy()
    out[mask] = np.clip(img[mask] * k + 3, 0, 255)
    return out


def paint_blob(img, mask, rng, color=(205, 30, 40)):
    yy, xx = np.nonzero(mask)
    cy, cx = yy.mean(), xx.mean()
    r = max(np.ptp(yy), np.ptp(xx)) / 2 + 1
    Y, X = np.mgrid[0:img.shape[0], 0:img.shape[1]]
    shade = 0.75 + 0.25 * np.clip(1 - np.hypot(X - cx + r * 0.3, Y - cy + r * 0.3) / (1.6 * r), 0, 1)
    out = img.copy()
    blob = np.array(color, np.float32)[None, None, :] * shade[..., None]
    out[mask] = blob[mask]
    return out


EDITS = {'fill': fill, 'recolor': recolor, 'brighten': brighten, 'blob': paint_blob}


def apply_edit(img, mask, kind, rng):
    edited = EDITS[kind](img, mask, rng)
    soft = ndimage.gaussian_filter(mask.astype(np.float32), 1.5)[..., None]
    return img * (1 - soft) + edited * soft, soft[..., 0]


# --- the model's repaint --------------------------------------------------------

LEVELS = {
    'mild': dict(shift=3.0, scale=0.004, warp=0.6, noise=2.0, tone=0.025, jpeg=90),
    'strong': dict(shift=6.0, scale=0.009, warp=1.3, noise=4.0, tone=0.05, jpeg=82),
    'warped': dict(shift=6.0, scale=0.018, warp=1.5, noise=3.0, tone=0.04, jpeg=85, rot=0.6),
}


def repaint(I, rng, level, out_scale=1.0):
    P = LEVELS[level]
    H, W, _ = I.shape
    tx, ty = rng.uniform(-P['shift'], P['shift'], 2)
    sc = 1 + rng.uniform(-P['scale'], P['scale'])
    gx = ndimage.zoom(rng.normal(size=(6, 6)), (H / 6, W / 6), order=3)[:H, :W] * P['warp']
    gy = ndimage.zoom(rng.normal(size=(6, 6)), (H / 6, W / 6), order=3)[:H, :W] * P['warp']
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    rot = np.deg2rad(rng.uniform(-1, 1) * P.get('rot', 0.0))
    X = (xx - W / 2 - tx) / sc
    Y = (yy - H / 2 - ty) / sc
    srcx = X * np.cos(rot) + Y * np.sin(rot) + W / 2 + gx
    srcy = -X * np.sin(rot) + Y * np.cos(rot) + H / 2 + gy
    out = np.stack([ndimage.map_coordinates(I[..., c], [srcy, srcx], order=3, mode='reflect') for c in range(3)], -1)
    # texture redraw: soften, re-sharpen differently, fresh fine detail
    out = ndimage.gaussian_filter(out, (0.6, 0.6, 0))
    out = out + 0.5 * (out - ndimage.gaussian_filter(out, (1.5, 1.5, 0)))
    noise = rng.normal(0, P['noise'], (H, W, 1)) + rng.normal(0, P['noise'] * 0.4, (H, W, 3))
    noise = noise - ndimage.gaussian_filter(noise, (2, 2, 0))
    out = out + noise
    # global colour drift
    gains = 1 + rng.uniform(-P['tone'], P['tone'], 3)
    offs = rng.uniform(-4, 4, 3)
    gamma = 1 + rng.uniform(-0.03, 0.03)
    out = 255 * (np.clip(out, 0, 255) / 255) ** gamma
    out = np.clip(out * gains + offs, 0, 255)
    im = Image.fromarray(out.astype(np.uint8))
    if out_scale != 1.0:
        im = im.resize((round(W * out_scale), round(H * out_scale)), Image.LANCZOS)
    path = os.path.join(OUT, '_tmp.jpg')
    im.save(path, quality=P['jpeg'])
    return Image.open(path).convert('RGB')


# --- objects that are in the original and gone from the ideal ----------------------

def smooth_photo(img, sigma, seed):
    """The photo without its fine texture (smooth skin, plain cloth), plus camera grain."""
    sm = np.stack([ndimage.gaussian_filter(img[..., c], sigma) for c in range(3)], -1)
    rng = np.random.default_rng(seed)
    return np.clip(sm + rng.normal(0, 1.5, sm.shape), 0, 255).astype(np.float32)


def add_limb(base, m, lift, shade, contour, width):
    """A limb-like object made of what is under it (an arm across a torso): the same
    material, `lift` levels brighter, shaded like a rounded form, with a dark contour
    `width` px wide and a soft drop shadow. Inside, old and new look alike; what differs
    clearly is the outline. Returns the picture with it and where it is."""
    soft = ndimage.gaussian_filter(m.astype(np.float32), 1.0)
    depth = ndimage.distance_transform_edt(m)
    depth = depth / max(1.0, depth.max())
    obj = np.clip(base * (1 - shade + 2 * shade * np.sqrt(depth))[..., None] + lift, 0, 255)
    rim = ndimage.gaussian_filter((m ^ ndimage.binary_erosion(m, iterations=max(1, width))).astype(np.float32), 0.8 * width)
    rim = np.clip(rim * 2.0, 0, 1) * contour
    ys, xs = np.nonzero(m)
    size = min(ys.max() - ys.min(), xs.max() - xs.min()) / 2
    shadow = ndimage.gaussian_filter(np.roll(np.roll(m.astype(np.float32), int(0.1 * size), 0), int(0.06 * size), 1), 0.12 * size) * 0.25
    out = base * (1 - shadow[..., None] * (1 - soft[..., None]))
    out = out * (1 - soft[..., None]) + obj * soft[..., None]
    out = out * (1 - rim[..., None])
    where = np.clip(np.maximum(soft, np.maximum(rim, shadow * 2 * (1 - soft))), 0, 1)
    return out, where


# --- scenarios ------------------------------------------------------------------
# Coordinates are in the photo's native pixels; `scale` upsizes the original.

FACE_A = ('ellipse', 225, 122, 46, 60)

SCENARIOS = [
    dict(id='A-remove-patch', photo='astronaut.png', scale=2,
         edits=[('fill', ('ellipse', 170, 385, 42, 42))], arrows=[(170, 385)], protect=[FACE_A]),
    dict(id='A-recolor-nametag', photo='astronaut.png', scale=2,
         edits=[('recolor', ('rect', 279, 340, 328, 373))], arrows=[(303, 356)], protect=[FACE_A]),
    dict(id='A-remove-shuttle', photo='astronaut.png', scale=2,
         edits=[('fill', ('rect', 352, 0, 470, 300))], arrows=[(405, 150)], protect=[FACE_A]),
    dict(id='A-hood-ring', photo='astronaut.png', scale=2,
         edits=[('recolor', ('ring', 225, 118, 98, 110, 60, 76))], arrows=[(225, 18)], protect=[('ellipse', 225, 124, 40, 52)]),
    dict(id='A-add-badge', photo='astronaut.png', scale=2,
         edits=[('blob', ('ellipse', 120, 300, 22, 22))], arrows=[(120, 300)], protect=[FACE_A]),
    dict(id='A-subtle-helmet', photo='astronaut.png', scale=2,
         edits=[('brighten', ('ellipse', 395, 430, 85, 65))], arrows=[(395, 440)], protect=[FACE_A], expect='any'),
    dict(id='A-noop', photo='astronaut.png', scale=2,
         edits=[], arrows=[(170, 385)], protect=[FACE_A], expect='reject'),
    dict(id='A-ignored', photo='astronaut.png', scale=2,
         edits=[('recolor', ('ellipse', 395, 430, 85, 65))], arrows=[(170, 385)], protect=[FACE_A], expect='reject'),
    dict(id='A-two-arrows', photo='astronaut.png', scale=2,
         edits=[('fill', ('ellipse', 170, 385, 42, 42)), ('recolor', ('rect', 279, 340, 328, 373))],
         arrows=[(170, 385), (303, 356)], protect=[FACE_A]),
    dict(id='A-hires', photo='astronaut.png', scale=4, out_scale=0.5,
         edits=[('fill', ('ellipse', 170, 385, 42, 42))], arrows=[(170, 385)], protect=[FACE_A]),
    # (known limit: the handle, cut off from the bowl by the cup's rim, is only
    # partly taken — hence the allowance for what may be left)
    dict(id='C-remove-spoon', photo='coffee.png', scale=1.5, left_max=35,
         edits=[('fill', ('union', [('ellipse', 365, 288, 40, 44, 0), ('ellipse', 398, 170, 13, 100, -8)]))],
         arrows=[(365, 290)], protect=[('ellipse', 290, 150, 95, 55)]),
    dict(id='C-recolor-saucer', photo='coffee.png', scale=1.5,
         edits=[('recolor', ('minus', ('ellipse', 280, 235, 205, 150, 0), ('ellipse', 290, 150, 125, 135, 0)))],
         arrows=[(130, 290)], protect=[('ellipse', 290, 140, 90, 70)]),
    dict(id='A-collar-recolor', photo='astronaut.png', scale=2,
         edits=[('recolor', ('and', ('ring', 210, 222, 98, 76, 78, 56), ('rect', 0, 205, 512, 512)))],
         arrows=[(150, 270)], protect=[FACE_A]),
    dict(id='A-earring', photo='astronaut.png', scale=2,
         edits=[('blob', ('ellipse', 162, 143, 8, 8))], arrows=[(162, 143)], protect=[('ellipse', 228, 124, 42, 56)]),
    dict(id='A-warped-patch', photo='astronaut.png', scale=2, levels=['warped'],
         edits=[('fill', ('ellipse', 170, 385, 42, 42))], arrows=[(170, 385)], protect=[FACE_A]),
    dict(id='A-border-helmet', photo='astronaut.png', scale=2,
         edits=[('fill', ('ellipse', 488, 420, 40, 55))], arrows=[(490, 420)], protect=[FACE_A]),
    dict(id='A-4k', photo='astronaut.png', scale=8, levels=['mild'],
         edits=[('fill', ('ellipse', 170, 385, 42, 42))], arrows=[(170, 385)], protect=[FACE_A]),
    dict(id='K-recolor-eye', photo='chelsea.png', scale=2,
         edits=[('recolor', ('ellipse', 170, 113, 34, 28))], arrows=[(170, 113)],
         protect=[('ellipse', 318, 135, 28, 25), ('ellipse', 263, 243, 26, 18)]),
    dict(id='K-recolor-nose', photo='chelsea.png', scale=2,
         edits=[('recolor', ('ellipse', 263, 243, 28, 19))], arrows=[(263, 243)],
         protect=[('ellipse', 170, 113, 30, 25), ('ellipse', 318, 135, 28, 25)]),
    # An object that looks like what is behind it, removed: `smooth` takes the
    # photo's texture away, `objects` are in the original and not in the ideal
    dict(id='S-arm', photo='astronaut.png', scale=2, smooth=5,
         objects=[(('ellipse', 180, 360, 30, 95, 30), dict(lift=10, shade=0.05, contour=0.35, width=3))],
         arrows=[(180, 360)], protect=[FACE_A]),
    # (known limit: under a heavy repaint part of a large one is still left)
    dict(id='S-arm-large', photo='astronaut.png', scale=2, smooth=5, left_max=30,
         objects=[(('ellipse', 180, 360, 45, 150, 30), dict(lift=10, shade=0.05, contour=0.35, width=3))],
         arrows=[(180, 360)], protect=[FACE_A]),
    # (known limit: a hairline outline is not enough to go by — 'any' until it is)
    dict(id='S-arm-thin-line', photo='astronaut.png', scale=2, smooth=5, levels=['mild'], expect='any', left_max=100,
         objects=[(('ellipse', 180, 360, 45, 150, 30), dict(lift=10, shade=0.02, contour=0.35, width=1))],
         arrows=[(180, 360)], protect=[FACE_A]),
    # The same with the thing's extent known (the "find the object" switch):
    # then faint change inside it is enough to go by
    dict(id='S-arm-thin-line-found', photo='astronaut.png', scale=2, smooth=5, levels=['mild'], found=True,
         objects=[(('ellipse', 180, 360, 45, 150, 30), dict(lift=10, shade=0.02, contour=0.35, width=1))],
         arrows=[(180, 360)], protect=[FACE_A]),
    dict(id='S-arm-large-found', photo='astronaut.png', scale=2, smooth=5, levels=['strong'], found=True,
         objects=[(('ellipse', 180, 360, 45, 150, 30), dict(lift=10, shade=0.05, contour=0.35, width=3))],
         arrows=[(180, 360)], protect=[FACE_A]),
    # An extent that takes in a face (the box of a hood includes the head):
    # the face is guarded and must stay
    dict(id='A-hood-ring-found', photo='astronaut.png', scale=2, found=True, guard=True,
         edits=[('recolor', ('ring', 225, 118, 98, 110, 60, 76))], arrows=[(225, 18)], protect=[('ellipse', 225, 124, 40, 52)]),
    # What the automatic part left behind, taken by the user's touch-ups
    dict(id='C-remove-spoon-touched', photo='coffee.png', scale=1.5, levels=['mild'],
         edits=[('fill', ('union', [('ellipse', 365, 288, 40, 44, 0), ('ellipse', 398, 170, 13, 100, -8)]))],
         arrows=[(365, 290)], protect=[('ellipse', 290, 150, 95, 55)],
         touches=[(394, 200, 30, True), (402, 140, 30, True), (408, 90, 30, True)]),
    # … and one that differs from it by its outline alone
    dict(id='S-arm-outline-only', photo='astronaut.png', scale=2, smooth=5, levels=['mild'],
         objects=[(('ellipse', 180, 360, 30, 95, 30), dict(lift=0, shade=0.02, contour=0.35, width=3))],
         arrows=[(180, 360)], protect=[FACE_A]),
]


def shape_mask(H, W, spec, s):
    kind = spec[0]
    if kind == 'ellipse':
        _, cx, cy, rx, ry, *rest = spec
        return ellipse(H, W, cx * s, cy * s, rx * s, ry * s, rest[0] if rest else 0)
    if kind == 'rect':
        _, x0, y0, x1, y1 = spec
        return rect(H, W, x0 * s, y0 * s, x1 * s, y1 * s)
    if kind == 'ring':
        _, cx, cy, ox, oy, ix, iy = spec
        return ellipse(H, W, cx * s, cy * s, ox * s, oy * s) & ~ellipse(H, W, cx * s, cy * s, ix * s, iy * s)
    if kind == 'union':
        m = np.zeros((H, W), bool)
        for sub in spec[1]:
            m |= shape_mask(H, W, sub, s)
        return m
    if kind == 'minus':
        return shape_mask(H, W, spec[1], s) & ~shape_mask(H, W, spec[2], s)
    if kind == 'and':
        return shape_mask(H, W, spec[1], s) & shape_mask(H, W, spec[2], s)
    raise ValueError(kind)


def build(sc, level, seed):
    rng = np.random.default_rng(seed)
    O = load(sc['photo'], sc['scale'])
    H, W, _ = O.shape
    s = sc['scale']
    if sc.get('smooth'):
        O = smooth_photo(O, sc['smooth'], seed)
    I = O.copy()
    gt = np.zeros((H, W), np.float32)
    for spec, look in sc.get('objects', []):
        O, where = add_limb(O, shape_mask(H, W, spec, s), look['lift'], look['shade'], look['contour'], look['width'])
        gt = np.maximum(gt, where)
    for kind, spec in sc.get('edits', []):
        m = shape_mask(H, W, spec, s)
        I, soft = apply_edit(I, m, kind, rng)
        gt = np.maximum(gt, soft)
    R = repaint(I, rng, level, sc.get('out_scale', 1.0))
    d = os.path.join(OUT, f"{sc['id']}__{level}")
    os.makedirs(d, exist_ok=True)
    Image.fromarray(np.clip(O, 0, 255).astype(np.uint8)).save(os.path.join(d, 'orig.png'))
    Image.fromarray(np.clip(I, 0, 255).astype(np.uint8)).save(os.path.join(d, 'ideal.png'))
    R.save(os.path.join(d, 'result.png'))
    Image.fromarray((gt * 255).astype(np.uint8)).save(os.path.join(d, 'gt.png'))
    protect = np.zeros((H, W), bool)
    for spec in sc.get('protect', []):
        protect |= shape_mask(H, W, spec, s)
    Image.fromarray((protect * 255).astype(np.uint8)).save(os.path.join(d, 'protect.png'))
    meta = dict(
        id=sc['id'], level=level,
        marks=[dict(x=x * s / W, y=y * s / H) for x, y in sc['arrows']],
        expect=sc.get('expect', 'ok'),
    )
    if 'left_max' in sc:
        meta['left_max'] = sc['left_max']
    # What the app may know beyond the two pictures
    options = {}
    if sc.get('found'):
        # the box a vision model would give for the thing each arrow points at
        ys, xs = np.nonzero(gt > 0.5)
        box = dict(x0=xs.min() / W, y0=ys.min() / H, x1=(xs.max() + 1) / W, y1=(ys.max() + 1) / H)
        options['extents'] = [box and dict(box=box) for _ in sc['arrows']]
    if sc.get('guard'):
        options['guarded'] = []
        for spec in sc.get('protect', []):
            ys, xs = np.nonzero(shape_mask(H, W, spec, s))
            options['guarded'].append(dict(x0=xs.min() / W, y0=ys.min() / H, x1=(xs.max() + 1) / W, y1=(ys.max() + 1) / H))
    if sc.get('touches'):
        options['touches'] = [dict(x=x * s / W, y=y * s / H, r=r * s / min(W, H), take=take) for x, y, r, take in sc['touches']]
    if options:
        meta['options'] = options
    json.dump(meta, open(os.path.join(d, 'meta.json'), 'w'))


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    only = sys.argv[1:] or None
    for i, sc in enumerate(SCENARIOS):
        if only and sc['id'] not in only:
            continue
        for j, level in enumerate(sc.get('levels', ['mild', 'strong'])):
            build(sc, level, 1000 + i * 10 + j)
            print('built', sc['id'], level)
    tmp = os.path.join(OUT, '_tmp.jpg')
    if os.path.exists(tmp):
        os.remove(tmp)
