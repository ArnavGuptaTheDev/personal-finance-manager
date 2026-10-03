# Statement fixtures

Synthetic statements modelled on each supported layout. Every name, number and amount is
invented; real statements, even anonymised, never enter this repo (they stay in the
git-ignored `samples/` folder).

- `<name>.json` describes the file: the format to parse it with, and its rows (sheets) or lines (CSV).
  `{ "date": "2026-04-05" }` cells become real Excel date cells.
- `<name>.expected.json` is the exact parser output. Fixtures with a balance column must
  have zero running-balance mismatches unless `"expectMismatches": true` is set.

Adding a bank: add its entry to `src/client/parsers/formats.ts` and one fixture here.
