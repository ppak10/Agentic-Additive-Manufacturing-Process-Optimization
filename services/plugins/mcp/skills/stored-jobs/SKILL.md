---
name: stored-jobs
description: >
  Work with the print jobs stored on the SLS4All Inova: browse layouts,
  prepare a build from an operator-blessed [TEMPLATE] job, rename or repoint
  a job at a different print profile. Use when the user wants to set up a
  build/experiment, asks what jobs are on the printer, or wants a test
  layout printed with new parameters.
---

# Stored jobs

Stored jobs are the printer's queued layouts (`.s4a` files) — NOT print
history. They work while the printer is idle. Creating or editing a job
never starts a print; the operator reviews and starts it from the printer
UI or the GUI Jobs page.

## Tools

- `job_list` — id, name, type, `is_template` for every stored job.
- `job_get` — one job: metadata, print profile id, object files (parts),
  nesting instance count.
- `job_set` — rename / change print profile. Metadata-only. Refuses
  `[TEMPLATE]` jobs and refuses adding the marker to any name.
- `job_create_from_template` — clone a `[TEMPLATE]` job with a different
  print profile. THE way to prepare a profile experiment.

## Template rules (hard)

- A job whose name contains `[TEMPLATE]` is an operator-blessed test layout:
  read-only to you. Never rename a job to add or remove the marker.
- Only templates can be cloned. If the layout you need isn't blessed, ask
  the operator to bless it — don't work around the guard.
- Default clone name is `<template> - <profile> (<date>)`; "/" is sanitized
  to "-" so the stored filename matches what you asked for.

## Naming & debug conversations

- In a debug-flagged conversation, every job you create is automatically
  prefixed `[DEBUG]` (server-enforced) so the operator can find and delete
  test content later. Don't fight the prefix; mention it when reporting the
  created name.
- Give clones names that encode the experiment (profile, date, intent) —
  the Jobs page is the operator's browsing surface.

## Artifact panel

- A job you create is auto-pinned to the conversation's artifact panel
  (provenance `created`) — the operator immediately sees its 3D build
  preview and parts list. No extra call needed.
- When DISCUSSING an existing job (comparing layouts, reviewing a
  candidate), pin it deliberately with `artifact_add type=job` so the
  operator sees what you see. Merely browsing via `job_list`/`job_get`
  does not put anything on the panel — that is intentional.
- `artifact_list` shows what's pinned and which tab the operator is looking
  at right now (`focused`); `artifact_remove` unpins stale tabs as the
  conversation moves on.

## Workflow: prepare a profile experiment

1. `profile_list` / `profile_get merged=true` — pick or create the profile
   (see the print-profiles skill; profile names lie, read fields).
2. `job_list` — find the blessed `[TEMPLATE]` layout for the experiment
   (e.g. ASTM specimen layouts).
3. `job_create_from_template {template_job_id, print_profile_id}`.
4. Report the created job's name and id, note it is NOT started, and leave
   starting it to the operator.
