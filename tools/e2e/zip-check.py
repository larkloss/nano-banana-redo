"""Checks zip archives against what was put into them (see zip-check.cjs).

    python zip-check.py <archive.zip> <expected.json> [<archive.zip> <expected.json> ...]

expected.json: [{"name": ..., "sha256": ..., "size": ...}, ...] in archive order.
Reads the archive with Python's zipfile: its own integrity test has to pass,
and every entry has to be there, in order, stored uncompressed, with exactly
the expected bytes. Exits with status 1 otherwise.
"""
import datetime
import hashlib
import json
import sys
import zipfile

bad = 0


def check(name, ok, detail=''):
    global bad
    print(('PASS ' if ok else 'FAIL ') + name + (' — ' + detail if detail else ''))
    if not ok:
        bad += 1


for archive, expected in zip(sys.argv[1::2], sys.argv[2::2]):
    with open(expected, encoding='utf-8') as f:
        want = json.load(f)
    print(archive)
    with zipfile.ZipFile(archive) as z:
        broken = z.testzip()
        check('zipfile.testzip() finds every CRC and header right', broken is None, str(broken or ''))
        infos = z.infolist()
        check('the entries, in order', [i.filename for i in infos] == [w['name'] for w in want],
              f'{len(infos)} entries')
        now = datetime.datetime.now()
        for info, w in zip(infos, want):
            data = z.read(info)
            ok = (hashlib.sha256(data).hexdigest() == w['sha256'] and len(data) == w['size']
                  and info.file_size == w['size'] and info.compress_size == w['size'])
            check(f'{info.filename}: the bytes put in ({len(data)})', ok)
            stored = info.compress_type == zipfile.ZIP_STORED
            # names that are not plain ASCII have to be marked as UTF-8
            marked = info.filename.isascii() or bool(info.flag_bits & 0x800)
            age = abs((now - datetime.datetime(*info.date_time)).total_seconds())
            check(f'{info.filename}: stored, name encoding, time', stored and marked and age < 86400,
                  f'method {info.compress_type}, flags {info.flag_bits:#x}, {info.date_time}')

sys.exit(1 if bad else 0)
