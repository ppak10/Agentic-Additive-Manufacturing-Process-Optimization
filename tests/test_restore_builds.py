"""Era file-split logic for the restore: only new-era files (by epoch-ms
filename prefix) move out of shared dirs, and the move is idempotent."""

import json

from restore_builds import ERA_CUTOFF_MS, RENUMBER, move_frame_files, read_jsonl


OLD = "1780255220379_galvo.png"   # 2026-05-31, old era
NEW = "1783665723561_chamber.jpg"  # 2026-07-10, new era


def make_dirs(tmp_path):
    d1 = tmp_path / "1"
    d1.mkdir()
    (d1 / OLD).touch()
    (d1 / NEW).touch()
    return tmp_path


def test_cutoff_separates_eras():
    assert int(OLD.split("_")[0]) < ERA_CUTOFF_MS < int(NEW.split("_")[0])


def test_dry_run_moves_nothing(tmp_path):
    frames = make_dirs(tmp_path)
    move_frame_files(execute=False, frames_dir=frames)
    assert sorted(p.name for p in (frames / "1").iterdir()) == sorted([OLD, NEW])
    assert not (frames / "42").exists()


def test_execute_moves_only_new_era(tmp_path):
    frames = make_dirs(tmp_path)
    move_frame_files(execute=True, frames_dir=frames)
    assert [p.name for p in (frames / "1").iterdir()] == [OLD]
    assert [p.name for p in (frames / "42").iterdir()] == [NEW]


def test_rerun_is_idempotent(tmp_path):
    frames = make_dirs(tmp_path)
    move_frame_files(execute=True, frames_dir=frames)
    move_frame_files(execute=True, frames_dir=frames)  # no error, no change
    assert [p.name for p in (frames / "42").iterdir()] == [NEW]


def test_renumber_pairs_are_descending():
    # Descending order is what prevents id collisions mid-renumber
    # (5→46 before 4→45 …); guard against reordering.
    olds = [old for old, _ in RENUMBER]
    assert olds == sorted(olds, reverse=True)
    assert all(new == old + 41 for old, new in RENUMBER)


def test_read_jsonl_skips_blank_lines(tmp_path):
    p = tmp_path / "x.jsonl"
    p.write_text('{"a": 1}\n\n{"a": 2}\n')
    assert [r["a"] for r in read_jsonl(p)] == [1, 2]
