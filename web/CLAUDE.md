# CLAUDE.md — web/

Frontend: no framework, no build — `app.js` (main chat UI), `admin.js`
(admin console), `shared.js` (small cross-page helpers), each paired with
its own HTML entry point (`index.html`, `admin.html`, `login.html`) and a
single shared `style.css`.

See `.impeccable.md` (repo root) for the design language (color vocabulary,
typography, dark + light theme) — read it before touching `style.css` or
making other visual/UI decisions.
