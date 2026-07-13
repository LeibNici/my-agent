// ===== Auth =====
const _token = localStorage.getItem("token");
const _user = JSON.parse(localStorage.getItem("user") || "null");
const _isAuthenticated = !!_token;
if (!_isAuthenticated) { window.location.href = "/login"; }

function authHeaders() {
    return { "Authorization": `Bearer ${_token}` };
}

function authFetch(url, opts = {}) {
    opts.headers = { ...(opts.headers || {}), ...authHeaders() };
    return fetch(url, opts).then(resp => {
        if (resp.status === 401) { localStorage.removeItem("token"); window.location.href = "/login"; }
        return resp;
    });
}

function logout() {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    window.location.href = "/login";
}

// ===== State =====
let currentSessionId = null;
let activeSkills = [];
let selectedRepoId = null;
let isStreaming = false;
let currentAbortController = null;
let pendingImages = []; // { mediaType, data (base64, no prefix), previewUrl (data URL) }

// Fallback defaults, used until loadConfig() below overwrites them with the
// server's real values — kept in sync via /api/config instead of two
// separately hardcoded copies that can silently drift apart.
let MAX_IMAGES_PER_MESSAGE = 5;
let MAX_IMAGE_BYTES = 4_500_000;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

async function loadConfig() {
    try {
        const resp = await authFetch("/api/config");
        if (!resp.ok) return;
        const config = await resp.json();
        if (config.max_images_per_message) MAX_IMAGES_PER_MESSAGE = config.max_images_per_message;
        if (config.max_image_bytes) MAX_IMAGE_BYTES = config.max_image_bytes;
    } catch {} // keep the fallback defaults above if this fails
}

// ===== Init =====
document.addEventListener("DOMContentLoaded", () => {
    if (!_isAuthenticated) return; // redirect to /login is already in flight — don't fire authenticated requests

    // Show user info in sidebar
    const header = document.querySelector(".sidebar-header");
    if (_user && header) {
        const userInfo = document.createElement("div");
        userInfo.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;font-size:13px;color:var(--text-secondary)";

        const nameSpan = document.createElement("span");
        nameSpan.textContent = _user.username;

        const actions = document.createElement("div");
        actions.style.cssText = "display:flex;align-items:center;gap:8px;";

        const logoutBtn = document.createElement("button");
        logoutBtn.textContent = "退出";
        logoutBtn.style.cssText = "background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:12px;";
        logoutBtn.onclick = logout;

        userInfo.appendChild(nameSpan);
        userInfo.appendChild(actions);
        actions.appendChild(logoutBtn);
        header.insertBefore(userInfo, header.querySelector("#new-chat-btn"));
        // Only call this once `actions` is attached to the live document —
        // initThemeToggle looks itself up via document.getElementById right
        // after creating the button, which returns nothing (and leaves the
        // button's label unset) if the subtree is still detached.
        initThemeToggle(actions);
    }
    loadConfig();
    loadRepos();
    loadSkills();
    loadSessions();
    refreshMyIssuesBadge(); // _isAuthenticated already guaranteed by the early return above

    const inputArea = document.getElementById("input-area");
    if (inputArea) {
        inputArea.addEventListener("dragover", (e) => e.preventDefault());
        inputArea.addEventListener("drop", (e) => {
            e.preventDefault();
            const files = e.dataTransfer && e.dataTransfer.files;
            if (files) Array.from(files).filter(f => f.type.startsWith("image/")).forEach(addImageFile);
        });
    }
});

// ===== Escape key: cancel stream / close panels =====
document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const viewer = document.getElementById("code-viewer");
    if (viewer && !viewer.hidden) {
        viewer.hidden = true;
        return; // one Escape = one action; don't also cancel the stream
    }
    const drawer = document.getElementById("my-issues-drawer");
    if (drawer && !drawer.hidden) {
        closeMyIssues();
        return;
    }
    if (isStreaming && currentAbortController) {
        currentAbortController.abort();
    }
    closeSidebar(); // close mobile sidebar
});

// ===== My filed issues (我的提报) drawer =====
// Submitter-facing view of issue_submissions + tracking state. The admin
// poller keeps the data fresh; this is read-only. Status vocabulary is
// translated from tracker jargon into "what should I do now" terms — the
// load-bearing one is 可验证 (merged to test): the submitter can go
// re-verify on the test environment. Colors reuse the app's existing
// moss/amber/rust status vocabulary (.impeccable.md) rather than a new
// palette: amber = needs your attention, moss = done, rust = regressed.
const MI_STATUS = {
    submitted: { label: "待处理", color: "var(--faint)" },
    claimed:   { label: "修复中", color: "var(--mute)" },
    merged:    { label: "可验证", color: "var(--amber)" },
    closed:    { label: "已完成", color: "var(--moss)" },
    reopened:  { label: "重新处理中", color: "var(--rust)" },
};

// authFetch (not a raw fetch) throughout — an expired token needs the
// standard redirect-to-login every other call gets, not a silently empty
// result that reads as "no issues filed."

async function refreshMyIssuesBadge() {
    // A COUNT query server-side, not the full drawer payload — freshness
    // itself is computed in SQL against the user's own my_issues_seen_at
    // (both server-local timestamps, so unlike the old localStorage-based
    // version this can't be thrown off by the browser's clock/timezone
    // disagreeing with the server's).
    const badge = document.getElementById("my-issues-badge");
    if (!badge) return;
    try {
        const resp = await authFetch("/api/issues/mine/unread-count");
        const { count } = resp.ok ? await resp.json() : { count: 0 };
        badge.textContent = count;
        badge.hidden = count === 0;
    } catch {
        badge.hidden = true; // network error — fail quiet, not with a stale/wrong count
    }
}

