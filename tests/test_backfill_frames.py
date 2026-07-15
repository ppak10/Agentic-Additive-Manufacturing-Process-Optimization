"""Backfill runner: discovery, skip-delivered, limit, per-build commits —
against tmp buffers and a real (tiny) git repo as the fake dataset."""

import subprocess

from agentic_sls.pipeline import backfill_frames
from agentic_sls.pipeline.backfill_frames import (
    buffered_builds,
    is_delivered,
    main,
)


def make_buffer(tmp_path, build_id, n=5):
    d = tmp_path / "frames" / str(build_id)
    d.mkdir(parents=True)
    ts = 1780000000000
    for i in range(n):
        (d / f"{ts + i}_chamber.jpg").write_bytes(b"J" * 10)
    return d


def make_dataset_repo(tmp_path):
    ds = tmp_path / "dataset"
    ds.mkdir()
    subprocess.run(["git", "-C", str(ds), "init", "-q"], check=True)
    subprocess.run(["git", "-C", str(ds), "config", "user.email", "t@t"], check=True)
    subprocess.run(["git", "-C", str(ds), "config", "user.name", "t"], check=True)
    (ds / ".keep").write_text("")
    subprocess.run(["git", "-C", str(ds), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(ds), "commit", "-qm", "init"], check=True)
    return ds


def run_main(argv, monkeypatch):
    monkeypatch.setattr("sys.argv", ["sls-backfill-frames", *argv])
    return main()


def test_discovery_sorted_and_skips_empty(tmp_path):
    make_buffer(tmp_path, 3)
    make_buffer(tmp_path, 1)
    (tmp_path / "frames" / "9").mkdir()  # empty dir → not a candidate
    assert buffered_builds(tmp_path / "frames") == [1, 3]


def test_batch_delivers_commits_and_respects_limit(tmp_path, monkeypatch):
    for b in (1, 2, 3):
        make_buffer(tmp_path, b)
    ds = make_dataset_repo(tmp_path)
    rc = run_main(["--limit", "2", "--frames-dir", str(tmp_path / "frames"),
                   "--dataset", str(ds)], monkeypatch)
    assert rc == 0
    assert is_delivered(ds, 1) and is_delivered(ds, 2)
    assert not is_delivered(ds, 3)
    log = subprocess.run(["git", "-C", str(ds), "log", "--oneline"],
                         capture_output=True, text=True, check=True).stdout
    assert "Add build 001" in log and "Add build 002" in log
    # second run picks up where the first stopped
    rc = run_main(["--limit", "5", "--frames-dir", str(tmp_path / "frames"),
                   "--dataset", str(ds)], monkeypatch)
    assert rc == 0
    assert is_delivered(ds, 3)


def test_no_commit_leaves_tree_dirty(tmp_path, monkeypatch):
    make_buffer(tmp_path, 4)
    ds = make_dataset_repo(tmp_path)
    rc = run_main(["--limit", "1", "--no-commit",
                   "--frames-dir", str(tmp_path / "frames"),
                   "--dataset", str(ds)], monkeypatch)
    assert rc == 0
    assert is_delivered(ds, 4)
    status = subprocess.run(["git", "-C", str(ds), "status", "--porcelain"],
                            capture_output=True, text=True, check=True).stdout
    assert status.strip()  # delivered files uncommitted
