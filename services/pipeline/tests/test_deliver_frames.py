"""Frames delivery: chunking, zip integrity, index, idempotency — all
against a tmp fake buffer + fake dataset checkout, no real data."""

import zipfile

import pyarrow.parquet as pq
import pytest

from agentic_sls.pipeline.deliver_frames import (
    deliver_build,
    scan_frames,
)


def make_buffer(tmp_path, build_id=7, chamber=25, thermal=4, bedmatrix=3):
    d = tmp_path / "frames" / str(build_id)
    d.mkdir(parents=True)
    ts = 1780000000000
    for i in range(chamber):
        (d / f"{ts + i * 200}_chamber.jpg").write_bytes(b"JPG" + bytes([i]) * 40)
    for i in range(thermal):
        (d / f"{ts + i * 500}_thermal.gif").write_bytes(b"GIF" + bytes([i]) * 30)
    for i in range(bedmatrix):
        (d / f"{ts + i * 1000}_bedmatrix.json").write_bytes(b'{"m":[%d]}' % i)
    (d / "not-a-frame.txt").write_text("ignored")
    return tmp_path / "frames"


def make_dataset(tmp_path):
    ds = tmp_path / "dataset"
    (ds / ".git").mkdir(parents=True)  # deliver_build checks for a checkout
    return ds


def test_scan_groups_and_sorts(tmp_path):
    frames_dir = make_buffer(tmp_path)
    by_kind = scan_frames(frames_dir / "7")
    assert set(by_kind) == {"chamber", "thermal", "bedmatrix"}
    ts = [f.ts_ms for f in by_kind["chamber"]]
    assert ts == sorted(ts)


def test_deliver_chunks_and_index(tmp_path):
    frames_dir = make_buffer(tmp_path)
    ds = make_dataset(tmp_path)
    rc = deliver_build(7, frames_dir, ds, chunk_size=10, force=False)
    assert rc == 0

    # chamber: 25 frames / chunk 10 → 3 zips, store-mode, correct members
    zips = sorted((ds / "source/frames/007/chamber").glob("*.zip"))
    assert [z.name for z in zips] == ["chunk-0001.zip", "chunk-0002.zip", "chunk-0003.zip"]
    counts = []
    for z in zips:
        with zipfile.ZipFile(z) as zf:
            infos = zf.infolist()
            counts.append(len(infos))
            assert all(i.compress_type == zipfile.ZIP_STORED for i in infos)
    assert counts == [10, 10, 5]

    # index covers every frame incl. non-image kinds; no other data outputs
    idx = pq.read_table(ds / "data/frames_index/007.parquet")
    assert idx.num_rows == 25 + 4 + 3
    kinds = set(idx.column("kind").to_pylist())
    assert kinds == {"chamber", "thermal", "bedmatrix"}
    archives = set(idx.column("archive").to_pylist())
    assert "source/frames/007/chamber/chunk-0001.zip" in archives
    assert not (ds / "data/frames").exists()  # ticks config is the ML form

    # originals untouched
    assert len(list((frames_dir / "7").iterdir())) == 25 + 4 + 3 + 1


def test_idempotent_rerun_keeps_zips(tmp_path):
    frames_dir = make_buffer(tmp_path)
    ds = make_dataset(tmp_path)
    deliver_build(7, frames_dir, ds, chunk_size=10, force=False)
    z = ds / "source/frames/007/chamber/chunk-0001.zip"
    before = z.stat().st_mtime_ns
    deliver_build(7, frames_dir, ds, chunk_size=10, force=False)
    assert z.stat().st_mtime_ns == before  # not rewritten


def test_refuses_without_dataset_checkout(tmp_path):
    frames_dir = make_buffer(tmp_path)
    ds = tmp_path / "dataset"  # no .git
    ds.mkdir()
    assert deliver_build(7, frames_dir, ds, 10, False) == 1


def test_corrupt_zip_detected(tmp_path):
    frames_dir = make_buffer(tmp_path, chamber=5, thermal=0, bedmatrix=0)
    ds = make_dataset(tmp_path)
    deliver_build(7, frames_dir, ds, chunk_size=10, force=False)
    # tamper with the archive → rerun (which keeps count-matching zips)
    # must fail the byte-identity spot check against the originals
    victim = next((frames_dir / "7").glob("*_chamber.jpg"))
    z = ds / "source/frames/007/chamber/chunk-0001.zip"
    with zipfile.ZipFile(z, "w", compression=zipfile.ZIP_STORED) as zf:
        for p in sorted((frames_dir / "7").glob("*_chamber.jpg")):
            zf.writestr(p.name, b"tampered" if p == victim else p.read_bytes())
    with pytest.raises(RuntimeError, match="bytes differ|members"):
        deliver_build(7, frames_dir, ds, chunk_size=10, force=False)