async function openMyIssues() {
    const drawer = document.getElementById("my-issues-drawer");
    const overlay = document.getElementById("my-issues-overlay");
    const list = document.getElementById("my-issues-list");
    drawer.hidden = false;
    overlay.hidden = false;
    list.innerHTML = `<div class="mi-empty">加载中…</div>`;

    let items;
    try {
        const resp = await authFetch("/api/issues/mine");
        items = resp.ok ? await resp.json() : null;
    } catch {
        items = null;
    }
    if (items === null) {
        list.innerHTML = `<div class="mi-empty">加载失败，请重试。</div>`;
        return; // don't mark-seen on a failed load — nothing was actually shown
    }

    if (!items.length) {
        list.innerHTML = `<div class="mi-empty">还没有提报过工单。<br>在会话里确认一个 bug 后即可一键提报。</div>`;
    } else {
        list.innerHTML = items.map(s => {
            const status = MI_STATUS[s.track_status] ? s.track_status : "submitted";
            const st = MI_STATUS[status];
            return `
            <div class="mi-item" data-status="${status}" data-fresh="${!!s.fresh}">
                <div class="mi-item-row">
                    <span class="mi-item-id">${s.fresh ? `<span class="sr-only">有新进展：</span>` : ""}#${s.issue_number}</span>
                    <span class="mi-item-status">${st.label}</span>
                </div>
                <a class="mi-item-title" href="${escapeHtml(s.issue_url || "#")}" target="_blank" rel="noopener">${escapeHtml(s.title)}</a>
                <div class="mi-item-meta">
                    ${escapeHtml(s.repo_name || "")} · ${escapeHtml((s.submitted_at || "").slice(0, 16).replace("T", " "))}
                    ${s.reopen_count ? ` · <span class="mi-reopen-count">被打回 ×${s.reopen_count}</span>` : ""}
                </div>
                ${s.fix_verified ? `<div class="mi-fix-detail">commit ${escapeHtml(s.fix_commit || "")} · ${s.fix_files_count} 个文件</div>` : ""}
            </div>`;
        }).join("");
    }

    // Mark seen server-side (stamps the server's own clock) now that the
    // current fresh/stale state has actually been rendered.
    authFetch("/api/issues/mine/seen", { method: "POST" }).catch(() => {});
    const badge = document.getElementById("my-issues-badge");
    if (badge) badge.hidden = true;
}

function closeMyIssues() {
    document.getElementById("my-issues-drawer").hidden = true;
    document.getElementById("my-issues-overlay").hidden = true;
}

// ===== Mobile sidebar toggle =====
function toggleSidebar() {
    const sidebar = document.getElementById("sidebar");
    const overlay = document.getElementById("sidebar-overlay");
    sidebar.classList.toggle("open");
    overlay.classList.toggle("active");
}

function closeSidebar() {
    const sidebar = document.getElementById("sidebar");
    const overlay = document.getElementById("sidebar-overlay");
    sidebar.classList.remove("open");
    overlay.classList.remove("active");
}

// ===== Repos =====
let reposCache = []; // visible repos — used to resolve names for issue cards

async function loadRepos() {
    const resp = await authFetch("/api/repos");
    const repos = await resp.json();
    reposCache = repos;
    const container = document.getElementById("repos-list");
    if (!container) return;
    container.innerHTML = "";

    if (repos.length === 0) {
        container.innerHTML = '<p style="font-size:12px;color:var(--text-secondary);padding:4px 0;">暂无可访问的仓库</p>';
        return;
    }

    repos.forEach(r => {
        const chip = document.createElement("button");
        chip.className = "repo-chip";
        chip.innerHTML = `<span class="repo-branch">${escapeHtml(r.branch || "main")}</span><span class="repo-name">${escapeHtml(r.name)}</span>`;
        chip.title = r.url;
        chip.dataset.repoId = r.id;
        chip.onclick = () => selectRepo(chip, r.id);
        container.appendChild(chip);
    });
}

function selectRepo(chip, repoId) {
    // Toggle selection (only one repo at a time)
    document.querySelectorAll("#repos-list .repo-chip").forEach(c => c.classList.remove("active"));
    if (selectedRepoId === repoId) {
        selectedRepoId = null;
    } else {
        selectedRepoId = repoId;
        chip.classList.add("active");
    }
}
async function loadSkills() {
    const resp = await authFetch("/api/skills");
    const skills = await resp.json();
    const container = document.getElementById("skills-list");
    container.innerHTML = "";

    skills.forEach(skill => {
        const chip = document.createElement("button");
        chip.className = "skill-chip";
        chip.textContent = skill.name;
        chip.title = skill.description;
        chip.dataset.name = skill.name;
        chip.onclick = () => toggleSkill(chip, skill.name);
        container.appendChild(chip);
    });
}

function toggleSkill(chip, name) {
    const idx = activeSkills.indexOf(name);
    if (idx >= 0) {
        activeSkills.splice(idx, 1);
        chip.classList.remove("active");
    } else {
        activeSkills.push(name);
        chip.classList.add("active");
    }
}

// ===== Sessions =====
let sessionsCache = [];

async function loadSessions() {
    const resp = await authFetch("/api/sessions");
    sessionsCache = await resp.json();
    renderSessions();
}

function filterSessions() { renderSessions(); }

// Bucket a session by its last activity for the git-log-style history list.
function sessionGroup(updatedAt) {
    const d = new Date(updatedAt);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (d >= today) return "今天";
    if (d >= new Date(today.getTime() - 86400e3)) return "昨天";
    if (d >= new Date(today.getTime() - 7 * 86400e3)) return "近 7 天";
    return "更早";
}

function renderSessions() {
    const container = document.getElementById("sessions-list");
    container.innerHTML = "";
    const q = (document.getElementById("session-search")?.value || "").trim().toLowerCase();
    const sessions = q
        ? sessionsCache.filter(s => (s.title || "").toLowerCase().includes(q) || s.id.includes(q))
        : sessionsCache;

    let lastGroup = null;
    sessions.forEach(s => {
        const group = sessionGroup(s.updated_at);
        if (group !== lastGroup) {
            lastGroup = group;
            const label = document.createElement("div");
            label.className = "session-group-label";
            label.textContent = group;
            container.appendChild(label);
        }
        const item = document.createElement("div");
        item.className = "session-item"
            + (s.id === currentSessionId ? " active" : "")
            + (s.resolved_at ? " resolved" : "");
        if (s.resolved_at) item.title = "已提交 issue，本会话已完结";

        const info = document.createElement("div");
        info.className = "session-info";

        const title = document.createElement("span");
        title.className = "session-title";
        title.textContent = s.title;

        const idSpan = document.createElement("span");
        idSpan.className = "session-id";
        idSpan.textContent = s.id;
        idSpan.title = "点击复制会话 ID，用于追踪/反馈问题";
        idSpan.onclick = (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(s.id).then(() => {
                const original = idSpan.textContent;
                idSpan.textContent = "已复制";
                setTimeout(() => { idSpan.textContent = original; }, 1000);
            });
        };

        info.appendChild(title);
        info.appendChild(idSpan);

        const delBtn = document.createElement("button");
        delBtn.className = "delete-btn";
        delBtn.textContent = "×";
        delBtn.onclick = (e) => { e.stopPropagation(); deleteSession(s.id); };

        item.appendChild(info);
        item.appendChild(delBtn);
        item.onclick = () => openSession(s.id);
        container.appendChild(item);
    });
}

