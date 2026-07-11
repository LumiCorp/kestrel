<!-- cli-prompt-smoke
{
  "assertions": [
    { "type": "file_exists", "path": "package.json" },
    { "type": "file_exists", "path": "index.html" },
    {
      "type": "any_file_exists",
      "paths": ["src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx"]
    },
    { "type": "file_contains", "path": "package.json", "text": "vite" },
    {
      "type": "any_file_contains",
      "paths": ["src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx", "src/App.jsx", "src/App.tsx", "src/reconcile.js", "src/reconcile.ts", "src/lib/reconcile.js", "src/lib/reconcile.ts", "src/app/App.tsx", "src/app/types.ts", "src/app/utils.ts"],
      "text": "match"
    },
    {
      "type": "any_file_contains",
      "paths": ["src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx", "src/App.jsx", "src/App.tsx", "src/reconcile.js", "src/reconcile.ts", "src/lib/reconcile.js", "src/lib/reconcile.ts", "src/app/App.tsx", "src/app/types.ts", "src/app/utils.ts"],
      "text": "conflict"
    },
    {
      "type": "any_file_contains",
      "paths": ["src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx", "src/App.jsx", "src/App.tsx", "src/reconcile.js", "src/reconcile.ts", "src/lib/reconcile.js", "src/lib/reconcile.ts", "src/app/App.tsx", "src/app/types.ts", "src/app/utils.ts"],
      "text": "normalize"
    },
    {
      "type": "any_file_contains",
      "paths": ["src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx", "src/App.jsx", "src/App.tsx", "src/reconcile.js", "src/reconcile.ts", "src/lib/reconcile.js", "src/lib/reconcile.ts", "src/app/App.tsx", "src/app/types.ts", "src/app/utils.ts"],
      "text": "export"
    },
    {
      "type": "any_file_contains",
      "paths": ["src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx", "src/App.jsx", "src/App.tsx", "src/reconcile.js", "src/reconcile.ts", "src/lib/reconcile.js", "src/lib/reconcile.ts", "src/app/App.tsx", "src/app/types.ts", "src/app/utils.ts"],
      "text": "import"
    },
    {
      "type": "any_file_not_contains",
      "paths": ["src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx", "src/App.jsx", "src/App.tsx"],
      "text": "Vite logo"
    },
    {
      "type": "any_file_not_contains",
      "paths": ["src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx", "src/App.jsx", "src/App.tsx"],
      "text": "Count is"
    }
  ]
}
-->

Build me a local Vite React + TypeScript app for reconciling two messy people CSV exports from different systems. It should run locally from this empty folder.

Use the sample CSV files in this prompt asset folder:

- `{{CLI_PROMPT_ASSETS_DIR}}/csv-reconciliation-people/source-a.csv`
- `{{CLI_PROMPT_ASSETS_DIR}}/csv-reconciliation-people/source-b.csv`

The app should let me paste or load CSV text for Source A and Source B, normalize names and emails, detect likely duplicate people, flag missing records, show field conflicts, and produce a cleaned merged list. Include the provided sample rows in the app so I can try it immediately without finding my own data.

I should be able to resolve conflicts, choose which source wins for a field, mark duplicates as reviewed, filter by conflict type, see reconciliation counts update as I work, persist my review locally, and export the cleaned result as JSON or CSV.

Before you finish, make sure the Vite app builds successfully and check the core workflow like a user would: load the sample data, find duplicate people, resolve at least one conflicting field, mark a missing record for inclusion, export the cleaned list, import it back, and confirm the reconciliation counts still make sense.
