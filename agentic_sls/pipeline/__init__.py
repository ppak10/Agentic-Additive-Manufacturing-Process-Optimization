"""Data pipeline between the recorder's Postgres, the dataset repos, and
data/exports/ — the scripts behind the post-print refresh sequence.

Each module is exposed as a console script (pyproject [project.scripts]):
sls-export, sls-export-conversations, sls-sync-reference,
sls-summarize-builds, sls-match-build-sessions, sls-restore-builds.
"""