async function openSession(sessionId) {
    // Abort any ongoing stream before switching
    if (currentAbortController) {
        currentAbortController.abort();
    }
    closeSidebar(); // close mobile sidebar

    currentSessionId = sessionId;
    const resp = await authFetch(`/api/sessions/${sessionId}`);
    const data = await resp.json();

    const messagesDiv = document.getElementById("messages");
    messagesDiv.innerHTML = "";

    // Tool results are persisted as separate "user"-role bookkeeping messages
    // (tool_use_id -> content) rather than attached to the assistant's
    // tool_use block itself — map them up front so each tool_use can show
    // what it actually returned (needed to reconstruct issue_draft cards).
    const toolResults = {};
    data.messages.forEach(msg => {
        if (msg.role === "user" && Array.isArray(msg.content)) {
            msg.content.forEach(block => {
                if (block.type === "tool_result") toolResults[block.tool_use_id] = block.content;
            });
        }
    });

    // Match a drafted issue to its real outcome primarily by the draft_issue
    // tool_use id (stable, collision-free) — title is kept only as a fallback
    // for rows recorded before draft_tool_use_id existed, since two drafts in
    // one session can otherwise share a title and reconcile to the wrong card.
    const submissionsById = {};
    const submissionsByTitle = {};
    (data.issue_submissions || []).forEach(s => {
        if (s.draft_tool_use_id) submissionsById[s.draft_tool_use_id] = s;
        else submissionsByTitle[s.title] = s;
    });

    // manage_issue drafts always carry a draft_tool_use_id (no legacy rows
    // predate this feature), so unlike issue_submissions there's no title
    // fallback key needed here.
    const actionsById = {};
    (data.issue_actions || []).forEach(a => {
        if (a.draft_tool_use_id) actionsById[a.draft_tool_use_id] = a;
    });

    const feedbackMap = data.feedback || {}; // {message_id: rating} for me
    data.messages.forEach(msg => {
        if (msg.role === "user") {
            // Pure tool-result relay messages have no standalone bubble —
            // they're shown via the paired tool_use block above.
            if (Array.isArray(msg.content) && msg.content.length && msg.content.every(b => b.type === "tool_result")) return;
            appendUserMessage(msg.content);
        } else if (msg.role === "assistant") {
            appendAssistantMessage(msg.content, toolResults, submissionsById, submissionsByTitle,
                                   actionsById, msg.id, feedbackMap[msg.id]);
        }
    });

    if (data.session && data.session.resolved_at) appendResolvedNotice();

    loadSessions(); // refresh active highlight
}

// Single source for the empty state — index.html ships the same markup for
// first load; this copy is used whenever the view resets (new chat, delete).
const WELCOME_HTML = `
    <div class="welcome-message">
        <div class="welcome-eyebrow">CodeAxis · code-aware chat</div>
        <h1>从这里开始</h1>
        <p>选择左侧仓库和技能，或直接描述你要做的事。</p>
        <div class="welcome-examples">
            <button class="example-chip" onclick="fillExample(this)">这段代码逻辑是什么？帮我逐步讲解</button>
            <button class="example-chip" onclick="fillExample(this)">确认一下这个 bug 是否真的存在</button>
            <button class="example-chip" onclick="fillExample(this)">帮我起草一个 GitHub issue</button>
        </div>
    </div>
`;

async function deleteSession(sessionId) {
    await authFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
    if (currentSessionId === sessionId) {
        currentSessionId = null;
        document.getElementById("messages").innerHTML = WELCOME_HTML;
    }
    loadSessions();
}

function newChat() {
    if (currentAbortController) {
        currentAbortController.abort();
    }
    closeSidebar(); // close mobile sidebar
    currentSessionId = null;
    document.getElementById("messages").innerHTML = WELCOME_HTML;
    loadSessions();
}

// ===== Chat =====
function handleKeyDown(event) {
    if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
    }
}

function autoResize(textarea) {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 150) + "px";
}

function fillExample(btn) {
    const input = document.getElementById("message-input");
    input.value = btn.textContent;
    autoResize(input);
    input.focus();
}

