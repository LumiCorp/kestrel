<!-- cli-prompt-smoke
{
  "assertions": [
    { "type": "any_file_exists", "paths": ["index.html", "newsletter.html", "public/index.html", "src/App.jsx"] },
    { "type": "any_file_contains", "paths": ["index.html", "newsletter.html", "public/index.html", "src/App.jsx"], "text": "newsletter" },
    { "type": "any_file_contains", "paths": ["index.html", "newsletter.html", "public/index.html", "src/App.jsx"], "text": "stories" },
    { "type": "any_file_not_contains", "paths": ["index.html", "newsletter.html", "public/index.html", "src/App.jsx"], "text": "Get started" },
    { "type": "any_file_not_contains", "paths": ["index.html", "newsletter.html", "public/index.html", "src/App.jsx"], "text": "Count is" },
    { "type": "any_file_not_contains", "paths": ["index.html", "newsletter.html", "public/index.html", "src/App.jsx"], "text": "Vite logo" }
  ]
}
-->

Build me a simple newsletter page with three sample stories. It should work locally in this empty folder.
