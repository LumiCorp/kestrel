<!-- cli-prompt-smoke
{
  "assertions": [
    { "type": "file_exists", "path": "index.html" },
    { "type": "file_contains", "path": "index.html", "text": "recipe" },
    { "type": "file_contains", "path": "index.html", "text": "planner" },
    { "type": "file_contains", "path": "index.html", "text": "vegetarian" },
    { "type": "file_contains", "path": "index.html", "text": "prep" },
    { "type": "file_contains", "path": "index.html", "text": "course" },
    { "type": "file_not_contains", "path": "index.html", "text": "Get started" },
    { "type": "file_not_contains", "path": "index.html", "text": "Count is" },
    { "type": "file_not_contains", "path": "index.html", "text": "Vite logo" }
  ]
}
-->

Build me a local recipe planner for a weeknight dinner party. It should work in this empty folder with no dependencies and the page should clearly present itself as a recipe planner.

The app should open as a normal local web page, show at least five dishes grouped by course, let me toggle to vegetarian-only dishes, and update the total prep time for whatever dishes are visible.

Before you finish, check it like a user would so the page actually shows the dishes and the toggle and total prep time really work.