async function sendMessage() {
    const input = document.getElementById("message-input");
    const text = input.value.trim();
    if ((!text && pendingImages.length === 0) || isStreaming) return;

    // Validate message size
    if (text.length > 10000) {
        alert("Message too long (max 10,000 characters)");
        return;
    }

    // Clear welcome
    const messagesDiv = document.getElementById("messages");
    const welcome = messagesDiv.querySelector(".welcome-message");
    if (welcome) welcome.remove();

    const imagesToSend = pendingImages.map(img => ({ media_type: img.mediaType, data: img.data }));

    // Show user message (images + text, matching what's actually sent)
    const userContent = imagesToSend.length
        ? [
            ...imagesToSend.map(img => ({ type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } })),
            ...(text ? [{ type: "text", text }] : []),
          ]
        : text;
    const userMsgEl = appendUserMessage(userContent);
    const sessionIdAtStart = currentSessionId;
    input.value = "";
    input.style.height = "auto";
    clearPendingImages();

    // Send
    isStreaming = true;
    currentAbortController = new AbortController();
    setSendButtonState("stop");

    // Create assistant bubble
    const { bubble, contentEl } = appendAssistantBubble();

    try {
        const resp = await authFetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                session_id: currentSessionId,
                message: text,
                active_skills: activeSkills,
                repo_id: selectedRepoId,
                images: imagesToSend,
            }),
            signal: currentAbortController.signal,
        });

        // Check HTTP status before reading SSE
        if (!resp.ok) {
            let errMsg = `Server error: ${resp.status}`;
            try {
                const errData = await resp.json();
                errMsg = errData.detail || errMsg;
            } catch {}
            throw new Error(errMsg);
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let fullText = "";
        let eventType = "message";
        // Text arrives in runs separated by tool calls (preamble, then tool
        // calls, then a final answer, etc). Each run gets its own element
        // appended after whatever came before it, so later tool blocks or
        // text never overwrite earlier ones.
        const textRuns = []; // [{el, text}]
        let activeRun = null;
        // Every tool call for this message collapses into ONE group, pinned
        // as the last element in the bubble — text always gets inserted
        // before it, so the reply reads as continuous prose with the tool
        // activity log tucked at the end instead of interrupting it.
        let messageToolGroup = null;

        // Named so it can be invoked once more after the read loop below,
        // for a final line the server wrote without its trailing "\n" (see
        // that call site's comment).
        const processSseLine = (line) => {
                if (line.startsWith("event:")) {
                    eventType = line.slice(6).trim();
                } else if (line.startsWith("data:")) {
                    const dataStr = line.slice(5).trim();
                    if (!dataStr) {
                        eventType = "message"; // reset on empty data
                        return;
                    }
                    let data;
                    try { data = JSON.parse(dataStr); } catch { return; }

                    if (eventType === "session") {
                        // Fires once, right at the start of the turn — learn the
                        // real session_id well before "done", so an issue-draft
                        // card rendered mid-turn can be submitted against the
                        // right session even if the user confirms immediately.
                        if (data.session_id) {
                            // sessionIdAtStart is only set (non-null) when we opened an
                            // existing session before sending. data.reason (set by
                            // chat_event_stream in main.py) says WHY the id might differ
                            // from that — "resolved" (task already done) or "not_found"
                            // (the session was deleted/is gone) both deserve a notice,
                            // with different wording; "new"/null do not, since those
                            // aren't actually a switch away from a thread the user was
                            // looking at.
                            if (sessionIdAtStart && data.session_id !== sessionIdAtStart &&
                                (data.reason === "resolved" || data.reason === "not_found")) {
                                insertSessionSwitchNotice(userMsgEl, sessionIdAtStart, data.reason);
                            }
                            currentSessionId = data.session_id;
                        }
                    } else if (eventType === "text") {
                        if (!activeRun) {
                            hideThinking(contentEl);
                            const el = document.createElement("div");
                            el.className = "text-run";
                            // Keep text ahead of the (single) tool group rather
                            // than appending after it — the log stays pinned
                            // at the end no matter how many more tool calls follow.
                            if (messageToolGroup) {
                                contentEl.insertBefore(el, messageToolGroup.el);
                            } else {
                                contentEl.appendChild(el);
                            }
                            activeRun = { el, text: "" };
                            textRuns.push(activeRun);
                        }
                        activeRun.text += data.text;
                        fullText += data.text;
                        // During streaming: show plain text (avoids broken partial markdown)
                        activeRun.el.innerHTML = escapeHtml(activeRun.text).replace(/\n/g, "<br>");
                        scrollToBottom();
                    } else if (eventType === "tool_use") {
                        activeRun = null; // any further text starts a new run, still inserted before the tool group
                        if (!messageToolGroup) {
                            hideThinking(contentEl);
                            messageToolGroup = createToolGroup(contentEl);
                        }
                        messageToolGroup.total++;
                        messageToolGroup.counts[data.name] = (messageToolGroup.counts[data.name] || 0) + 1;
                        updateToolGroupSummary(messageToolGroup);
                        appendToolBlock(messageToolGroup.bodyEl, data.name, data.input, null);
                        scrollToBottom();
                    } else if (eventType === "tool_result") {
                        if (messageToolGroup) {
                            updateToolResult(messageToolGroup.bodyEl, data.name, data.result);
                            messageToolGroup.done++;
                            updateToolGroupSummary(messageToolGroup);
                        }
                        // Detect issue draft and render confirmation card
                        if (data.name === "draft_issue") {
                            try {
                                const draft = JSON.parse(data.result);
                                if (draft.type === "issue_draft") {
                                    appendIssueCard(contentEl, draft, null, data.id);
                                }
                            } catch {}
                        } else if (data.name === "manage_issue") {
                            try {
                                const draft = JSON.parse(data.result);
                                if (draft.type === "issue_action_draft") {
                                    appendIssueActionCard(contentEl, draft, null, data.id);
                                }
                            } catch {}
                        }
                        // The model may take a while to start its next step (another
                        // tool call, or the final answer) — show a visible "still
                        // working" cue instead of going silent until it does.
                        showThinking(contentEl);
                        scrollToBottom();
                    } else if (eventType === "done") {
                        if (data.session_id) {
                            currentSessionId = data.session_id;
                        }
                        hideThinking(contentEl);
                        // Now render each text run as complete markdown, in place
                        for (const run of textRuns) {
                            run.el.innerHTML = renderMarkdown(run.text);
                            highlightCode(run.el);
                            linkifyCodeRefs(run.el);
                        }
                        if (data.message_id) {
                            appendFeedbackBar(bubble, data.message_id, null);
                        }
                        if (data.budget_exhausted) {
                            appendBudgetExhaustedNotice();
                        }
                    } else if (eventType === "error") {
                        hideThinking(contentEl);
                        contentEl.innerHTML += `<p style="color:var(--error)">${escapeHtml(data.message)}</p>`;
                    }
                    // Reset eventType after processing data
                    eventType = "message";
                } else if (line.trim() === "") {
                    // Blank line = SSE event boundary, reset event type
                    eventType = "message";
                }
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                processSseLine(line);
            }
        }
        if (buffer) {
            // The connection can close right after a final data:/event: line
            // without its trailing "\n" ever arriving (abrupt disconnect
            // during a slow write) — process whatever's left instead of
            // silently dropping the last event, often "done" carrying
            // session_id/message_id.
            processSseLine(buffer);
        }
    } catch (err) {
        hideThinking(contentEl);
        if (err.name === "AbortError") {
            contentEl.innerHTML += `<p style="color:var(--text-secondary)">⏹ Stream cancelled</p>`;
        } else {
            contentEl.innerHTML += `<p style="color:var(--error)">${escapeHtml(err.message)}</p>`;
        }
    }

    isStreaming = false;
    currentAbortController = null;
    setSendButtonState("send");
    loadSessions();
}

function setSendButtonState(state) {
    const btn = document.getElementById("send-btn");
    if (state === "stop") {
        btn.textContent = "■ 停止";
        btn.classList.add("stop-state");
        btn.onclick = stopStreaming;
        btn.disabled = false;
    } else {
        btn.textContent = "发送";
        btn.classList.remove("stop-state");
        btn.onclick = sendMessage;
        btn.disabled = false;
    }
}

function stopStreaming() {
    if (currentAbortController) {
        currentAbortController.abort();
    }
}

// ===== Image attachments =====
function showChatNotice(text) {
    const el = document.getElementById("chat-notice");
    el.textContent = text;
    setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 4000);
}

function addImageFile(file) {
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
        showChatNotice(`Unsupported image type: ${file.type || "unknown"}`);
        return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
        showChatNotice(`Image too large (max ${Math.round(MAX_IMAGE_BYTES / 1_000_000)}MB): ${file.name}`);
        return;
    }
    if (pendingImages.length >= MAX_IMAGES_PER_MESSAGE) {
        showChatNotice(`Max ${MAX_IMAGES_PER_MESSAGE} images per message`);
        return;
    }
    const reader = new FileReader();
    reader.onload = () => {
        const dataUrl = reader.result;
        const base64Data = dataUrl.slice(dataUrl.indexOf(",") + 1);
        pendingImages.push({ mediaType: file.type, data: base64Data, previewUrl: dataUrl });
        renderImagePreviews();
    };
    reader.readAsDataURL(file);
}

function renderImagePreviews() {
    const strip = document.getElementById("image-preview-strip");
    strip.innerHTML = pendingImages.map((img, i) => `
        <div class="image-preview-item">
            <img src="${img.previewUrl}" alt="pending image">
            <button class="remove-btn" onclick="removePendingImage(${i})" title="Remove">×</button>
        </div>
    `).join("");
}

