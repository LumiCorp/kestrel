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
      "paths": ["src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx", "src/App.jsx", "src/App.tsx", "src/SchedulePlanner.jsx", "src/SchedulePlanner.tsx", "src/ShiftCoveragePlanner.jsx", "src/ShiftCoveragePlanner.tsx", "src/lib/schedule.js", "src/lib/schedule.ts"],
      "text": "schedule"
    },
    {
      "type": "any_file_contains",
      "paths": ["src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx", "src/App.jsx", "src/App.tsx", "src/SchedulePlanner.jsx", "src/SchedulePlanner.tsx", "src/ShiftCoveragePlanner.jsx", "src/ShiftCoveragePlanner.tsx", "src/lib/schedule.js", "src/lib/schedule.ts"],
      "text": "coverage"
    },
    {
      "type": "any_file_contains",
      "paths": ["src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx", "src/App.jsx", "src/App.tsx", "src/SchedulePlanner.jsx", "src/SchedulePlanner.tsx", "src/ShiftCoveragePlanner.jsx", "src/ShiftCoveragePlanner.tsx", "src/lib/schedule.js", "src/lib/schedule.ts"],
      "text": "availability"
    },
    {
      "type": "any_file_contains",
      "paths": ["src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx", "src/App.jsx", "src/App.tsx", "src/SchedulePlanner.jsx", "src/SchedulePlanner.tsx", "src/ShiftCoveragePlanner.jsx", "src/ShiftCoveragePlanner.tsx", "src/lib/schedule.js", "src/lib/schedule.ts"],
      "text": "overtime"
    },
    {
      "type": "any_file_contains",
      "paths": ["src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx", "src/App.jsx", "src/App.tsx", "src/SchedulePlanner.jsx", "src/SchedulePlanner.tsx", "src/ShiftCoveragePlanner.jsx", "src/ShiftCoveragePlanner.tsx", "src/lib/schedule.js", "src/lib/schedule.ts"],
      "text": "rest"
    },
    {
      "type": "any_file_contains",
      "paths": ["src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx", "src/App.jsx", "src/App.tsx", "src/SchedulePlanner.jsx", "src/SchedulePlanner.tsx", "src/ShiftCoveragePlanner.jsx", "src/ShiftCoveragePlanner.tsx", "src/lib/schedule.js", "src/lib/schedule.ts"],
      "text": "audit"
    },
    {
      "type": "any_file_contains",
      "paths": ["src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx", "src/App.jsx", "src/App.tsx", "src/SchedulePlanner.jsx", "src/SchedulePlanner.tsx", "src/ShiftCoveragePlanner.jsx", "src/ShiftCoveragePlanner.tsx", "src/lib/schedule.js", "src/lib/schedule.ts"],
      "text": "export"
    },
    {
      "type": "any_file_contains",
      "paths": ["src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx", "src/App.jsx", "src/App.tsx", "src/SchedulePlanner.jsx", "src/SchedulePlanner.tsx", "src/ShiftCoveragePlanner.jsx", "src/ShiftCoveragePlanner.tsx", "src/lib/schedule.js", "src/lib/schedule.ts"],
      "text": "import"
    },
    {
      "type": "any_file_not_contains",
      "paths": ["src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx", "src/App.jsx", "src/App.tsx", "src/SchedulePlanner.jsx", "src/SchedulePlanner.tsx", "src/ShiftCoveragePlanner.jsx", "src/ShiftCoveragePlanner.tsx"],
      "text": "Vite logo"
    },
    {
      "type": "any_file_not_contains",
      "paths": ["src/main.js", "src/main.jsx", "src/main.ts", "src/main.tsx", "src/App.jsx", "src/App.tsx", "src/SchedulePlanner.jsx", "src/SchedulePlanner.tsx", "src/ShiftCoveragePlanner.jsx", "src/ShiftCoveragePlanner.tsx"],
      "text": "Count is"
    }
  ]
}
-->

Build me a local Vite app for fixing next week's cafe staff schedule from the sample files in this prompt asset folder. It should run locally from this empty folder.

Use these sample files:

- `{{CLI_PROMPT_ASSETS_DIR}}/shift-coverage/employees.csv`
- `{{CLI_PROMPT_ASSETS_DIR}}/shift-coverage/shift-requirements.csv`
- `{{CLI_PROMPT_ASSETS_DIR}}/shift-coverage/time-off-requests.csv`
- `{{CLI_PROMPT_ASSETS_DIR}}/shift-coverage/existing-schedule.csv`
- `{{CLI_PROMPT_ASSETS_DIR}}/shift-coverage/coverage-rules.json`

The app should load employees, existing assignments, time-off requests, shift requirements, and coverage rules. Show where the schedule violates coverage, availability, role, overtime, overlap, and rest-period rules.

I should be able to edit assignments, add or remove staff on a shift, suggest valid replacement staff for an uncovered or invalid assignment, keep an audit trail of schedule changes, filter by violation type, see staffing and violation counts update as I work, persist my review locally, and export the corrected schedule as CSV and JSON.

Include the provided sample data in the app so I can try it immediately without finding my own files.

Before you finish, make sure the Vite app builds successfully and check the core workflow like a cafe manager would: load the sample schedule, find at least one uncovered shift, resolve one approved time-off conflict, fix one role coverage issue, confirm the violation counts changed, export the corrected schedule, import it back, and confirm the staffing counts and remaining violations still make sense.
