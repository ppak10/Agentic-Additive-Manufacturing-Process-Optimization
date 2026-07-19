"""Async task runner for the pipeline jobs.

A thin FastAPI service + single sequential worker that runs the `sls-*`
pipeline commands (and, later, the dataset build scripts) as background jobs,
tracking their lifecycle in the Postgres `tasks` table and emitting a
`task_complete` event for the GUI attention bar. See services/tasks design
notes in the repo. Runs as the `agentic-sls-tasks` docker service.
"""