function removePendingImage(index) {
    pendingImages.splice(index, 1);
    renderImagePreviews();
}

function clearPendingImages() {
    pendingImages = [];
    renderImagePreviews();
}

function handleImageFilesSelected(fileList) {
    Array.from(fileList).forEach(addImageFile);
    document.getElementById("image-file-input").value = "";
}

function handlePaste(event) {
    const items = event.clipboardData && event.clipboardData.items;
    if (!items) return;
    let handledImage = false;
    for (const item of items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (file) {
                addImageFile(file);
                handledImage = true;
            }
        }
    }
    if (handledImage) event.preventDefault();
}

// ===== DOM Helpers =====
// Only valid base64 characters — guarantees nothing here can break out of
// the src="..." attribute (quotes/angle-brackets aren't valid base64), and
// rejects malformed data instead of silently interpolating it.
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function renderUserContent(content) {
    if (typeof content === "string") return renderMarkdown(content);
    if (Array.isArray(content)) {
        return content.map(block => {
            if (block.type === "image" && block.source && block.source.data) {
                const mediaType = escapeHtml(block.source.media_type || "image/png");
                const data = block.source.data;
                if (typeof data !== "string" || !BASE64_RE.test(data)) {
                    return `<div class="msg-image-error">[图片数据无效，无法显示]</div>`;
                }
                return `<img class="msg-image" src="data:${mediaType};base64,${data}" alt="attached image">`;
            }
            if (block.type === "text") return renderMarkdown(block.text || "");
            return "";
        }).join("");
    }
    return renderMarkdown(JSON.stringify(content));
}

function appendUserMessage(content) {
    const messagesDiv = document.getElementById("messages");
    const div = document.createElement("div");
    div.className = "message user";
    div.innerHTML = `
        <div class="message-header">You</div>
        <div class="message-content">${renderUserContent(content)}</div>
    `;
    messagesDiv.appendChild(div);
    scrollToBottom();
    return div;
}

// A message sent into a resolved session (issue already submitted) silently
// lands in a brand-new session server-side (see chat_event_stream in
// main.py) — the thread otherwise looks unbroken, so the user has no way to
// tell their follow-up didn't attach to the session/issue they were just
// looking at. This makes that jump visible right in the transcript.
const SESSION_SWITCH_MESSAGES = {
    resolved: (id) => `↳ 原会话（${id}）已提交 issue 并结束，从这条消息开始已自动切换到新会话`,
    not_found: (id) => `↳ 原会话（${id}）已不存在（可能已被删除），从这条消息开始已自动切换到新会话`,
};

function insertSessionSwitchNotice(beforeEl, oldSessionId, reason) {
    const messagesDiv = document.getElementById("messages");
    if (!beforeEl || !messagesDiv.contains(beforeEl)) return;
    const buildText = SESSION_SWITCH_MESSAGES[reason];
    if (!buildText) return;
    const notice = document.createElement("div");
    notice.className = "session-switch-notice";
    notice.textContent = buildText(oldSessionId);
    messagesDiv.insertBefore(notice, beforeEl);
}

function appendAssistantBubble() {
    const messagesDiv = document.getElementById("messages");
    const div = document.createElement("div");
    div.className = "message assistant";

    const header = document.createElement("div");
    header.className = "message-header";
    header.innerHTML = "Agent";

    const contentEl = document.createElement("div");
    contentEl.className = "message-content";
    contentEl.innerHTML = `<div class="typing-indicator"><span></span><span></span><span></span></div>`;

    div.appendChild(header);
    div.appendChild(contentEl);
    messagesDiv.appendChild(div);
    scrollToBottom();

    return { bubble: div, contentEl };
}

function showThinking(container) {
    if (container.querySelector(".typing-indicator")) return; // already showing
    const indicator = document.createElement("div");
    indicator.className = "typing-indicator";
    indicator.innerHTML = "<span></span><span></span><span></span>";
    container.appendChild(indicator);
}

function hideThinking(container) {
    const typing = container.querySelector(".typing-indicator");
    if (typing) typing.remove();
}

function appendAssistantMessage(content, toolResults = {}, submissionsById = {}, submissionsByTitle = {}, actionsById = {}, messageId = null, myRating = null) {
    const messagesDiv = document.getElementById("messages");
    const div = document.createElement("div");
    div.className = "message assistant";

    const contentEl = document.createElement("div");
    contentEl.className = "message-content";

    if (typeof content === "string") {
        contentEl.innerHTML = renderMarkdown(content);
    } else if (Array.isArray(content)) {
        content.forEach(block => {
            if (block.type === "text") {
                // A dedicated child per text run, never `contentEl.innerHTML +=`:
                // that reflows the whole subtree, and appendToolBlock's
                // toolHeader.onclick (a JS property, set below) doesn't survive
                // being serialized to a string and reparsed — same reasoning as
                // the live-streaming path's textRuns (see that code's comment).
                const textEl = document.createElement("div");
                textEl.innerHTML = renderMarkdown(block.text || "");
                contentEl.appendChild(textEl);
            } else if (block.type === "tool_use") {
                const result = toolResults[block.id];
                appendToolBlock(contentEl, block.name, block.input, result !== undefined ? result : "completed");
                if (block.name === "draft_issue" && result !== undefined) {
                    try {
                        const draft = JSON.parse(result);
                        if (draft.type === "issue_draft") {
                            const submission = submissionsById[block.id] || submissionsByTitle[draft.title] || null;
                            appendIssueCard(contentEl, draft, submission, block.id);
                        }
                    } catch {}
                } else if (block.name === "manage_issue" && result !== undefined) {
                    try {
                        const draft = JSON.parse(result);
                        if (draft.type === "issue_action_draft") {
                            appendIssueActionCard(contentEl, draft, actionsById[block.id] || null, block.id);
                        }
                    } catch {}
                }
            }
        });
    }

    div.innerHTML = `<div class="message-header">Agent</div>`;
    div.appendChild(contentEl);
    messagesDiv.appendChild(div);
    highlightCode(contentEl);
    linkifyCodeRefs(contentEl);
    // Final answers are persisted as plain strings; tool exchanges as arrays.
    // Feedback attaches to answers only.
    if (typeof content === "string" && messageId) {
        appendFeedbackBar(div, messageId, myRating);
    }
    scrollToBottom();
}

