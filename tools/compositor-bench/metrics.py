"""Scores a run (out/<tag>) against the ground truth and renders seam crops.

  python metrics.py <tag> [--no-render]

Exits with status 1 if any case fails.

Per case (ok results):
  kept     - share of the intended edit that made it into the composite
             (1 - error vs ideal / error of doing nothing), inside the edit
  extra    - area taken from the model beyond the edit (+ a small margin),
             as % of the picture: everything there drifted for no reason
  left     - share of the edit's clearly different pixels that the composite
             left exactly as the original (% — the part of the edit not taken)
  protect  - share of protected pixels (faces, other eye...) that are
             bit-identical to the original (must be 100%)
  seam     - mean colour error vs ideal on the seam band (±3px around the
             boundary of what was replaced); 'seamGrad' the same for
             gradients (visible edges/steps)
  outside  - share of pixels outside the replaced area identical to original
"""
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

B = os.path.dirname(os.path.abspath(__file__))
LEFT_MAX = 15  # % of the edit that may be left behind


def arr(path, mode='RGB'):
    return np.asarray(Image.open(path).convert(mode)).astype(np.float32)


def score(tag, cid, render=True):
    cd = os.path.join(B, 'cases', cid)
    od = os.path.join(B, 'out', tag, cid)
    meta = json.load(open(os.path.join(cd, 'meta.json')))
    out = json.load(open(os.path.join(od, 'out.json')))
    row = dict(id=cid, expect=meta['expect'], kind=out['kind'], ms=round(out.get('ms', 0)))
    if out['kind'] != 'ok':
        row['pass'] = meta['expect'] in ('reject', 'any')
        return row
    O = arr(os.path.join(cd, 'orig.png'))
    I = arr(os.path.join(cd, 'ideal.png'))
    C = arr(os.path.join(od, 'composite.png'))
    gt = arr(os.path.join(cd, 'gt.png'), 'L') / 255
    protect = arr(os.path.join(cd, 'protect.png'), 'L') > 127
    H, W, _ = O.shape
    short = min(H, W)

    replaced = np.any(C != O, -1)
    # Protected areas are judged away from the edit itself (an edit right
    # next to a face may legitimately blend a few of its edge pixels)
    strict = protect & ~ndimage.binary_dilation(gt > 0.02, iterations=max(2, int(0.014 * short)))
    protect &= ~ndimage.binary_dilation(gt > 0.02, iterations=max(2, int(0.05 * short)))
    core = ndimage.binary_erosion(gt > 0.9, iterations=2)
    err_c = np.abs(C - I).mean(-1)
    err_o = np.abs(O - I).mean(-1)
    if core.sum() > 0:
        row['kept'] = round(float(1 - err_c[core].mean() / max(err_o[core].mean(), 1e-6)), 3)
        row['coreErr'] = round(float(err_c[core].mean()), 1)
        # best achievable: the model's own answer (aligned by the pipeline)
        # inside the edit, i.e. where the composite takes the answer fully
        full = np.all(C != O, -1) & core
        row['ownErr'] = round(float(err_c[full].mean()), 1) if full.sum() > 50 else None
    real = (gt > 0.5) & (np.abs(O - I).max(-1) > 12)
    if real.sum() > 0:
        row['left'] = round(float((real & ~replaced).sum() / real.sum() * 100), 1)
    margin = ndimage.binary_dilation(gt > 0.02, iterations=max(2, int(0.05 * short)))
    row['extra%'] = round(float((replaced & ~margin).sum() / (H * W) * 100), 2)
    row['taken%'] = round(float(replaced.sum() / (H * W) * 100), 2)
    row['protect'] = round(float(np.mean(np.all(C[protect] == O[protect], -1))) * 100, 2) if protect.any() else None
    # strict: everything protected except the blend width next to the edit
    row['strict'] = round(float(np.mean(np.all(C[strict] == O[strict], -1))) * 100, 2) if strict.any() else None

    edge = replaced ^ ndimage.binary_erosion(replaced)
    band = ndimage.binary_dilation(edge, iterations=3)
    # judge the seam only where the ideal itself is unchanged (a real seam,
    # not the edit's own outline)
    band &= gt < 0.02
    if band.sum() > 0:
        row['seam'] = round(float(err_c[band].mean()), 2)
        gx = lambda a: np.diff(a.mean(-1), axis=1, prepend=0)
        gy = lambda a: np.diff(a.mean(-1), axis=0, prepend=0)
        g_err = np.abs(gx(C) - gx(I)) + np.abs(gy(C) - gy(I))
        row['seamGrad'] = round(float(g_err[band].mean()), 2)
        # reference: the same band in the raw model answer, aligned roughly
    row['pass'] = meta['expect'] in ('ok', 'any') and row['protect'] in (None, 100.0) and row.get('left', 0) <= meta.get('left_max', LEFT_MAX)
    row['limit'] = out['info']['reachedLimit']
    row['arrows'] = ''.join(str(int(a)) for a in out['info']['arrowsChanged'])

    if render:
        # crops around what was replaced: original | ideal | composite | 4x error
        ys, xs = np.nonzero(replaced | (gt > 0.02))
        pad = int(0.04 * short)
        y0, y1 = max(0, ys.min() - pad), min(H, ys.max() + pad)
        x0, x1 = max(0, xs.min() - pad), min(W, xs.max() + pad)
        R = arr(os.path.join(cd, 'result.png'))
        R = np.asarray(Image.fromarray(R.astype(np.uint8)).resize((W, H), Image.LANCZOS)).astype(np.float32)
        outline = C.copy()
        outline[edge] = [255, 0, 255]
        tiles = [O, I, C, outline, np.clip(np.abs(C - I) * 4, 0, 255)]
        crop = [t[y0:y1, x0:x1] for t in tiles]
        scale = min(1.0, 900 / max(1, (x1 - x0) * len(crop))) * 2
        ims = [Image.fromarray(t.astype(np.uint8)) for t in crop]
        tw = int((x1 - x0) * scale)
        th = int((y1 - y0) * scale)
        strip = Image.new('RGB', (tw * len(ims), th))
        for k, im in enumerate(ims):
            strip.paste(im.resize((tw, th), Image.NEAREST), (k * tw, 0))
        strip.save(os.path.join(od, 'crops.png'))
    return row


