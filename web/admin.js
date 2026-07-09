// ===== Auth check =====
const token = localStorage.getItem("token");
const user = JSON.parse(localStorage.getItem("user") || "{}");
const isAuthorizedAdmin = !!token && user.role === "admin";
if (!isAuthorizedAdmin) { window.location.href = "/login"; }

document.getElementById("admin-user").textContent = user.username || "";

// escapeHtml is defined in shared.js (loaded before this file) — aliased as
// `esc` here since every call site in this file already uses that name.
const esc = escapeHtml;

function authHeaders() {
    return { "Content-Type": "application/json", "Authorization": `Bearer ${token}` };
}

// Wraps fetch + auth headers + "parse error body, tolerating a non-JSON one"
// — several admin actions used to hand-roll this, some without the try/catch
// around resp.json() (so a malformed/empty error body threw instead of
// showing a message). One wrapper, one behavior everywhere.
async function apiRequest(url, opts = {}) {
    const resp = await fetch(url, { ...opts, headers: { ...authHeaders(), ...(opts.headers || {}) } });
    let data;
    try { data = await resp.json(); } catch { data = {}; }
    return { ok: resp.ok, status: resp.status, data };
}

function showMsg(text, ok = true) {
    const area = document.getElementById("msg-area");
    area.innerHTML = `<div class="msg ${ok ? 'msg-ok' : 'msg-err'}">${esc(text)}</div>`;
    setTimeout(() => area.innerHTML = "", 3000);
}

function switchTab(name, btn) {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`panel-${name}`).classList.add("active");
}

function logout() {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    window.location.href = "/login";
}

// ===== Users =====
async function loadUsers() {
    const resp = await fetch("/api/admin/users", { headers: authHeaders() });
    const users = await resp.json();
    const tbody = document.getElementById("users-table");
    tbody.innerHTML = users.map(u => `
        <tr>
            <td>${u.id}</td>
            <td>${esc(u.username)}</td>
            <td><span class="badge ${u.role === 'admin' ? 'badge-admin' : 'badge-user'}">${esc(u.role)}</span></td>
            <td><span style="font-family:var(--font-mono);font-size:12px;color:${u.is_active ? 'var(--moss)' : 'var(--faint)'}">${u.is_active ? 'active' : 'disabled'}</span></td>
            <td>${esc(u.created_at?.slice(0, 10) || '')}</td>
            <td>
                <button class="btn btn-sm btn-primary" onclick="resetPwd(${u.id})">重置密码</button>
                ${u.role !== 'admin' ? `<button class="btn btn-sm btn-danger" onclick="toggleUser(${u.id}, ${u.is_active})">${u.is_active ? '停用' : '启用'}</button>` : ''}
            </td>
        </tr>
    `).join("");
    // Update permission dropdown
    const sel = document.getElementById("perm-user");
    sel.innerHTML = '<option value="">选择用户</option>' + users.map(u => `<option value="${u.id}">${esc(u.username)}</option>`).join("");
}

async function createUser() {
    const username = document.getElementById("new-username").value.trim();
    const password = document.getElementById("new-password").value;
    const role = document.getElementById("new-role").value;
    if (!username || !password) return showMsg("请填写用户名和密码", false);
    const { ok, data } = await apiRequest("/api/admin/users", {
        method: "POST", body: JSON.stringify({ username, password, role }),
    });
    if (!ok) return showMsg(data.detail || "创建失败", false);
    showMsg(`用户 ${username} 创建成功`);
    document.getElementById("new-username").value = "";
    document.getElementById("new-password").value = "";
    loadUsers();
}

async function resetPwd(userId) {
    const pwd = prompt("输入新密码:");
    if (!pwd) return;
    await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ password: pwd }),
    });
    showMsg("密码已重置");
}

async function toggleUser(userId, currentActive) {
    await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH", headers: authHeaders(),
        body: JSON.stringify({ is_active: !currentActive }),
    });
    showMsg(!currentActive ? "用户已启用" : "用户已停用");
    loadUsers();
}

// ===== Repos =====
let editingRepoId = null;

