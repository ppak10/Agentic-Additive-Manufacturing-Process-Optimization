"""Regression guard: every module's repo-root resolution must land on the
actual repo root (the folder move to services/pipeline broke all of them
silently once — tests inject tmp paths, so only this test notices)."""

from agentic_sls.pipeline import (
    backfill_frames,
    deliver_frames,
    deliver_spool,
    export,
    summarize_builds,
)


def test_repo_roots_agree_and_are_real():
    roots = {
        "export": export.REPO,
        "deliver_frames": deliver_frames.REPO,
        "backfill_frames": backfill_frames.REPO,
        "deliver_spool": deliver_spool.REPO,
    }
    for name, root in roots.items():
        assert (root / "docker-compose.yml").exists(), f"{name}: {root} is not the repo root"
    assert len({str(r) for r in roots.values()}) == 1

    assert (summarize_builds.PARQUET_DIR.parents[3] / "docker-compose.yml").exists()
