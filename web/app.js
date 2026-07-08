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

// ===== Init =====
document.addEventListener("DOMContentLoaded", () => {
    if (!_isAuthenticated) return; // redirect to /login is already in flight — don't fire authenticated requests

    // Show user info in sidebar
    const header = document.querySelector(".sidebar-header");
    if (_user && header) {
        const userInfo = document.createElement("div");
        userInfo.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;font-size:13px;color:var(--text-secondary)";

        const nameSpan = document.createElement("span");
        nameSpan.textContent = `👤 ${_user.username}`;

        const logoutBtn = document.createElement("button");
        logoutBtn.textContent = "退出";
        logoutBtn.style.cssText = "background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:12px;";
        logoutBtn.onclick = logout;

        userInfo.appendChild(nameSpan);
        userInfo.appendChild(logoutBtn);
        header.insertBefore(userInfo, header.querySelector("#new-chat-btn"));
    }
    loadRepos();
    loadSkills();
    loadSessions();
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
        chip.className = "skill-chip";
        chip.textContent = r.name;
        chip.title = r.url;
        chip.dataset.repoId = r.id;
        chip.onclick = () => selectRepo(chip, r.id);
        container.appendChild(chip);
    });
}

function selectRepo(chip, repoId) {
    // Toggle selection (only one repo at a time)
    document.querySelectorAll("#repos-list .skill-chip").forEach(c => c.classList.remove("active"));
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
        item.className = "session-item" + (s.id === currentSessionId ? " active" : "");

        const title = document.createElement("span");
        title.className = "session-title";
        title.textContent = s.title;

        const delBtn = document.createElement("button");
        delBtn.className = "delete-btn";
        delBtn.textContent = "×";
        delBtn.onclick = (e) => { e.stopPropagation(); deleteSession(s.id); };

        item.appendChild(title);
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

    data.messages.forEach(msg => {
        if (msg.role === "user") {
            appendUserMessage(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
        } else if (msg.role === "assistant") {
            appendAssistantMessage(msg.content);
        }
    });

    loadSessions(); // refresh active highlight
}

async function deleteSession(sessionId) {
    await authFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
    if (currentSessionId === sessionId) {
        currentSessionId = null;
        document.getElementById("messages").innerHTML = `
            <div class="welcome-message">
                <h1>👋 Hello!</h1>
                <p>Select a skill and start chatting.</p>
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
            <h1>👋 Hello!</h1>
            <p>Select a skill and start chatting.</p>
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

async function sendMessage() {
    const input = document.getElementById("message-input");
    const text = input.value.trim();
    if (!text || isStreaming) return;

    // Validate message size
    if (text.length > 10000) {
        alert("Message too long (max 10,000 characters)");
        return;
    }

    // Clear welcome
    const messagesDiv = document.getElementById("messages");
    const welcome = messagesDiv.querySelector(".welcome-message");
    if (welcome) welcome.remove();

    // Show user message
    appendUserMessage(text);
    input.value = "";
    input.style.height = "auto";

    // Send
    isStreaming = true;
    currentAbortController = new AbortController();
    document.getElementById("send-btn").disabled = true;

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

                    if (eventType === "text") {
                        fullText += data.text;
                        // During streaming: show plain text (avoids broken partial markdown)
                        contentEl.innerHTML = escapeHtml(fullText).replace(/\n/g, "<br>");
                        scrollToBottom();
                    } else if (eventType === "tool_use") {
                        appendToolBlock(contentEl, data.name, data.input, null);
                        scrollToBottom();
                    } else if (eventType === "tool_result") {
                        updateToolResult(contentEl, data.name, data.result);
                        // Detect issue draft and render confirmation card
                        if (data.name === "draft_issue") {
                            try {
                                const draft = JSON.parse(data.result);
                                if (draft.type === "issue_draft") {
                                    appendIssueCard(contentEl, draft);
                                }
                            } catch {}
                        }
                        scrollToBottom();
                    } else if (eventType === "done") {
                        if (data.session_id) {
                            currentSessionId = data.session_id;
                        }
                        // Remove typing indicator
                        const typing = contentEl.querySelector(".typing-indicator");
                        if (typing) typing.remove();
                        // Now render the complete markdown properly
                        if (fullText) {
                            contentEl.innerHTML = renderMarkdown(fullText);
                        }
                    } else if (eventType === "error") {
                        contentEl.innerHTML += `<p style="color:var(--error)">⚠️ ${escapeHtml(data.message)}</p>`;
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
        if (err.name === "AbortError") {
            const typing = contentEl.querySelector(".typing-indicator");
            if (typing) typing.remove();
            contentEl.innerHTML += `<p style="color:var(--text-secondary)">⏹ Stream cancelled</p>`;
        } else {
            const typing = contentEl.querySelector(".typing-indicator");
            if (typing) typing.remove();
            contentEl.innerHTML += `<p style="color:var(--error)">⚠️ ${escapeHtml(err.message)}</p>`;
        }
    }

    isStreaming = false;
    currentAbortController = null;
    document.getElementById("send-btn").disabled = false;
    loadSessions();
}

// ===== DOM Helpers =====
function appendUserMessage(text) {
    const messagesDiv = document.getElementById("messages");
    const div = document.createElement("div");
    div.className = "message user";
    div.innerHTML = `
        <div class="message-header">🧑 You</div>
        <div class="message-content">${renderMarkdown(text)}</div>
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
    header.innerHTML = "🤖 Agent";

    const contentEl = document.createElement("div");
    contentEl.className = "message-content";
    contentEl.innerHTML = `<div class="typing-indicator"><span></span><span></span><span></span></div>`;

    div.appendChild(header);
    div.appendChild(contentEl);
    messagesDiv.appendChild(div);
    scrollToBottom();

    return { bubble: div, contentEl };
}

function appendAssistantMessage(content) {
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
                appendToolBlock(contentEl, block.name, block.input, "completed");
            }
        });
    }

    div.innerHTML = `<div class="message-header">🤖 Agent</div>`;
    div.appendChild(contentEl);
    messagesDiv.appendChild(div);
    scrollToBottom();
}

