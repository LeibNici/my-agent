// Shared across app.js and admin.js (both loaded as plain <script> tags —
// no bundler/module system — so this one file is the single source instead
// of each page keeping its own copy).

function escapeHtml(str) {
    // Manual replace (not the div.textContent/innerHTML trick) so this is safe
    // both in text-node context and when interpolated into an HTML attribute value.
    return String(str ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// ===== Theme toggle =====
// The actual light/dark values live in style.css (:root vs. :root[data-theme]).
// This just owns the explicit user choice: null = "follow system" (the inline
// <script> in each page's <head> already applied it before first paint if one
// was stored, so this only handles clicks after load).
function _effectiveTheme() {
    const stored = localStorage.getItem("theme");
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

// Takes the button directly rather than re-querying by id — right after
// initThemeToggle creates it, it can still be sitting in a detached subtree
// (a caller may build a wrapper div off-document before inserting it), and
// document.getElementById on a detached node silently returns null.
function _updateThemeToggleButton(btn) {
    if (!btn) return;
    const effective = _effectiveTheme();
    btn.textContent = effective === "light" ? "☾ 深色" : "☀ 浅色";
    btn.title = effective === "light" ? "切换为深色主题" : "切换为浅色主题";
}

function toggleTheme() {
    const next = _effectiveTheme() === "light" ? "dark" : "light";
    localStorage.setItem("theme", next);
    document.documentElement.setAttribute("data-theme", next);
    _updateThemeToggleButton(document.getElementById("theme-toggle-btn"));
}

// Drops a toggle button into `container` (a flex row) if one isn't already
// there — called once per page from app.js/admin.js's init. Safe to call
// with `container` still detached from the document (the label is set from
// the direct element reference, not a DOM lookup).
function initThemeToggle(container) {
    if (!container || document.getElementById("theme-toggle-btn")) return;
    const btn = document.createElement("button");
    btn.id = "theme-toggle-btn";
    btn.className = "theme-toggle-btn";
    btn.type = "button";
    btn.onclick = toggleTheme;
    container.appendChild(btn);
    _updateThemeToggleButton(btn);
}