async function loadRepos() {
    const resp = await fetch("/api/admin/repos", { headers: authHeaders() });
    const repos = await resp.json();
    const tbody = document.getElementById("repos-table");
    tbody.innerHTML = repos.map(r => `
        <tr>
            <td>${r.id}</td>
            <td>${esc(r.name)}</td>
            <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis">${esc(r.url)}</td>
            <td>${esc(r.branch || '(default)')}</td>
            <td>${esc(r.description || '-')}</td>
            <td>${r.cred_username ? esc(r.cred_username) : '<span style="color:var(--faint)">—</span>'}${r.has_token ? ' <span class="badge badge-write">令牌</span>' : ''}</td>
            <td>
                <button class="btn btn-sm" style="background:var(--ink-800);color:var(--paper);" onclick="openRepoEdit(${r.id})">编辑</button>
                <button class="btn btn-sm btn-primary" onclick="syncRepo(${r.id}, this)">同步</button>
                <button class="btn btn-sm btn-danger" onclick="deleteRepo(${r.id})">删除</button>
            </td>
        </tr>
    `).join("");
    // Update permission dropdown
    const sel = document.getElementById("perm-repo");
    sel.innerHTML = '<option value="">选择仓库</option>' + repos.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join("");
}

async function createRepo() {
    const name = document.getElementById("new-repo-name").value.trim();
    const url = document.getElementById("new-repo-url").value.trim();
    const branch = document.getElementById("new-repo-branch").value.trim();
    const credUsername = document.getElementById("new-repo-cred-username").value.trim();
    const credToken = document.getElementById("new-repo-cred-token").value.trim();
    const desc = document.getElementById("new-repo-desc").value.trim();
    if (!name || !url) return showMsg("请填写名称和 URL", false);
    const { ok, data } = await apiRequest("/api/admin/repos", {
        method: "POST",
        body: JSON.stringify({
            name, url, branch: branch || null,
            cred_username: credUsername || null, cred_token: credToken || null,
            description: desc,
        }),
    });
    if (!ok) return showMsg(data.detail || "创建失败", false);
    showMsg(`仓库 ${name} 添加成功`);
    document.getElementById("new-repo-name").value = "";
    document.getElementById("new-repo-url").value = "";
    document.getElementById("new-repo-branch").value = "";
    document.getElementById("new-repo-cred-username").value = "";
    document.getElementById("new-repo-cred-token").value = "";
    document.getElementById("new-repo-desc").value = "";
    loadRepos();
}

async function openRepoEdit(id) {
    const resp = await fetch(`/api/admin/repos/${id}`, { headers: authHeaders() });
    if (!resp.ok) return showMsg("加载仓库信息失败", false);
    const r = await resp.json();
    editingRepoId = id;
    document.getElementById("edit-repo-name").value = r.name || "";
    document.getElementById("edit-repo-url").value = r.url || "";
    document.getElementById("edit-repo-branch").value = r.branch || "";
    // Username isn't secret, so it's prefilled; token always starts blank.
    document.getElementById("edit-repo-cred-username").value = r.cred_username || "";
    document.getElementById("edit-repo-cred-token").value = "";
    document.getElementById("edit-repo-cred-token").placeholder =
        r.has_token ? "令牌/密码（已配置，留空则不修改）" : "令牌/密码（留空则不修改）";
    document.getElementById("edit-repo-clear-credentials").checked = false;
    document.getElementById("edit-repo-desc").value = r.description || "";
    document.getElementById("edit-repo-card").style.display = "block";
}

function closeRepoEdit() {
    editingRepoId = null;
    document.getElementById("edit-repo-card").style.display = "none";
}

async function saveRepoEdit() {
    const id = editingRepoId;
    if (!id) return;
    const name = document.getElementById("edit-repo-name").value.trim();
    const url = document.getElementById("edit-repo-url").value.trim();
    const branch = document.getElementById("edit-repo-branch").value.trim();
    const credUsername = document.getElementById("edit-repo-cred-username").value.trim();
    const credToken = document.getElementById("edit-repo-cred-token").value.trim();
    const clearCredentials = document.getElementById("edit-repo-clear-credentials").checked;
    const desc = document.getElementById("edit-repo-desc").value.trim();
    if (!name || !url) return showMsg("请填写名称和 URL", false);

    // Username is always resent (it's shown in the clear, so the field always
    // reflects the value the admin wants). Token is only sent if the admin
    // typed a new one — it's never prefilled, so a blank field means "keep it".
    const body = { name, url, branch: branch || "", cred_username: credUsername, description: desc };
    if (clearCredentials) {
        body.cred_username = "";
        body.cred_token = "";
    } else if (credToken) {
        body.cred_token = credToken;
    }

    const { ok, data } = await apiRequest(`/api/admin/repos/${id}`, {
        method: "PATCH", body: JSON.stringify(body),
    });
    if (!ok) return showMsg(data.detail || "保存失败", false);
    showMsg("仓库已更新");
    closeRepoEdit();
    loadRepos();
}

