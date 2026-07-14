// Shared across app.js and admin.js (both loaded as plain <script> tags —
// no bundler/module system — so this one file is the single source instead
// of each page keeping its own copy).

// ===== Global 401 handling =====
// app.js's own authFetch used to catch this itself, but admin.js's many
// direct fetch()+authHeaders() calls had no equivalent — an expired token
// on the admin page just left every action silently failing forever, no
// error, no redirect. Wrapping window.fetch once here (loaded before
// app.js/admin.js on both pages) covers every call site in both files at
// once instead of chasing down each one. login.html doesn't load shared.js
// at all, so its own login-attempt 401 (wrong password, not an expired
// session) is untouched by this.
(function installGlobal401Handler() {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
        return nativeFetch(input, init).then((resp) => {
            if (resp.status === 401 && !location.pathname.startsWith("/login")) {
                localStorage.removeItem("token");
                localStorage.removeItem("user");
                location.href = "/login?reason=expired";
            }
            return resp;
        });
    };
})();

// ===== Git SHA badge =====
// Shows which commit the running site is actually serving — a real
// recurring question during deploy work ("is this the version I just
// pushed?") with no way to answer it from the UI before this. Both
// app.js and admin.js call this once their own /api/config fetch (which
// now carries git_sha, see app.ts's readGitSha) resolves.
function showGitSha(sha, container) {
    if (!container || !sha || document.getElementById("git-sha-label")) return;
    const el = document.createElement("div");
    el.id = "git-sha-label";
    el.className = "git-sha-label";
    el.textContent = sha === "unknown" ? "commit: unknown" : `commit: ${sha.slice(0, 9)}`;
    el.title = sha;
    container.appendChild(el);
}

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

// Codex full-repo review (2026-07-14, Critical #4): escapeHtml alone
// neutralizes HTML injection but does NOT stop a "javascript:" (or other
// non-http(s)) URL from executing on click — every issue_url/web_url
// rendered as an <a href> comes straight from the tracker's (GitHub/GitLab)
// JSON response, which is only TypeScript-asserted, never runtime-validated
// (issue-tracker-client.ts). A compromised/malicious/SSRF-redirected tracker
// endpoint could return a javascript: URL. Only http:/https: pass through;
// anything else falls back to "#".
function safeUrl(url) {
    try {
        const parsed = new URL(String(url ?? ""), location.origin);
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? String(url) : "#";
    } catch {
        return "#";
    }
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

// ===== Modal dialogs =====
// In-page replacement for native alert()/confirm()/prompt() — those render
// as browser-chrome popups that break the app's own visual language (see
// .modal-* in style.css). One shared overlay+card builder; confirmDialog/
// promptDialog/alertDialog just vary its content and buttons. Each returns
// a Promise so call sites `await` them the same way they'd have used the
// synchronous native versions, just one keyword added.
function _buildModal({ title, message, danger, input }) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const card = document.createElement("div");
    card.className = danger ? "modal-card modal-danger" : "modal-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    if (title) {
        const t = document.createElement("div");
        t.className = "modal-title";
        t.textContent = title;
        card.appendChild(t);
    }
    if (message) {
        const m = document.createElement("div");
        m.className = "modal-message";
        m.textContent = message;
        card.appendChild(m);
    }
    let inputEl = null;
    if (input) {
        inputEl = document.createElement("input");
        inputEl.type = input.type || "text";
        inputEl.className = "modal-input";
        inputEl.placeholder = input.placeholder || "";
        if (input.value) inputEl.value = input.value;
        card.appendChild(inputEl);
    }
    const actions = document.createElement("div");
    actions.className = "modal-actions";
    card.appendChild(actions);
    overlay.appendChild(card);
    return { overlay, actions, inputEl };
}

// Wires the shared teardown (remove from DOM, drop the keydown listener,
// unlock body scroll) behind a single `finish` call each dialog variant
// builds its own resolve-value around.
function _mountModal(overlay, resolve, resultForKey) {
    document.body.classList.add("modal-open");
    document.body.appendChild(overlay);
    const onKeydown = (e) => {
        if (e.key !== "Escape" && e.key !== "Enter") return;
        finish(resultForKey(e));
    };
    function finish(result) {
        document.removeEventListener("keydown", onKeydown);
        overlay.remove();
        document.body.classList.remove("modal-open");
        resolve(result);
    }
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) finish(resultForKey({ key: "Escape" }));
    });
    // Deferred, not attached synchronously: a modal opened from inside a
    // keydown handler (e.g. sendMessage's Enter-to-send guard) is still
    // mid-bubble on the SAME keypress when this function runs — an
    // immediately-attached document listener would catch that same
    // in-flight Enter and instantly self-close the modal before it's ever
    // visible (confirmed: this silently ate the workspace-selection guard
    // in testing). Adding it after the current dispatch finishes means it
    // only ever sees genuinely NEW keypresses.
    setTimeout(() => document.addEventListener("keydown", onKeydown), 0);
    return finish;
}

function confirmDialog({ title = "", message = "", confirmLabel = "确认", cancelLabel = "取消", danger = false } = {}) {
    return new Promise((resolve) => {
        const { overlay, actions } = _buildModal({ title, message, danger });
        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "btn-cancel";
        cancelBtn.textContent = cancelLabel;
        const confirmBtn = document.createElement("button");
        confirmBtn.type = "button";
        confirmBtn.className = danger ? "btn-confirm btn-danger" : "btn-confirm";
        confirmBtn.textContent = confirmLabel;
        actions.appendChild(cancelBtn);
        actions.appendChild(confirmBtn);

        const finish = _mountModal(overlay, resolve, (e) => e.key === "Enter");
        cancelBtn.onclick = () => finish(false);
        confirmBtn.onclick = () => finish(true);
        confirmBtn.focus();
    });
}

function promptDialog({
    title = "", message = "", placeholder = "", defaultValue = "", inputType = "text",
    confirmLabel = "确认", cancelLabel = "取消",
} = {}) {
    return new Promise((resolve) => {
        const { overlay, actions, inputEl } = _buildModal({
            title, message, input: { type: inputType, placeholder, value: defaultValue },
        });
        const cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.className = "btn-cancel";
        cancelBtn.textContent = cancelLabel;
        const confirmBtn = document.createElement("button");
        confirmBtn.type = "button";
        confirmBtn.className = "btn-confirm";
        confirmBtn.textContent = confirmLabel;
        actions.appendChild(cancelBtn);
        actions.appendChild(confirmBtn);

        const finish = _mountModal(overlay, resolve, (e) => (e.key === "Enter" ? inputEl.value : null));
        cancelBtn.onclick = () => finish(null);
        confirmBtn.onclick = () => finish(inputEl.value);
        inputEl.focus();
    });
}

function alertDialog({ title = "", message = "", confirmLabel = "知道了" } = {}) {
    return new Promise((resolve) => {
        const { overlay, actions } = _buildModal({ title, message });
        const okBtn = document.createElement("button");
        okBtn.type = "button";
        okBtn.className = "btn-confirm";
        okBtn.textContent = confirmLabel;
        actions.appendChild(okBtn);

        const finish = _mountModal(overlay, resolve, () => undefined);
        okBtn.onclick = () => finish();
        okBtn.focus();
    });
}
