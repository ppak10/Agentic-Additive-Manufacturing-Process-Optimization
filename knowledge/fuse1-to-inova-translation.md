---
title: Fuse 1 → Inova MK1 parameter translation
summary: How to use Formlabs Fuse 1 material settings as starting points on the SLS4All Inova MK1 — machine differences, what transfers (normalized quantities), what doesn't (absolute settings).
---

# Fuse 1 → Inova MK1 parameter translation

Formlabs publishes material settings and TDS values for the Fuse 1. We print
the same powders (e.g. Nylon 12 GF) on a SLS4All Inova MK1. **Absolute
machine settings do not transfer; normalized quantities do.**

## Machine comparison

| Property | Formlabs Fuse 1 | SLS4All Inova MK1 |
|---|---|---|
| Laser | 10 W ytterbium fiber | (fill in: see firmware config — not yet verified in this corpus) |
| Laser spot size (FWHM) | 200 µm | (fill in) |
| Layer thickness | 110 µm | 100 µm (all profiles to date) |
| Build volume | 165 × 165 × 300 mm | see firmware `PrintableWidth/Height/Depth` |
| Heating | quartz tube elements + PTC cartridges | halogen surface heating + zone heaters (powder/print chambers 1–4, beds) |

Sources: Formlabs Fuse 1 tech specs (formlabs.com/3d-printers/fuse-1/tech-specs).

## What transfers between machines

1. **Volumetric energy input, not laser power.** The Inova's profile knob is
   `LaserFillEnergyDensity` in **mJ/mm of scan path** (profiles are named by
   it: 14–40 mJ/mm tried so far, all at 100 µm layers). The Fuse 1's 10 W /
   200 µm spot delivers energy per scan length that cannot be copied
   directly — different wavelength, spot, and scan speed. Treat energy
   density as the search variable on the Inova, using our own batch outcomes
   (see `astm_query` grouped by profile) as the map, not Fuse 1 settings.
2. **Temperatures relative to material transitions.** PA12's melting point
   (~187 °C) and crystallization window are material properties. Our
   PA12 GF profiles hold the powder surface at 168–176 °C
   (`SurfaceTarget` 168, `HeatingTargetPrint` 172,
   `BeginLayerTemperatureTarget` 176) — a few degrees below melt, the
   standard SLS sintering window. A new material's bed/chamber targets
   should be set the same way: from its DSC data or published sintering
   window, offset the same margins below melt.
3. **Powder refresh ratio.** Material aging behavior transfers (it's powder
   chemistry, not machine). Formlabs specifies 30–50% refresh for their
   powders; our "100% Recycled" profile experiments track how the Inova
   tolerates deviation from that.
4. **TDS mechanical values as targets.** ASTM D638/D790 results are
   machine-independent measurements. The Fuse 1 TDS values (see
   `formlabs-nylon12gf-tds`) are the benchmark our Inova profiles are tuned
   toward; batch H (36 mJ/mm era) already reached TDS-level tensile modulus.

## What does NOT transfer

- Laser power/speed settings (different laser physics entirely).
- Layer thickness conventions (110 vs 100 µm — affects energy density per
  volume; when comparing mJ/mm figures across layer thicknesses, normalize
  to J/mm³: divide by hatch spacing × layer thickness).
- Chamber heating dynamics (heat-up rates, `HeatingMinimumTime`) — tune per
  machine.

## Practical recipe for a new powder on the Inova

1. Get the material's TDS + sintering window (melt point, recommended bed
   temp on any SLS machine — Fuse 1 settings are a fine source *for this*).
2. Set surface/bed targets the usual margin below melt (compare our PA12 GF
   profile: melt 187 °C → surface 168–176 °C, i.e. 11–19 °C below).
3. Start energy density conservatively (our PA12 GF experience: 14–20 mJ/mm
   sinters but underperforms; 28–36 mJ/mm is the strong region; 40 mJ/mm
   explores the upper bound). For goal "first print": low-middle of that
   range with a small test object.
4. Iterate using `astm_query` outcomes and `build_get` failure modes from
   prior builds as the evidence base.
