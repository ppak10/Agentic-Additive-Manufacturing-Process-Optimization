# knowledge/ — curated reference corpus

Markdown documents served to agents by the plugin's `reference_list` /
`reference_get` MCP tools. Each file needs a frontmatter block:

```markdown
---
title: Short title shown in the index
summary: One or two lines — agents decide from this whether to fetch the doc.
---
```

The file name (without `.md`) is the document id. `README.md` is excluded
from the index.

House rules:
- State provenance: cite datasheet/spec URLs; mark unverified values as
  "(fill in)" rather than guessing.
- Prefer normalized quantities (energy density, temps relative to melt)
  over machine-absolute settings.
- When a document quotes measured numbers, point at the live query
  (`astm_query`, `build_get`) so agents can refresh them — snapshots drift.
