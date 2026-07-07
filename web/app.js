// ===== State =====
let currentSessionId = null;
let activeSkills = [];
let isStreaming = false;

// ===== Init =====
document.addEventListener("DOMContentLoaded", () => {
    loadSkills();
    loadSessions();
});

// ===== Skills =====
async function loadSkills() {
    const resp = await fetch("/api/skills");
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
    const resp = await fetch("/api/sessions");
    const sessions = await resp.json();
    const container = document.getElementById("sessions-list");
    container.innerHTML = "";

    sessions.forEach(s => {
        const item = document.createElement("div");
        item.className = "session-item" + (s.id === currentSessionId ? " active" : "");
        item.innerHTML = `
            <span class="session-title">${escapeHtml(s.title)}</span>
            <button class="delete-btn" onclick="event.stopPropagation(); deleteSession('${s.id}')">×</button>
        `;
        item.onclick = () => openSession(s.id);
        container.appendChild(item);
    });
}

async function openSession(sessionId) {
    currentSessionId = sessionId;
    const resp = await fetch(`/api/sessions/${sessionId}`);
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
    await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
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
    document.getElementById("send-btn").disabled = true;

    // Create assistant bubble
    const { bubble, contentEl } = appendAssistantBubble();

    try {
        const resp = await fetch("/api/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                session_id: currentSessionId,
                message: text,
                active_skills: activeSkills,
            }),
        });

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let fullText = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                if (line.startsWith("event:")) {
                    var eventType = line.slice(6).trim();
                } else if (line.startsWith("data:")) {
                    const dataStr = line.slice(5).trim();
                    if (!dataStr) continue;
                    let data;
                    try { data = JSON.parse(dataStr); } catch { continue; }

                    if (eventType === "text") {
                        fullText += data.text;
                        contentEl.innerHTML = renderMarkdown(fullText);
                        scrollToBottom();
                    } else if (eventType === "tool_use") {
                        appendToolBlock(contentEl, data.name, data.input, null);
                        scrollToBottom();
                    } else if (eventType === "tool_result") {
                        updateLastToolResult(contentEl, data.name, data.result);
                        scrollToBottom();
                    } else if (eventType === "done") {
                        if (data.session_id) {
                            currentSessionId = data.session_id;
                        }
                        // Remove typing indicator
                        const typing = contentEl.querySelector(".typing-indicator");
                        if (typing) typing.remove();
                    } else if (eventType === "error") {
                        contentEl.innerHTML += `<p style="color:var(--error)">⚠️ ${escapeHtml(data.message)}</p>`;
                    }
                }
            }
        }
    } catch (err) {
        contentEl.innerHTML += `<p style="color:var(--error)">⚠️ Connection error: ${escapeHtml(err.message)}</p>`;
    }

    isStreaming = false;
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
    block.innerHTML = `
        <div class="tool-header" onclick="this.nextElementSibling.classList.toggle('open')">
            <span class="tool-icon">⚙️</span>
            <span class="tool-name">${escapeHtml(name)}</span>
            <span class="tool-status">${result !== null ? "✅" : "⏳"}</span>
        </div>
        <div class="tool-body${result !== null ? "" : ""}">
            <div class="tool-input">
                <div class="tool-label">Input</div>
                <div class="tool-value">${escapeHtml(JSON.stringify(input, null, 2))}</div>
            </div>
            <div class="tool-output">
                <div class="tool-label">Output</div>
                <div class="tool-value tool-result-text">${result !== null ? escapeHtml(truncate(result, 1000)) : "Running..."}</div>
            </div>
        </div>
    `;
    container.appendChild(block);
}

function updateLastToolResult(container, name, result) {
    const blocks = container.querySelectorAll(".tool-block");
    const last = blocks[blocks.length - 1];
    if (!last) return;

    // Update status icon
    const status = last.querySelector(".tool-status");
    if (status) status.textContent = "✅";

    // Update result text
    const resultEl = last.querySelector(".tool-result-text");
    if (resultEl) resultEl.textContent = truncate(result, 1000);
}

// ===== Utilities =====
function renderMarkdown(text) {
    if (typeof marked !== "undefined") {
        return marked.parse(text);
    }
    return escapeHtml(text).replace(/\n/g, "<br>");
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

function truncate(str, maxLen) {
    if (str.length <= maxLen) return str;
    return str.slice(0, maxLen) + `\n... (truncated, ${str.length} chars total)`;
}

function scrollToBottom() {
    const messagesDiv = document.getElementById("messages");
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}
