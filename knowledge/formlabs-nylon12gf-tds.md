---
title: Formlabs Nylon 12 GF — TDS values and our measured baselines
summary: Published Fuse 1 TDS mechanical properties for Nylon 12 GF, next to what we measured on Fuse-printed control specimens and our best Inova batches. These are the optimization targets.
---

# Formlabs Nylon 12 GF — TDS values and measured baselines

## Published TDS (Fuse 1, Formlabs datasheet 2201635)

| Property | Method | Value |
|---|---|---|
| Ultimate tensile strength | ASTM D638-14 Type I | 38 MPa |
| Tensile modulus | ASTM D638-14 Type I | 2800 MPa |
| Elongation at break | ASTM D638-14 Type I | 4% (X/Y), 3% (Z) |
| Flexural modulus | ASTM D790-15 | 2400 MPa |

Source: formlabs-media.formlabs.com/datasheets/2201635-TDS-ENUS-0.pdf

## Our measured baselines (see `astm_query` for live numbers)

- **Fuse-printed control specimens** (material_class `PA12GF_FL`, printed
  vertically, D638, n=5): tensile modulus **2599 ± 98 MPa**. Below TDS —
  consistent with the TDS quoting X/Y orientation while our controls were
  printed vertically (Z), the weak orientation in SLS.
- **Best Inova batch to date** (batch H, D638, n=3): tensile modulus
  **2815 MPa** — at TDS level. Batches I/J/J_MB (later profiles) sit at
  2245–2328 MPa.
- Full progression A→H spans 365 → 2815 MPa as energy density and thermal
  settings improved; query `astm_query {group_by: "profile"}` for the
  profile-by-profile picture.

## How to use these numbers

Treat TDS values as the **target envelope** when optimizing Inova profiles
for PA12 GF (and as the pattern for any new powder: pull its TDS, put it in
this corpus, tune toward it). Compare like-for-like: orientation matters
(X/Y vs Z), and our specimens' print orientation is recorded per batch in
the ASTM repo.
