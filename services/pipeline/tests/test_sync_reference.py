"""Row shaping for the reference sync: fed via fake repos + a capturing
connection, no Postgres needed."""

import json

from agentic_sls.pipeline.sync_reference import norm_date, sync_jobs, sync_specimens


class FakeConn:
    def __init__(self):
        self.executed = []

    def execute(self, sql, params=None):
        self.executed.append((sql, params))


def make_database_repo(tmp_path, rows):
    (tmp_path / "data").mkdir(parents=True, exist_ok=True)
    (tmp_path / "data" / "jobs.jsonl").write_text(
        "\n".join(json.dumps(r) for r in rows) + "\n"
    )
    return tmp_path


def job_row(source_file, job_id, print_date="2026_06_13"):
    return {
        "source_file": source_file,
        "print_date": print_date,
        "job_name": "J",
        "print_profile_id": "p-1",
        "objects": [],
        "metadata": {"AutomaticJob": {"Id": job_id}},
    }


def test_norm_date_handles_underscores_and_none():
    assert norm_date("2026_06_13") == "2026-06-13"
    assert norm_date("2026-06-13") == "2026-06-13"
    assert norm_date(None) is None


def test_sync_jobs_allows_reprinted_job_uuid(tmp_path):
    # Same firmware job archived twice (printed on two dates) — both rows
    # must load; the PK is source_file, not job_id.
    repo = make_database_repo(tmp_path, [
        job_row("a.s4a", "888c99c1", "2026_06_13"),
        job_row("b.s4a", "888c99c1", "2026_06_24"),
    ])
    conn = FakeConn()
    assert sync_jobs(conn, repo) == 2
    keys = [(p[0], p[1]) for _, p in conn.executed]
    assert keys == [("a.s4a", "888c99c1"), ("b.s4a", "888c99c1")]


def test_sync_jobs_extracts_job_uuid_from_metadata(tmp_path):
    repo = make_database_repo(tmp_path, [job_row("a.s4a", "the-uuid")])
    conn = FakeConn()
    sync_jobs(conn, repo)
    _, params = conn.executed[0]
    assert params[1] == "the-uuid"
    assert params[3] == "2026-06-13"  # print_date normalized


def make_astm_repo(tmp_path, specs):
    for name, row in specs:
        p = tmp_path / "data" / "D638" / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(row) + "\n")
    return tmp_path


def specimen(sample_id=None, modulus=1.0e9):
    return {
        "sample_id": sample_id,
        "batch_label": "A" if sample_id else None,
        "material_class": "SLS" if sample_id else "PLA",
        "test_date": "2026_05_26",
        "astm": {"standard": "D638", "type": "Type I", "year": "2022"},
        "geometry": {"width_mm": 12.9},
        "metrics": {"modulus_pa": modulus, "peak_load_n": None},
        "job_id": None,
        "print_profile_snapshot": None,
        "source_paths": {"xlsx": "x.xlsx"},
    }


def test_specimen_metrics_flattened_in_order(tmp_path):
    repo = make_astm_repo(tmp_path, [("A1.jsonl", specimen("A1", 2.5e9))])
    conn = FakeConn()
    assert sync_specimens(conn, repo) == 1
    _, params = conn.executed[0]
    assert params[0] == "D638"
    assert params[1] == "A1"
    assert 2.5e9 in params  # modulus landed as a scalar column


def test_control_specimen_falls_back_to_file_stem(tmp_path):
    repo = make_astm_repo(tmp_path, [("PLA_TSR6.jsonl", specimen(None))])
    conn = FakeConn()
    sync_specimens(conn, repo)
    _, params = conn.executed[0]
    assert params[1] == "PLA_TSR6"
