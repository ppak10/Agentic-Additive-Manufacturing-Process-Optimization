"""Spool delivery: gzip round-trip, idempotency, un-imported skip."""

import gzip

import pytest

from agentic_sls.pipeline.deliver_spool import deliver_build, gz_ok


def make_spool_build(tmp_path, build_id=44):
    d = tmp_path / "spool" / str(build_id)
    d.mkdir(parents=True)
    (d / "telemetry.ndjson.imported").write_text(
        "\n".join('{"n":%d}' % i for i in range(500)) + "\n")
    (d / "position.ndjson.imported").write_text('{"p":1}\n')
    (d / "plotter.ndjson").write_text("")  # not imported → must be skipped
    return d


def make_dataset(tmp_path):
    ds = tmp_path / "dataset"
    (ds / ".git").mkdir(parents=True)
    return ds


def test_roundtrip_and_skip(tmp_path):
    d = make_spool_build(tmp_path)
    ds = make_dataset(tmp_path)
    streams = deliver_build(d, ds, force=False)
    assert sorted(streams) == ["position", "telemetry"]  # plotter skipped
    gz = ds / "source/spool/044/telemetry.ndjson.gz"
    with gzip.open(gz, "rt") as f:
        lines = f.readlines()
    assert len(lines) == 500 and lines[0] == '{"n":0}\n'


def test_idempotent(tmp_path):
    d = make_spool_build(tmp_path)
    ds = make_dataset(tmp_path)
    deliver_build(d, ds, force=False)
    gz = ds / "source/spool/044/telemetry.ndjson.gz"
    before = gz.stat().st_mtime_ns
    streams = deliver_build(d, ds, force=False)
    assert "telemetry (kept)" in streams
    assert gz.stat().st_mtime_ns == before


def test_corrupt_target_rewritten(tmp_path):
    d = make_spool_build(tmp_path)
    ds = make_dataset(tmp_path)
    deliver_build(d, ds, force=False)
    gz = ds / "source/spool/044/telemetry.ndjson.gz"
    gz.write_bytes(b"not gzip at all")
    assert not gz_ok(gz)
    streams = deliver_build(d, ds, force=False)
    assert "telemetry" in streams  # rewritten, not kept
    assert gz_ok(gz)
