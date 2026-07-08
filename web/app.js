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

        const logoutBtn = document.createElement("button");
        logoutBtn.textContent = "退出";
        logoutBtn.style.cssText = "background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:12px;";
        logoutBtn.onclick = logout;

        userInfo.appendChild(nameSpan);
        userInfo.appendChild(logoutBtn);
        header.insertBefore(userInfo, header.querySelector("#new-chat-btn"));
    }
    loadConfig();
    loadRepos();
    loadSkills();
    loadSessions();

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

// ===== Escape key to cancel stream =====
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isStreaming && currentAbortController) {
        currentAbortController.abort();
    }
    // Close sidebar on Escape (mobile)
    if (e.key === "Escape") {
        closeSidebar();
    }
});

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
async function loadRepos() {
    const resp = await authFetch("/api/repos");
    const repos = await resp.json();
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
async function loadSessions() {
    const resp = await authFetch("/api/sessions");
    const sessions = await resp.json();
    const container = document.getElementById("sessions-list");
    container.innerHTML = "";

    sessions.forEach(s => {
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

    data.messages.forEach(msg => {
        if (msg.role === "user") {
            // Pure tool-result relay messages have no standalone bubble —
            // they're shown via the paired tool_use block above.
            if (Array.isArray(msg.content) && msg.content.length && msg.content.every(b => b.type === "tool_result")) return;
            appendUserMessage(msg.content);
        } else if (msg.role === "assistant") {
            appendAssistantMessage(msg.content, toolResults, submissionsById, submissionsByTitle);
        }
    });

    if (data.session && data.session.resolved_at) appendResolvedNotice();

    loadSessions(); // refresh active highlight
}

async function deleteSession(sessionId) {
    await authFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
    if (currentSessionId === sessionId) {
        currentSessionId = null;
        document.getElementById("messages").innerHTML = `
            <div class="welcome-message">
                <h1>Where should we start?</h1>
                <p>Choose a repo and a skill on the left, or just start typing.</p>
            </div>
        `;
    }
    loadSessions();
}

function newChat() {
    if (currentAbortController) {
        currentAbortController.abort();
    }
    closeSidebar(); // close mobile sidebar
    currentSessionId = null;
    document.getElementById("messages").innerHTML = `
        <div class="welcome-message">
            <h1>Where should we start?</h1>
            <p>Choose a repo and a skill on the left, or just start typing.</p>
        </div>
    `;
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
    appendUserMessage(userContent);
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

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                if (line.startsWith("event:")) {
                    eventType = line.slice(6).trim();
                } else if (line.startsWith("data:")) {
                    const dataStr = line.slice(5).trim();
                    if (!dataStr) {
                        eventType = "message"; // reset on empty data
                        continue;
                    }
                    let data;
                    try { data = JSON.parse(dataStr); } catch { continue; }

                    if (eventType === "session") {
                        // Fires once, right at the start of the turn — learn the
                        // real session_id well before "done", so an issue-draft
                        // card rendered mid-turn can be submitted against the
                        // right session even if the user confirms immediately.
                        if (data.session_id) currentSessionId = data.session_id;
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
            }
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
        btn.textContent = "■ Stop";
        btn.classList.add("stop-state");
        btn.onclick = stopStreaming;
        btn.disabled = false;
    } else {
        btn.textContent = "Send";
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

function appendAssistantMessage(content, toolResults = {}, submissionsById = {}, submissionsByTitle = {}) {
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
                contentEl.innerHTML += renderMarkdown(block.text || "");
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
                }
            }
        });
    }

    div.innerHTML = `<div class="message-header">Agent</div>`;
    div.appendChild(contentEl);
    messagesDiv.appendChild(div);
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
    if (typeof marked !== "undefined") {
        const rawHtml = marked.parse(text);
        if (typeof DOMPurify !== "undefined") {
            return DOMPurify.sanitize(rawHtml);
        }
        return rawHtml.replace(/<[^>]*>/g, "");
    }
    return escapeHtml(text).replace(/\n/g, "<br>");
}

function truncate(str, maxLen) {
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen) + `\n... (truncated, ${str.length} chars total)`;
}

function scrollToBottom() {
    const messagesDiv = document.getElementById("messages");
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// ===== Issue Draft Card =====
function appendIssueCard(container, draft, submission = null, toolUseId = null) {
    const card = document.createElement("div");
    card.className = "issue-card";
    if (toolUseId) card.dataset.toolUseId = toolUseId;

    const labelsHtml = (draft.labels || [])
        .map(l => `<span class="issue-label">${escapeHtml(l)}</span>`)
        .join(" ");

    card.innerHTML = `
        <div class="issue-header">
            <span class="issue-title">${escapeHtml(draft.title)}</span>
        </div>
        <div class="issue-body">${renderMarkdown(draft.body)}</div>
        <div class="issue-labels">${labelsHtml}</div>
        <div class="issue-actions">
            <button class="btn-confirm" onclick="submitIssue(this)" ${submission ? "disabled" : ""}>确认提交</button>
            <button class="btn-cancel" onclick="this.parentElement.parentElement.querySelector('.issue-status').textContent='已取消'; this.disabled=true; this.previousElementSibling.disabled=true;" ${submission ? "disabled" : ""}>取消</button>
            <span class="issue-status"></span>
        </div>
    `;

    // Store draft data on the card element
    card.dataset.draft = JSON.stringify(draft);
    container.appendChild(card);

    // Reconciled against the real outcome (issue_submissions) — reflect the
    // actual filed issue instead of showing an active, re-clickable draft.
    if (submission) {
        const statusEl = card.querySelector(".issue-status");
        statusEl.textContent = "已提交 ";
        const link = document.createElement("a");
        link.href = submission.issue_url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = `#${submission.issue_number}`;
        statusEl.appendChild(link);
        statusEl.style.color = "var(--success)";
    }

    scrollToBottom();
}

function appendResolvedNotice() {
    const messagesDiv = document.getElementById("messages");
    const div = document.createElement("div");
    div.className = "session-resolved-notice";
    div.textContent = "✅ 本次任务已完结 — 发送新消息将开始一个新会话";
    messagesDiv.appendChild(div);
    scrollToBottom();
}

async function submitIssue(btn) {
    const card = btn.closest(".issue-card");
    const draft = JSON.parse(card.dataset.draft);
    const statusEl = card.querySelector(".issue-status");
    const confirmBtn = card.querySelector(".btn-confirm");
    const cancelBtn = card.querySelector(".btn-cancel");

    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    statusEl.textContent = "提交中...";

    if (!selectedRepoId) {
        statusEl.textContent = "请先选择一个仓库";
        statusEl.style.color = "var(--error)";
        confirmBtn.disabled = false;
        cancelBtn.disabled = false;
        return;
    }

    try {
        const resp = await authFetch("/api/issues/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                repo_id: selectedRepoId,
                title: draft.title,
                body: draft.body,
                labels: draft.labels || [],
                session_id: currentSessionId,
                draft_tool_use_id: card.dataset.toolUseId || null,
            }),
        });

        const result = await resp.json();
        if (!resp.ok) {
            statusEl.textContent = result.detail || "提交失败";
            statusEl.style.color = "var(--error)";
            confirmBtn.disabled = false;
            cancelBtn.disabled = false;
            return;
        }

        // Use textContent for safety, build link element manually
        statusEl.textContent = "已提交 ";
        const link = document.createElement("a");
        link.href = result.issue_url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = `#${result.issue_number}`;
        statusEl.appendChild(link);
        statusEl.style.color = "var(--success)";

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