function appendToolBlock(container, name, input, result) {
    // Remove typing indicator if present
    const typing = container.querySelector(".typing-indicator");
    if (typing) typing.remove();

    const block = document.createElement("div");
    block.className = "tool-block";
    block.dataset.toolName = name;

    const toolHeader = document.createElement("div");
    toolHeader.className = "tool-header";
    toolHeader.onclick = () => toolBody.classList.toggle("open");
    toolHeader.innerHTML = `
        <span class="tool-icon">⚙️</span>
        <span class="tool-name">${escapeHtml(name)}</span>
        <span class="tool-status">${result !== null ? "✅" : "⏳"}</span>
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
                const status = block.querySelector(".tool-status");
                if (status) status.textContent = "✅";
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

function truncate(str, maxLen) {
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen) + `\n... (truncated, ${str.length} chars total)`;
}

function scrollToBottom() {
    const messagesDiv = document.getElementById("messages");
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// ===== Issue Draft Card =====
function appendIssueCard(container, draft) {
    const card = document.createElement("div");
    card.className = "issue-card";

    const labelsHtml = (draft.labels || [])
        .map(l => `<span class="issue-label">${escapeHtml(l)}</span>`)
        .join(" ");

    card.innerHTML = `
        <div class="issue-header">
            <span class="issue-icon">📋</span>
            <span class="issue-title">${escapeHtml(draft.title)}</span>
        </div>
        <div class="issue-body">${renderMarkdown(draft.body)}</div>
        <div class="issue-labels">${labelsHtml}</div>
        <div class="issue-actions">
            <button class="btn-confirm" onclick="submitIssue(this)">✅ 确认提交</button>
            <button class="btn-cancel" onclick="this.parentElement.parentElement.querySelector('.issue-status').textContent='已取消'; this.disabled=true; this.previousElementSibling.disabled=true;">❌ 取消</button>
            <span class="issue-status"></span>
        </div>
    `;

    // Store draft data on the card element
    card.dataset.draft = JSON.stringify(draft);
    container.appendChild(card);
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
        statusEl.textContent = "❌ 请先选择一个仓库";
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
            }),
        });

        const result = await resp.json();
        if (!resp.ok) {
            statusEl.textContent = `❌ ${result.detail || "提交失败"}`;
            statusEl.style.color = "var(--error)";
            confirmBtn.disabled = false;
            cancelBtn.disabled = false;
            return;
        }

        // Use textContent for safety, build link element manually
        statusEl.textContent = "✅ 已提交 ";
        const link = document.createElement("a");
        link.href = result.issue_url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = `#${result.issue_number}`;
        statusEl.appendChild(link);
        statusEl.style.color = "var(--success)";
    } catch (err) {
        statusEl.textContent = `❌ 网络错误: ${escapeHtml(err.message)}`;
        statusEl.style.color = "var(--error)";
        confirmBtn.disabled = false;
        cancelBtn.disabled = false;
    }
}