if __name__ == '__main__':
    tag = sys.argv[1]
    render = '--no-render' not in sys.argv
    ids = sorted(d for d in os.listdir(os.path.join(B, 'out', tag)) if os.path.isdir(os.path.join(B, 'out', tag, d)))
    rows = [score(tag, cid, render) for cid in ids]
    cols = ['id', 'kind', 'pass', 'arrows', 'kept', 'left', 'coreErr', 'ownErr', 'taken%', 'extra%', 'protect', 'strict', 'seam', 'seamGrad', 'limit', 'ms']
    print(' '.join(c.rjust(9) if c != 'id' else c.ljust(28) for c in cols))
    for r in rows:
        print(' '.join((str(r.get(c, '')) if r.get(c) is not None else '-').rjust(9) if c != 'id' else r['id'].ljust(28) for c in cols))
    ok = [r for r in rows if r['kind'] == 'ok' and 'seam' in r]
    if ok:
        print('mean seam', round(np.mean([r['seam'] for r in ok]), 2), 'mean seamGrad', round(np.mean([r['seamGrad'] for r in ok]), 2),
              'mean extra%', round(np.mean([r['extra%'] for r in ok]), 2), 'pass', sum(r['pass'] for r in rows), '/', len(rows))
    json.dump(rows, open(os.path.join(B, 'out', tag, 'scores.json'), 'w'))
    failed = [r['id'] for r in rows if not r['pass']]
    print('pass', len(rows) - len(failed), '/', len(rows), ('FAILED: ' + ' '.join(failed)) if failed else '')
    sys.exit(1 if failed else 0)
