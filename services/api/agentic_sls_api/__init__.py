"""Lightweight GUI API service (FastAPI) — Postgres reads + Inova proxy.

Bootstrapped 2026-07-19 to peel the GUI's stateless read/proxy routes off the
recorder (which stays occupied with recording builds and the live-print
hardware/software procedures). See CLAUDE.md "Services" and the recorder's
api/routes.ts for the route inventory being migrated here in phases.
"""
