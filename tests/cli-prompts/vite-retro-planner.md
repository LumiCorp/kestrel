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
      "paths": ["src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx", "src/App.jsx", "src/App.tsx"],
      "text": "retro"
    },
    {
      "type": "any_file_contains",
      "paths": ["src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx", "src/App.jsx", "src/App.tsx"],
      "text": "Action"
    },
    {
      "type": "any_file_contains",
      "paths": ["src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx", "src/App.jsx", "src/App.tsx"],
      "text": "category"
    }
  ]
}
-->

Build me a Vite app for planning a small team retro. It should run locally from this empty folder.

The app should let me add retro notes, assign each note to a category like Went Well, Needs Work, or Action Item, and mark action items as done. Seed it with a few realistic notes so I can see the board immediately. Show counts by category and keep the layout clean enough to use during a meeting.

Before you finish, make sure the Vite app builds successfully and that the starter Vite screen has been replaced by the retro planner.
