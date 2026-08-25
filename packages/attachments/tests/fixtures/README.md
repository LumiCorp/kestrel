# Attachment extraction fixtures

These fixtures contain synthetic Kestrel sentinels or upstream public test
documents. They must not contain customer data.

- `incident-playbook.pdf`, `executive-brief.docx`, `quarterly-metrics.xlsx`,
  and `roadmap-deck.pptx` are the synthetic Knowledge fixtures used by the web
  test corpus.
- `issue3521.pdf` is Mozilla PDF.js test fixture `test/pdfs/issue3521.pdf` from
  <https://github.com/mozilla/pdf.js>. It exercises the predefined
  `GBKp-EUC-H` CMap and is covered by the repository's Apache-2.0 license. Its
  SHA-256 is
  `5ab6217d6634589fb9a2c4c8780c6aed02b498bb0a60ad9419f9e13a2e1bfe2d`.
- `password-123456.pdf` is the public password-protected example published by
  the Apache-2.0-licensed `pdf-parse` project at
  <https://mehmet-kozan.github.io/pdf-parse/pdf/password-123456.pdf>. Its
  SHA-256 is
  `82f46c4b61386ff2448efce8495c2b3110d86b9478282bde5f24b434cb0722b2`.
