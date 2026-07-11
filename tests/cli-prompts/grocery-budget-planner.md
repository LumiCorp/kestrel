<!-- cli-prompt-smoke
{
  "assertions": [
    { "type": "file_exists", "path": "index.html" },
    { "type": "file_contains", "path": "index.html", "text": "grocery" },
    { "type": "file_contains", "path": "index.html", "text": "budget" },
    { "type": "file_contains", "path": "index.html", "text": "category" },
    { "type": "file_contains", "path": "index.html", "text": "purchased" },
    { "type": "file_contains", "path": "index.html", "text": "total" },
    { "type": "file_contains", "path": "index.html", "text": "localStorage" },
    { "type": "file_not_contains", "path": "index.html", "text": "Get started" },
    { "type": "file_not_contains", "path": "index.html", "text": "Count is" },
    { "type": "file_not_contains", "path": "index.html", "text": "Vite logo" }
  ]
}
-->

Build me a local grocery budget planner for a weekend dinner. It should work in this empty folder with no dependencies.

The app should let me add grocery items with a name, category, estimated price, and whether it is already purchased. It should show the grocery list grouped by category, let me mark items purchased, and update the remaining budget and purchased/unpurchased totals as the list changes.

Seed it with a realistic starter list so I can use it immediately, remember my changes locally when I reload the page, and before you finish, check that adding an item, marking an item purchased, and the totals are wired together.