function createToolGroup(container) {
    const group = document.createElement("div");
    group.className = "tool-group";
    group.innerHTML = `
        <div class="tool-group-header" onclick="this.parentElement.classList.toggle('open')">
            <span class="tool-group-chevron">▸</span>
            <span class="tool-group-summary"></span>
            <span class="tool-group-status">running</span>
        </div>
        <div class="tool-group-body"></div>
    `;
    container.appendChild(group);
    return {
        el: group,
        bodyEl: group.querySelector(".tool-group-body"),
        summaryEl: group.querySelector(".tool-group-summary"),
        statusEl: group.querySelector(".tool-group-status"),
        counts: {},
        total: 0,
        done: 0,
    };
}

function updateToolGroupSummary(g) {
    const parts = Object.entries(g.counts).map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
    g.summaryEl.textContent = parts.join(", ");
    if (g.done >= g.total) {
        g.statusEl.textContent = "done";
        g.el.classList.add("tool-group--ok");
    } else {
        g.statusEl.textContent = `${g.done}/${g.total}`;
    }
}

function appendToolBlock(container, name, input, result) {
    // Remove typing indicator if present
    const typing = container.querySelector(".typing-indicator");
    if (typing) typing.remove();

    const block = document.createElement("div");
    block.className = "tool-block" + (result !== null ? " tool-block--ok" : "");
    block.dataset.toolName = name;

    const toolHeader = document.createElement("div");
    toolHeader.className = "tool-header";
    toolHeader.onclick = () => toolBody.classList.toggle("open");
    toolHeader.innerHTML = `
        <span class="tool-name">${escapeHtml(name)}</span>
        <span class="tool-status">${result !== null ? "done" : "running"}</span>
    `;

    const toolBody = document.createElement("div");
    toolBody.className = "tool-body";
    toolBody.innerHTML = `
        <div class="tool-input">
            <div class="tool-label">Input</div>
            <div class="tool-value">${escapeHtml(JSON.stringify(input, null, 2))}</div>
        </div>
        <div class="tool-output">
            <div class="tool-label">Output</div>
            <div class="tool-value tool-result-text">${result !== null ? escapeHtml(truncate(result, 1000)) : "Running..."}</div>
        </div>
    `;

    block.appendChild(toolHeader);
    block.appendChild(toolBody);
    container.appendChild(block);
}

function updateToolResult(container, name, result) {
    // Find the LAST tool block with matching name that still shows "Running..."
    const blocks = container.querySelectorAll(".tool-block");
    for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i];
        if (block.dataset.toolName === name) {
            const resultText = block.querySelector(".tool-result-text");
            if (resultText && resultText.textContent === "Running...") {
                resultText.textContent = truncate(result, 1000);
                block.classList.add("tool-block--ok");
                const status = block.querySelector(".tool-status");
                if (status) status.textContent = "done";
                return;
            }
        }
    }
}

// ===== Utilities =====

// Configure marked for GFM
if (typeof marked !== "undefined") {
    marked.setOptions({
        breaks: true,
        gfm: true,
    });
}

function renderMarkdown(text) {
    if (typeof marked !== "undefined" && typeof DOMPurify !== "undefined") {
        return DOMPurify.sanitize(marked.parse(text));
    }
    // No regex can reliably strip HTML tags (an unterminated `<img src=x
    // onerror=...` has no closing `>` for a tag-stripping regex to match,
    // but the browser's parser still instantiates it as a live element) —
    // if DOMPurify didn't load, fall back to the same plain-text escape
    // used when marked itself isn't loaded, rather than rendering
    // unsanitized HTML from marked.
    return escapeHtml(text).replace(/\n/g, "<br>");
}

// Syntax-highlight all code fences inside a rendered container. Runs AFTER
// DOMPurify sanitization (hljs only adds <span class="hljs-*"> wrappers), and
// only on final rendered markdown — never on streaming plain-text runs.
function highlightCode(container) {
    if (typeof hljs === "undefined" || !container) return;
    container.querySelectorAll("pre code:not(.hljs)").forEach(el => {
        try { hljs.highlightElement(el); } catch {}
    });
}

function truncate(str, maxLen) {
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen) + `\n... (truncated, ${str.length} chars total)`;
}

function scrollToBottom() {
    const messagesDiv = document.getElementById("messages");
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// ===== Shared by both issue-card types (draft + action) =====

// The repo a card targets, pinned at DRAFT time (stamped by draft_issue /
// manage_issue) so a later sidebar selection change can't redirect the
// submission. Legacy drafts without a stamp fall back to the outcome
// record's repo_id, and finally to whatever repo is selected at submit time.
function resolveIssueCardRepo(card, draft, outcome) {
    const repoId = draft.repo_id || (outcome && outcome.repo_id) || null;
    let repoName = draft.repo_name || null;
    if (!repoName && repoId) {
        repoName = (reposCache.find(r => r.id === repoId) || {}).name || `#${repoId}`;
    }
    if (repoId) card.dataset.repoId = repoId;
    return { repoId, repoName };
}

function renderIssueStatusLink(statusEl, label, url, number, color = "var(--success)") {
    statusEl.textContent = `${label} `;
    const link = document.createElement("a");
    link.href = url || "#";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = `#${number}`;
    statusEl.appendChild(link);
    statusEl.style.color = color;
}

function cancelIssueCard(btn) {
    const card = btn.closest(".issue-card");
    card.querySelector(".issue-status").textContent = "已取消";
    btn.disabled = true;
    btn.previousElementSibling.disabled = true;
}

// Shared submit flow for both confirmation-card types: disable buttons, POST
// to `endpoint`, render the resulting link or an error, and (on success)
// reflect that the session got closed out server-side. `buildBody(repoId)`
// returns the request payload; `successLabel` is the Chinese verb shown next
// to the resulting issue link ("已提交" / "已处理").
async function submitIssueCardRequest(card, endpoint, buildBody, successLabel) {
    const statusEl = card.querySelector(".issue-status");
    const confirmBtn = card.querySelector(".btn-confirm");
    const cancelBtn = card.querySelector(".btn-cancel");

    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    statusEl.textContent = "提交中...";

    const targetRepoId = parseInt(card.dataset.repoId) || selectedRepoId;
    if (!targetRepoId) {
        statusEl.textContent = "请先在左侧选择一个仓库";
        statusEl.style.color = "var(--error)";
        confirmBtn.disabled = false;
        cancelBtn.disabled = false;
        return;
    }

    try {
        const resp = await authFetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(buildBody(targetRepoId)),
        });

        const result = await resp.json();
        if (!resp.ok) {
            statusEl.textContent = result.detail || "提交失败";
            statusEl.style.color = "var(--error)";
            confirmBtn.disabled = false;
            cancelBtn.disabled = false;
            return;
        }

        renderIssueStatusLink(statusEl, successLabel, result.issue_url, result.issue_number);

        // Submitting closes out this thread's task server-side (resolved_at) —
        // reflect that here so the user isn't surprised when their next
        // message lands in a brand new session.
        appendResolvedNotice();
        loadSessions();
    } catch (err) {
        statusEl.textContent = `网络错误: ${escapeHtml(err.message)}`;
        statusEl.style.color = "var(--error)";
        confirmBtn.disabled = false;
        cancelBtn.disabled = false;
    }
}

