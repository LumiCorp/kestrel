"use client";

export function SkipLink() {
  return (
    <a
      href="#app-main"
      className="skip-link"
      onClick={() => {
        document.getElementById("app-main")?.focus();
      }}
    >
      Skip to main content
    </a>
  );
}