async function syncRepo(id, btn) {
    btn.disabled = true;
    try {
        const { ok, data } = await apiRequest(`/api/admin/repos/${id}/sync`, { method: "POST" });
        if (!ok || !data.ok) return showMsg(data.detail || data.message || "同步失败", false);
        showMsg(`同步成功：${data.message}`);
        loadRepos();
    } catch (err) {
        showMsg(`网络错误: ${err.message}`, false);
    } finally {
        btn.disabled = false;
    }
}

async function deleteRepo(id) {
    if (!confirm("确定删除此仓库？相关权限也会被移除。")) return;
    await fetch(`/api/admin/repos/${id}`, { method: "DELETE", headers: authHeaders() });
    showMsg("仓库已删除");
    loadRepos();
    loadPerms();
}

// ===== Permissions =====
let editingPermKey = null; // `${userId}-${repoId}` of the row currently being edited
let lastPerms = [];

async function loadPerms() {
    const resp = await fetch("/api/admin/permissions", { headers: authHeaders() });
    lastPerms = await resp.json();
    renderPerms();
}

function renderPerms() {
    const tbody = document.getElementById("perms-table");
    tbody.innerHTML = lastPerms.map(p => {
        const key = `${p.user_id}-${p.repo_id}`;
        const isEditing = key === editingPermKey;
        const levelCell = isEditing ? `
            <td>
                <select id="perm-edit-level-${key}">
                    <option value="read" ${p.access_level === 'read' ? 'selected' : ''}>只读</option>
                    <option value="write" ${p.access_level === 'write' ? 'selected' : ''}>读写</option>
                    <option value="admin" ${p.access_level === 'admin' ? 'selected' : ''}>管理</option>
                </select>
            </td>` : `
            <td><span class="badge ${p.access_level === 'read' ? 'badge-read' : 'badge-write'}">${esc(p.access_level)}</span></td>`;
        const actionCell = isEditing ? `
            <td>
                <button class="btn btn-sm btn-primary" onclick="saveEditPerm(${p.user_id}, ${p.repo_id})">保存</button>
                <button class="btn btn-sm" onclick="cancelEditPerm()">取消</button>
            </td>` : `
            <td>
                <button class="btn btn-sm" style="background:var(--ink-800);color:var(--paper);" onclick="startEditPerm(${p.user_id}, ${p.repo_id})">编辑</button>
                <button class="btn btn-sm btn-danger" onclick="revokePerm(${p.user_id}, ${p.repo_id})">撤销</button>
            </td>`;
        return `
        <tr>
            <td>${esc(p.username)}</td>
            <td>${esc(p.repo_name)}</td>
            ${levelCell}
            ${actionCell}
        </tr>`;
    }).join("");
}

function startEditPerm(userId, repoId) {
    editingPermKey = `${userId}-${repoId}`;
    renderPerms();
}

function cancelEditPerm() {
    editingPermKey = null;
    renderPerms();
}

async function saveEditPerm(userId, repoId) {
    const key = `${userId}-${repoId}`;
    const level = document.getElementById(`perm-edit-level-${key}`).value;
    const { ok, data } = await apiRequest("/api/admin/permissions", {
        method: "POST", body: JSON.stringify({ user_id: userId, repo_id: repoId, access_level: level }),
    });
    if (!ok) return showMsg(data.detail || "更新失败", false);
    showMsg("权限已更新");
    editingPermKey = null;
    loadPerms();
}

async function grantPerm() {
    const userId = parseInt(document.getElementById("perm-user").value);
    const repoId = parseInt(document.getElementById("perm-repo").value);
    const level = document.getElementById("perm-level").value;
    if (!userId || !repoId) return showMsg("请选择用户和仓库", false);
    const { ok, data } = await apiRequest("/api/admin/permissions", {
        method: "POST", body: JSON.stringify({ user_id: userId, repo_id: repoId, access_level: level }),
    });
    if (!ok) return showMsg(data.detail || "授权失败", false);
    showMsg("权限已授予");
    loadPerms();
}

async function revokePerm(userId, repoId) {
    if (!confirm("确定撤销此权限？")) return;
    await fetch(`/api/admin/permissions/${userId}/${repoId}`, { method: "DELETE", headers: authHeaders() });
    showMsg("权限已撤销");
    loadPerms();
}

