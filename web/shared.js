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