function appendResolvedNotice() {
    const messagesDiv = document.getElementById("messages");
    const div = document.createElement("div");
    div.className = "session-resolved-notice";
    div.textContent = "✅ 本次任务已完结 — 发送新消息将开始一个新会话";
    messagesDiv.appendChild(div);
    scrollToBottom();
}

// The turn ran out of tool-call budget and wrapped up with a checkpoint
// report instead of a finished answer. Not an error state — the report above
// is real work. One click authorizes another budget window, carrying that
// report forward (the model is told not to redo what's already done).
const CONTINUE_INVESTIGATION_PROMPT =
    "继续调查。基于上面的阶段性结论，优先补齐尚缺的证据，不要重复已经完成的检查。";

function appendBudgetExhaustedNotice() {
    const messagesDiv = document.getElementById("messages");
    const div = document.createElement("div");
    div.className = "budget-exhausted-notice";

    const text = document.createElement("span");
    text.textContent = "本轮调查预算已用尽，上面是阶段性结论。";
    div.appendChild(text);

    const btn = document.createElement("button");
    btn.textContent = "继续调查";
    btn.onclick = () => {
        if (isStreaming) return;
        btn.disabled = true;
        const input = document.getElementById("message-input");
        input.value = CONTINUE_INVESTIGATION_PROMPT;
        sendMessage();
    };
    div.appendChild(btn);

    messagesDiv.appendChild(div);
    scrollToBottom();
}

// ===== Issue Draft Card (draft_issue — files a NEW issue) =====
function appendIssueCard(container, draft, submission = null, toolUseId = null) {
    const card = document.createElement("div");
    card.className = "issue-card";
    if (toolUseId) card.dataset.toolUseId = toolUseId;

    const { repoId, repoName } = resolveIssueCardRepo(card, draft, submission);

    const labelsHtml = (draft.labels || [])
        .map(l => `<span class="issue-label">${escapeHtml(l)}</span>`)
        .join(" ");

    // Older drafts persisted before this field existed have none — skip the
    // block entirely rather than show it empty.
    const expectedHtml = draft.expected_behavior
        ? `<div class="issue-expected"><div class="issue-expected-label">期望行为</div>${renderMarkdown(draft.expected_behavior)}</div>`
        : "";

    card.innerHTML = `
        <div class="issue-header">
            <span class="issue-title">${escapeHtml(draft.title)}</span>
            <span class="issue-repo" title="提交目标仓库">${repoName ? "→ " + escapeHtml(repoName) : "→ 提交时选择的仓库"}</span>
        </div>
        ${expectedHtml}
        <div class="issue-body">${renderMarkdown(draft.body)}</div>
        <div class="issue-labels">${labelsHtml}</div>
        <div class="issue-actions">
            <button class="btn-confirm" onclick="submitIssue(this)" ${submission ? "disabled" : ""}>确认提交</button>
            <button class="btn-cancel" onclick="cancelIssueCard(this)" ${submission ? "disabled" : ""}>取消</button>
            <span class="issue-status"></span>
        </div>
    `;

    // Store draft data on the card element
    card.dataset.draft = JSON.stringify(draft);
    container.appendChild(card);
    highlightCode(card);
    linkifyCodeRefs(card.querySelector(".issue-body"));

    // Duplicate lookup — best-effort, card works fine without it. Only when
    // the draft is stamped with its repo: falling back to the sidebar
    // selection could query a DIFFERENT project's tracker and show duplicate
    // warnings that are about the wrong repo entirely. (New drafts are always
    // stamped — draft_issue refuses to produce unstamped ones.)
    if (!submission && repoId) checkIssueDuplicates(card, repoId, draft.title);

    // Reconciled against the real outcome (issue_submissions) — reflect the
    // actual filed issue instead of showing an active, re-clickable draft.
    // The label carries the LIVE tracking status (kept fresh by the admin
    // poller), so a replayed session shows "上次报的那个修好了" in place.
    if (submission) {
        const st = MI_STATUS[submission.track_status];
        const label = st && submission.track_status !== "submitted" ? `已提交 · ${st.label}` : "已提交";
        // A reopened/regressed issue must not read as a green "success" —
        // pass the tracking-status color through instead of the default.
        const color = st && submission.track_status !== "submitted" ? st.color : undefined;
        renderIssueStatusLink(card.querySelector(".issue-status"), label, submission.issue_url, submission.issue_number,
                              color || "var(--success)");
    }

    scrollToBottom();
}

async function submitIssue(btn) {
    const card = btn.closest(".issue-card");
    const draft = JSON.parse(card.dataset.draft);
    await submitIssueCardRequest(card, "/api/issues/submit", (targetRepoId) => ({
        repo_id: targetRepoId,
        title: draft.title,
        expected_behavior: draft.expected_behavior || "",
        body: draft.body,
        labels: draft.labels || [],
        session_id: currentSessionId,
        draft_tool_use_id: card.dataset.toolUseId || null,
    }), "已提交");
}

// ===== Issue Action Card (manage_issue — comment/close/reopen an EXISTING issue) =====
const ISSUE_ACTION_LABELS = { comment: "追加评论", close: "关闭 issue", reopen: "重新打开 issue" };

function appendIssueActionCard(container, draft, action = null, toolUseId = null) {
    const card = document.createElement("div");
    card.className = "issue-card issue-action-card";
    if (toolUseId) card.dataset.toolUseId = toolUseId;

    const { repoName } = resolveIssueCardRepo(card, draft, action);
    const actionLabel = ISSUE_ACTION_LABELS[draft.action] || draft.action;

    card.innerHTML = `
        <div class="issue-header">
            <span class="issue-title">${actionLabel} · #${escapeHtml(String(draft.issue_number))}</span>
            <span class="issue-repo" title="目标仓库">${repoName ? "→ " + escapeHtml(repoName) : "→ 提交时选择的仓库"}</span>
        </div>
        <div class="issue-body">${renderMarkdown(draft.comment)}</div>
        <div class="issue-actions">
            <button class="btn-confirm" onclick="submitIssueAction(this)" ${action ? "disabled" : ""}>确认${escapeHtml(actionLabel)}</button>
            <button class="btn-cancel" onclick="cancelIssueCard(this)" ${action ? "disabled" : ""}>取消</button>
            <span class="issue-status"></span>
        </div>
    `;

    card.dataset.draft = JSON.stringify(draft);
    container.appendChild(card);
    highlightCode(card);
    linkifyCodeRefs(card.querySelector(".issue-body"));

    // Reconciled against the real outcome (issue_actions) on replay.
    if (action) {
        renderIssueStatusLink(card.querySelector(".issue-status"), "已处理", action.issue_url, action.issue_number);
    }

    scrollToBottom();
}

