<!-- cli-prompt-smoke
{
  "assertions": [
    { "type": "any_file_exists", "paths": ["index.html", "public/index.html", "src/App.jsx", "app/page.tsx", "src/app/page.tsx"] },
    { "type": "any_file_contains", "paths": ["index.html", "public/index.html", "src/App.jsx", "app/page.tsx", "src/app/page.tsx"], "text": "itinerary" },
    { "type": "any_file_contains", "paths": ["index.html", "public/index.html", "src/App.jsx", "app/page.tsx", "src/app/page.tsx"], "text": "Portland" },
    { "type": "any_file_contains", "paths": ["index.html", "public/index.html", "src/App.jsx", "app/page.tsx", "src/app/page.tsx"], "text": "Friday" },
    { "type": "any_file_contains", "paths": ["index.html", "public/index.html", "src/App.jsx", "app/page.tsx", "src/app/page.tsx"], "text": "Saturday" },
    { "type": "any_file_contains", "paths": ["index.html", "public/index.html", "src/App.jsx", "app/page.tsx", "src/app/page.tsx"], "text": "Sunday" },
    { "type": "any_file_contains", "paths": ["index.html", "public/index.html", "src/App.jsx", "app/page.tsx", "src/app/page.tsx"], "text": "budget" },
    { "type": "any_file_contains", "paths": ["index.html", "public/index.html", "src/App.jsx", "app/page.tsx", "src/app/page.tsx"], "text": "packing" },
    { "type": "any_file_not_contains", "paths": ["index.html", "public/index.html", "src/App.jsx", "app/page.tsx", "src/app/page.tsx"], "text": "Get started" },
    { "type": "any_file_not_contains", "paths": ["index.html", "public/index.html", "src/App.jsx", "app/page.tsx", "src/app/page.tsx"], "text": "Count is" },
    { "type": "any_file_not_contains", "paths": ["index.html", "public/index.html", "src/App.jsx", "app/page.tsx", "src/app/page.tsx"], "text": "Vite logo" }
  ]
}
-->

Build me a polished local weekend itinerary page for a three-day Portland trip. It should work in this empty folder and include a Friday, Saturday, and Sunday schedule, a small budget summary, and a packing checklist.
