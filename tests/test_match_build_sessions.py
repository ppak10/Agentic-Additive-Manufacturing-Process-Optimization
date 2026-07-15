"""Session-matching logic: interval scoring, ambiguity flags, CSV merge."""

import csv
import json
from datetime import datetime, timedelta, timezone

import pytest

from agentic_sls.pipeline.match_build_sessions import (
    Session,
    apply,
    load_builds_jsonl,
    match,
    propose,
    read_csv_rows,
    score,
    write_csv_rows,
)


UTC = timezone.utc


def dt(h: int, m: int = 0) -> datetime:
    return datetime(2026, 7, 1, h, m, tzinfo=UTC)


def build(bid: int, start: datetime, end: datetime | None) -> dict:
    return {"id": bid, "job_name": f"job {bid}", "started_at": start,
            "ended_at": end}


def session(sid: str, start: datetime, end: datetime | None,
            result: int = 1) -> Session:
    return Session(id=sid, start=start, end=end, job_name="J", job_id="j-1",
                   profile_name="P", result=result)


class TestScore:
    def test_overlapping_intervals_score(self):
        b = build(1, dt(10), dt(14))
        s = session("a" * 8, dt(10), dt(14))
        ov, ndstart = score(b, s)
        assert ov == pytest.approx(4 * 3600, abs=1)
        assert ndstart == 0

    def test_disjoint_returns_none(self):
        b = build(1, dt(10), dt(11))
        # SLACK pads 15 min on each side; 2h away stays disjoint.
        assert score(b, session("s", dt(13), dt(14))) is None

    def test_recorder_lag_within_slack_matches(self):
        # Recorder joined 10 min after the firmware session started.
        b = build(1, dt(10, 10), dt(14))
        assert score(b, session("s", dt(10), dt(10, 5))) is not None

    def test_null_complete_time_still_matches_near_start(self):
        b = build(1, dt(10), dt(12))
        assert score(b, session("s", dt(10, 2), None)) is not None


class TestMatch:
    def test_picks_larger_overlap(self):
        b = build(1, dt(10), dt(20))
        early = session("e" * 8, dt(9), dt(10, 30))
        full = session("f" * 8, dt(10), dt(20))
        out = match([b], [early, full])
        assert out[1]["session"].id == "f" * 8

    def test_flags_ambiguity_with_runner_up(self):
        b = build(1, dt(10), dt(12))
        s1 = session("1" * 8, dt(10), dt(11))
        s2 = session("2" * 8, dt(10, 30), dt(12))
        note = match([b], [s1, s2])[1]["note"]
        assert "AMBIGUOUS" in note

    def test_unmatched_build_absent(self):
        b = build(1, dt(10), dt(11))
        assert match([b], [session("s", dt(20), dt(21))]) == {}

    def test_note_carries_result_label(self):
        b = build(1, dt(10), dt(12))
        note = match([b], [session("s" * 8, dt(10), dt(12), result=2)])[1]["note"]
        assert "cancelled" in note


class TestProposeCsvMerge:
    def _sessions_dir(self, tmp_path, sessions):
        d = tmp_path / "sessions"
        d.mkdir()
        for s in sessions:
            (d / f"{s['Id']}.json").write_text(json.dumps(s))
        return d

    def test_hand_filled_rows_survive_reproposal(self, tmp_path):
        csv_path = tmp_path / "map.csv"
        write_csv_rows(
            [{"build_id": "1", "inova_session_id": "manual-uuid",
              "notes": "verified by hand"}],
            csv_path,
        )
        sessions_dir = self._sessions_dir(tmp_path, [{
            "Id": "auto-uuid", "StartTime": dt(10).isoformat(),
            "CompleteTime": dt(12).isoformat(), "JobName": "J",
            "JobId": "j", "ProfileName": "P", "Result": 1,
        }])
        propose([build(1, dt(10), dt(12))], csv_path, sessions_dir)
        rows = read_csv_rows(csv_path)
        assert rows[0]["inova_session_id"] == "manual-uuid"
        assert rows[0]["notes"] == "verified by hand"

    def test_auto_rows_are_refreshed(self, tmp_path):
        csv_path = tmp_path / "map.csv"
        write_csv_rows(
            [{"build_id": "1", "inova_session_id": "stale-uuid",
              "notes": "auto: old evidence"}],
            csv_path,
        )
        sessions_dir = self._sessions_dir(tmp_path, [{
            "Id": "fresh-uuid", "StartTime": dt(10).isoformat(),
            "CompleteTime": dt(12).isoformat(), "JobName": "J",
            "JobId": "j", "ProfileName": "P", "Result": 1,
        }])
        propose([build(1, dt(10), dt(12))], csv_path, sessions_dir)
        assert read_csv_rows(csv_path)[0]["inova_session_id"] == "fresh-uuid"

    def test_unmatched_build_gets_no_overlap_note(self, tmp_path):
        csv_path = tmp_path / "map.csv"
        sessions_dir = self._sessions_dir(tmp_path, [])
        propose([build(7, dt(10), dt(11))], csv_path, sessions_dir)
        row = read_csv_rows(csv_path)[0]
        assert row["build_id"] == "7"
        assert row["inova_session_id"] == ""
        assert "no overlapping session" in row["notes"]


class FakeCursor:
    def __init__(self):
        self.executed = []

    def execute(self, sql, params=None):
        self.executed.append((sql, params))

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakeConn:
    def __init__(self):
        self.cur = FakeCursor()
        self.committed = False

    def cursor(self):
        return self.cur

    def commit(self):
        self.committed = True


class TestApply:
    def test_rejects_malformed_uuid_before_writing(self, tmp_path):
        csv_path = tmp_path / "map.csv"
        write_csv_rows(
            [{"build_id": "1", "inova_session_id": "not-a-uuid", "notes": ""}],
            csv_path,
        )
        with pytest.raises(ValueError):
            apply(FakeConn(), csv_path)

    def test_writes_only_filled_rows(self, tmp_path):
        csv_path = tmp_path / "map.csv"
        uuid = "79cf0fe8-937e-4fb0-8d99-424ec337dbc5"
        write_csv_rows(
            [{"build_id": "1", "inova_session_id": uuid, "notes": "auto: x"},
             {"build_id": "2", "inova_session_id": "", "notes": ""}],
            csv_path,
        )
        conn = FakeConn()
        assert apply(conn, csv_path) == 0
        assert len(conn.cur.executed) == 1
        assert conn.cur.executed[0][1] == [uuid, 1]
        assert conn.committed


def test_load_builds_jsonl_parses_timestamps(tmp_path):
    p = tmp_path / "builds.jsonl"
    p.write_text(json.dumps({
        "id": 3, "job_name": None,
        "started_at": "2026-07-01T10:00:00+00:00", "ended_at": None,
    }) + "\n")
    builds = load_builds_jsonl(p)
    assert builds[0]["id"] == 3
    assert builds[0]["started_at"] == dt(10)
    assert builds[0]["ended_at"] is None