// ===== Usage =====
function formatNumber(n) {
    return Number(n || 0).toLocaleString("en-US");
}

function formatMs(n) {
    n = Number(n || 0);
    if (n >= 1000) return (n / 1000).toFixed(1) + "s";
    return Math.round(n) + "ms";
}

async function loadUsage() {
    const [summaryResp, byUserResp, recentResp, feedbackResp] = await Promise.all([
        fetch("/api/admin/usage/summary", { headers: authHeaders() }),
        fetch("/api/admin/usage/by-user", { headers: authHeaders() }),
        fetch("/api/admin/usage/recent?limit=50", { headers: authHeaders() }),
        fetch("/api/admin/feedback/summary", { headers: authHeaders() }),
    ]);
    const summary = await summaryResp.json();
    const byUser = await byUserResp.json();
    const recent = await recentResp.json();
    const feedback = await feedbackResp.json();

    const cards = document.getElementById("usage-summary-cards");
    cards.innerHTML = `
        <div class="stat-card">
            <div class="stat-label">总调用次数</div>
            <div class="stat-value">${formatNumber(summary.call_count)}</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">输入 Token</div>
            <div class="stat-value">${formatNumber(summary.total_input_tokens)}</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">输出 Token</div>
            <div class="stat-value">${formatNumber(summary.total_output_tokens)}</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">平均首字延迟</div>
            <div class="stat-value">${formatMs(summary.avg_ttft_ms)}</div>
            <div class="stat-sub">最大 ${formatMs(summary.max_ttft_ms)}</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">平均总耗时</div>
            <div class="stat-value">${formatMs(summary.avg_total_ms)}</div>
            <div class="stat-sub">最大 ${formatMs(summary.max_total_ms)}</div>
        </div>
    `;

    const byUserTbody = document.getElementById("usage-by-user-table");
    byUserTbody.innerHTML = byUser.map(u => `
        <tr>
            <td>${esc(u.username)}</td>
            <td>${formatNumber(u.call_count)}</td>
            <td>${formatNumber(u.total_input_tokens)}</td>
            <td>${formatNumber(u.total_output_tokens)}</td>
            <td>${formatMs(u.avg_ttft_ms)}</td>
            <td>${formatMs(u.avg_total_ms)}</td>
        </tr>
    `).join("") || `<tr><td colspan="6" style="color:var(--faint);">暂无数据</td></tr>`;

    const recentTbody = document.getElementById("usage-recent-table");
    recentTbody.innerHTML = recent.map(r => `
        <tr>
            <td>${esc((r.created_at || "").replace("T", " ").slice(0, 19))}</td>
            <td title="${esc(r.session_title || "")}">${esc(r.session_id)}</td>
            <td>${esc(r.username || "-")}</td>
            <td>${r.iteration}</td>
            <td>${formatNumber(r.input_tokens)}</td>
            <td>${formatNumber(r.output_tokens)}</td>
            <td>${r.ttft_ms != null ? formatMs(r.ttft_ms) : "-"}</td>
            <td>${formatMs(r.total_ms)}</td>
        </tr>
    `).join("") || `<tr><td colspan="8" style="color:var(--faint);">暂无数据</td></tr>`;

    const up = Number(feedback.up_count || 0), down = Number(feedback.down_count || 0);
    const total = up + down;
    document.getElementById("feedback-summary-cards").innerHTML = `
        <div class="stat-card">
            <div class="stat-label">👍 有帮助</div>
            <div class="stat-value" style="color:var(--moss)">${formatNumber(up)}</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">👎 不准确</div>
            <div class="stat-value" style="color:var(--rust)">${formatNumber(down)}</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">好评率</div>
            <div class="stat-value">${total ? Math.round(up / total * 100) + "%" : "—"}</div>
            <div class="stat-sub">共 ${formatNumber(total)} 次评价</div>
        </div>
    `;
    document.getElementById("feedback-negative-table").innerHTML = (feedback.recent_negative || []).map(f => `
        <tr>
            <td>${esc((f.created_at || "").replace("T", " ").slice(0, 19))}</td>
            <td title="${esc(f.session_title || "")}">${esc(f.session_id)} ${esc(f.session_title || "")}</td>
            <td>${esc(f.username || "-")}</td>
        </tr>
    `).join("") || `<tr><td colspan="3" style="color:var(--faint);">暂无差评</td></tr>`;
}

// ===== Init =====
if (isAuthorizedAdmin) {
    loadUsers();
    loadRepos();
    loadPerms();
    loadUsage();
}