async function submitIssueAction(btn) {
    const card = btn.closest(".issue-card");
    const draft = JSON.parse(card.dataset.draft);
    await submitIssueCardRequest(card, "/api/issues/action", (targetRepoId) => ({
        repo_id: targetRepoId,
        issue_number: draft.issue_number,
        action: draft.action,
        comment: draft.comment,
        session_id: currentSessionId,
        draft_tool_use_id: card.dataset.toolUseId || null,
    }), "已处理");
}

// ===== Issue duplicate lookup =====
async function checkIssueDuplicates(card, repoId, title) {
    if (!repoId || !title) return;
    try {
        const resp = await authFetch("/api/issues/check-duplicates", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ repo_id: repoId, title }),
        });
        if (!resp.ok) return;
        const { issues } = await resp.json();

        const box = document.createElement("div");
        box.className = "issue-dupes";
        const head = document.createElement("div");
        head.className = "issue-dupes-head";

        // FLOW-004 (QA follow-up): a zero-result check used to render
        // nothing at all, leaving no way to tell "checked, found none"
        // apart from "never ran" — make the checked-and-clear case explicit.
        if (!issues || !issues.length) {
            head.classList.add("none");
            head.textContent = "未发现相似 issue";
            box.appendChild(head);
            card.insertBefore(box, card.querySelector(".issue-actions"));
            return;
        }

        head.textContent = `发现 ${issues.length} 个相似 issue，提交前请确认不是重复：`;
        box.appendChild(head);
        issues.slice(0, 5).forEach(i => {
            const row = document.createElement("a");
            row.className = "issue-dupe";
            row.href = i.url;
            row.target = "_blank";
            row.rel = "noopener noreferrer";
            row.textContent = `#${i.number} ${i.title}`;
            const state = document.createElement("span");
            state.className = "issue-dupe-state" + (i.state === "closed" ? " closed" : "");
            state.textContent = i.state === "closed" ? "已关闭" : "开放中";
            row.appendChild(state);
            box.appendChild(row);
        });
        card.insertBefore(box, card.querySelector(".issue-actions"));
    } catch {}
}

// ===== Clickable code references =====
// Matches inline-code refs the agent cites, e.g. `wms/scan/ScanService.java:88-92`
// or `src/api/order.vue` — needs at least one "/" so bare identifiers stay plain.
const CODE_REF_RE = /^((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z]{1,10})(?::(\d+)(?:-(\d+))?)?$/;

function linkifyCodeRefs(container) {
    if (!container) return;
    container.querySelectorAll("code").forEach(el => {
        if (el.closest("pre") || el.classList.contains("code-ref")) return;
        const m = el.textContent.trim().match(CODE_REF_RE);
        if (!m) return;
        el.classList.add("code-ref");
        el.title = "点击查看源码";
        el.addEventListener("click", () => {
            openCodeViewer(m[1], m[2] ? parseInt(m[2]) : null, m[3] ? parseInt(m[3]) : null);
        });
    });
}

// ===== Code viewer panel =====
const CV_LINE_HEIGHT = 20;

function closeCodeViewer() {
    document.getElementById("code-viewer").hidden = true;
}

async function openCodeViewer(path, startLine = null, endLine = null) {
    const panel = document.getElementById("code-viewer");
    const titleEl = panel.querySelector(".cv-title");
    const gutterEl = panel.querySelector(".cv-gutter");
    const codeEl = panel.querySelector(".cv-pre code");
    const hlEl = panel.querySelector(".cv-hl");
    const scrollEl = panel.querySelector(".cv-scroll");

    panel.hidden = false;
    titleEl.textContent = path;
    gutterEl.innerHTML = "";
    hlEl.style.display = "none";
    codeEl.textContent = "加载中…";
    codeEl.className = "";

    let data;
    try {
        const resp = await authFetch(`/api/code/file?path=${encodeURIComponent(path)}`);
        if (!resp.ok) {
            const err = await resp.json().catch(() => ({}));
            codeEl.textContent = err.detail || `无法读取文件（${resp.status}）`;
            return;
        }
        data = await resp.json();
    } catch (e) {
        codeEl.textContent = `网络错误：${e.message}`;
        return;
    }

    titleEl.textContent = `${data.repo} · ${data.path}`;
    const lineCount = data.content.split("\n").length;
    gutterEl.textContent = Array.from({ length: lineCount }, (_, i) => i + 1).join("\n");
    codeEl.textContent = data.content + (data.truncated ? "\n… (文件过长，已截断)" : "");
    if (typeof hljs !== "undefined") {
        try { hljs.highlightElement(codeEl); } catch {}
    }

    if (startLine) {
        const end = endLine || startLine;
        hlEl.style.display = "block";
        hlEl.style.top = (startLine - 1) * CV_LINE_HEIGHT + "px";
        hlEl.style.height = (end - startLine + 1) * CV_LINE_HEIGHT + "px";
        scrollEl.scrollTop = Math.max(0, (startLine - 1) * CV_LINE_HEIGHT - 120);
    } else {
        scrollEl.scrollTop = 0;
    }
}

// ===== Answer feedback (👍/👎) =====
function appendFeedbackBar(messageDiv, messageId, myRating) {
    const bar = document.createElement("div");
    bar.className = "feedback-bar";
    bar.dataset.messageId = messageId;
    bar.dataset.sessionId = currentSessionId || "";

    const mk = (rating, symbol, label) => {
        const b = document.createElement("button");
        b.className = "fb-btn" + (myRating === rating ? " active" : "");
        b.innerHTML = `<span class="fb-icon">${symbol}</span>${label}`;
        b.onclick = () => rateMessage(bar, rating);
        return b;
    };
    bar.appendChild(mk(1, "▲", "有帮助"));
    bar.appendChild(mk(-1, "▼", "不准确"));
    messageDiv.appendChild(bar);
}

async function rateMessage(bar, rating) {
    const messageId = parseInt(bar.dataset.messageId);
    const sessionId = bar.dataset.sessionId || currentSessionId;
    if (!messageId || !sessionId) return;
    try {
        const resp = await authFetch("/api/feedback", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: sessionId, message_id: messageId, rating }),
        });
        if (!resp.ok) return;
        const [up, down] = bar.querySelectorAll(".fb-btn");
        up.classList.toggle("active", rating === 1);
        down.classList.toggle("active", rating === -1);
    } catch {}
}
