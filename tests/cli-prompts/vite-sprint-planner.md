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
      "paths": ["src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx", "src/App.jsx", "src/App.tsx", "src/SprintPlanner.jsx", "src/SprintPlanner.tsx", "src/components/SprintPlanner.jsx", "src/components/SprintPlanner.tsx"],
      "text": "sprint"
    },
    {
      "type": "any_file_contains",
      "paths": ["src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx", "src/App.jsx", "src/App.tsx", "src/SprintPlanner.jsx", "src/SprintPlanner.tsx", "src/components/SprintPlanner.jsx", "src/components/SprintPlanner.tsx"],
      "text": "capacity"
    },
    {
      "type": "any_file_contains",
      "paths": ["src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx", "src/App.jsx", "src/App.tsx", "src/SprintPlanner.jsx", "src/SprintPlanner.tsx", "src/components/SprintPlanner.jsx", "src/components/SprintPlanner.tsx"],
      "text": "risk"
    },
    {
      "type": "any_file_contains",
      "paths": ["src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx", "src/App.jsx", "src/App.tsx", "src/SprintPlanner.jsx", "src/SprintPlanner.tsx", "src/components/SprintPlanner.jsx", "src/components/SprintPlanner.tsx"],
      "text": "export"
    },
    {
      "type": "any_file_contains",
      "paths": ["src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx", "src/App.jsx", "src/App.tsx", "src/SprintPlanner.jsx", "src/SprintPlanner.tsx", "src/components/SprintPlanner.jsx", "src/components/SprintPlanner.tsx"],
      "text": "import"
    },
    {
      "type": "any_file_contains",
      "paths": ["src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx", "src/App.jsx", "src/App.tsx", "src/SprintPlanner.jsx", "src/SprintPlanner.tsx", "src/components/SprintPlanner.jsx", "src/components/SprintPlanner.tsx"],
      "text": "localStorage"
    },
    {
      "type": "any_file_not_contains",
      "paths": ["src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx", "src/App.jsx", "src/App.tsx", "src/SprintPlanner.jsx", "src/SprintPlanner.tsx", "src/components/SprintPlanner.jsx", "src/components/SprintPlanner.tsx"],
      "text": "Vite logo"
    },
    {
      "type": "any_file_not_contains",
      "paths": ["src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx", "src/App.jsx", "src/App.tsx", "src/SprintPlanner.jsx", "src/SprintPlanner.tsx", "src/components/SprintPlanner.jsx", "src/components/SprintPlanner.tsx"],
      "text": "Count is"
    }
  ]
}
-->

Build me a Vite app for running a small product sprint planning session. It should run locally from this empty folder.

The app should have a planning board with tasks grouped by status, a capacity view grouped by owner, and a risks/decisions view for tracking open questions. Seed it with realistic sprint data so I can use it immediately.

I should be able to add and edit tasks with title, owner, estimate, priority, and status; move tasks between statuses; add risks or decisions; filter by owner or priority; and see sprint totals update as I work.

Remember changes locally when I reload the page. Also include a way to export the sprint data as JSON and import it back into the app.

Before you finish, make sure the Vite app builds successfully and check the core workflow like a user would: add a task, move it, filter the board, add a risk or decision, export data, import it back, and confirm the totals still make sense.
