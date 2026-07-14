// ===== Auth check =====
const token = localStorage.getItem("token");
const user = JSON.parse(localStorage.getItem("user") || "{}");
const isAuthorizedAdmin = !!token && user.role === "admin";
if (!isAuthorizedAdmin) { window.location.href = "/login"; }

document.getElementById("admin-user").textContent = user.username || "";
initThemeToggle(document.getElementById("admin-header-actions"));

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
                ${u.role !== 'admin' ? `<button class="btn btn-sm btn-danger" onclick="deleteUser(${u.id}, this)">删除</button>` : ''}
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
    const pwd = await promptDialog({ title: "重置密码", message: "输入新密码:", inputType: "password" });
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

// `btn` (not the username as a template-literal argument) sidesteps quoting
// a username into an inline onclick string — reading it back from the
// row's own cell is safe regardless of what characters it contains.
async function deleteUser(userId, btn) {
    const username = btn.closest("tr").querySelector("td:nth-child(2)").textContent;
    const ok = await confirmDialog({
        title: "删除用户",
        message: `确定删除用户 ${username}？此操作不可恢复：该用户的仓库权限会被一并移除，但已产生的会话/用量记录会保留。`,
        confirmLabel: "删除", danger: true,
    });
    if (!ok) return;
    const { ok: reqOk, data } = await apiRequest(`/api/admin/users/${userId}`, { method: "DELETE" });
    if (!reqOk) return showMsg(data.detail || "删除失败", false);
    showMsg("用户已删除");
    loadUsers();
    // The backend cascades the user's permission rows on delete (see
    // schema's ON DELETE CASCADE) — refresh the permissions tab's own
    // cached list too, or switching there right after shows the now-stale
    // rows until a manual reload (QA-reported: NEW-001).
    loadPerms();
}

// ===== Repos =====
let editingRepoId = null;

// Sync/index state → one compact cell. Sync failures show the git error on
// hover; index lag ("git synced but symbol index still building") gets its
// own hint since a green sync doesn't mean code search is fresh yet.
function syncStatusCell(r) {
    // 生产 QA 复测（2026-07-14）：create/manual-sync 路由改成了 fire-and-
    // forget（见 admin-routes.ts 的同一条注释）——同步进行中这一行的
    // last_sync_status 会是 "syncing"，必须在"是否有过 last_sync_at"这个
    // 判断之前先检查，否则一个从未同步过的新仓库在它自己的第一次同步过程
    // 中会先被上面那条"未同步"分支截住，界面上完全看不出后台其实正在跑。
    if (r.last_sync_status === 'syncing') {
        return '<span style="color:var(--amber)">⏳ 同步中…</span>';
    }
    if (!r.last_sync_at) return '<span style="color:var(--faint)">未同步</span>';
    const t = esc(String(r.last_sync_at).slice(5, 16).replace('T', ' '));
    const sync = r.last_sync_status === 'ok'
        ? `<span style="color:var(--moss)" title="${esc(r.last_sync_message || '')}">✓ ${t}</span>`
        : `<span style="color:var(--rust)" title="${esc(r.last_sync_message || '')}">✗ ${t}</span>`;
    const sha = r.last_sync_sha
        ? ` <code style="font-family:var(--font-mono);font-size:11.5px;color:var(--mute);background:var(--ink-850);padding:1px 5px;border-radius:4px" title="当前检出的 commit">${esc(r.last_sync_sha)}</code>`
        : '';
    const idxMap = { ready: '', building: ' <span style="color:var(--amber)" title="符号索引重建中">索引构建中</span>', failed: ' <span style="color:var(--rust)" title="ctags 索引构建失败，符号搜索可能过期">索引失败</span>' };
    return sync + sha + (idxMap[r.index_status] ?? '');
}

// 生产 QA 复测（2026-07-14）：create/manual-sync 路由不再等 clone/pull 跑完
// 才返回（见 admin-routes.ts 同一条注释——从这台生产主机连 github.com 之类
// 的路径可能明显更慢，同步 await 到 120s 超时期间界面上只有一个禁用按钮，
// 和真的卡死没法区分）。这个函数替代原来"直接读 POST 响应里的
// synced/sync_message"的做法：定期重新拉一次仓库列表，直到目标仓库的
// last_sync_status 不再是 "syncing"，再给一条最终结果的提示。maxWaitMs 留
// 了比 120s git 超时更宽的余量（后面可能还有 embedding 索引构建），到点了
// 还没完成也不当错误处理——只是提示"仍在进行"，不是失败。
async function pollRepoSyncStatus(repoId, maxWaitMs = 150000, intervalMs = 2000) {
    const start = Date.now();
    for (;;) {
        let r;
        try {
            const resp = await fetch(`/api/admin/repos/${repoId}`, { headers: authHeaders() });
            if (!resp.ok) return; // repo 在轮询期间被删除，或权限问题——安静退出
            r = await resp.json();
        } catch {
            return; // 网络错误——安静退出，不让轮询本身变成一个新的报错来源
        }
        loadRepos();
        if (r.last_sync_status !== 'syncing') {
            if (r.last_sync_status === 'ok') showMsg(`仓库 ${r.name} 同步成功：${r.last_sync_message || ''}`);
            else if (r.last_sync_status === 'error') showMsg(`仓库 ${r.name} 同步失败：${r.last_sync_message || ''}`, false);
            return;
        }
        if (Date.now() - start > maxWaitMs) {
            showMsg(`仓库 ${r.name} 仍在同步中，请稍后刷新查看结果`, false);
            return;
        }
        await new Promise(res => setTimeout(res, intervalMs));
    }
}

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
            <td>${syncStatusCell(r)}</td>
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

// Read-only display of the background sync cadence (changing it is an .env
// edit + restart, by design).
(async () => {
    try {
        const resp = await fetch("/api/config", { headers: authHeaders() });
        if (!resp.ok) return;
        const cfg = await resp.json();
        const el = document.getElementById("sync-interval-note");
        if (el && cfg.repo_sync_interval_minutes != null) {
            el.textContent = cfg.repo_sync_interval_minutes > 0
                ? `自动同步间隔：${cfg.repo_sync_interval_minutes} 分钟`
                : "自动同步已禁用（仅手动）";
        }
        showGitSha(cfg.git_sha, document.getElementById("admin-header-actions"));
    } catch {}
})();

async function createRepo(btn) {
    const name = document.getElementById("new-repo-name").value.trim();
    const url = document.getElementById("new-repo-url").value.trim();
    const branch = document.getElementById("new-repo-branch").value.trim();
    const credUsername = document.getElementById("new-repo-cred-username").value.trim();
    const credToken = document.getElementById("new-repo-cred-token").value.trim();
    const desc = document.getElementById("new-repo-desc").value.trim();
    if (!name || !url) return showMsg("请填写名称和 URL", false);
    // 防止手速快/网络慢时重复点击在后端去重检查生效前就已经并发提交两次
    // （克隆本身也要跑好几秒，双击窗口不小）。
    btn.disabled = true;
    try {
        const { ok, data } = await apiRequest("/api/admin/repos", {
            method: "POST",
            body: JSON.stringify({
                name, url, branch: branch || null,
                cred_username: credUsername || null, cred_token: credToken || null,
                description: desc,
            }),
        });
        if (!ok) return showMsg(data.detail || "创建失败", false);
        // 生产 QA 复测（2026-07-14）：POST 的响应不再带 synced/sync_message——
        // 同步已经在后台异步跑了，这里立刻提示"已创建，同步中"并开始轮询，
        // 不再等整个 clone 跑完才让按钮解禁/给出最终提示。
        showMsg(`仓库 ${name} 已创建，正在同步…`);
        document.getElementById("new-repo-name").value = "";
        document.getElementById("new-repo-url").value = "";
        document.getElementById("new-repo-branch").value = "";
        document.getElementById("new-repo-cred-username").value = "";
        document.getElementById("new-repo-cred-token").value = "";
        document.getElementById("new-repo-desc").value = "";
        loadRepos();
        pollRepoSyncStatus(data.id);
    } finally {
        btn.disabled = false;
    }
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
        if (!ok || !data.ok) return showMsg(data.detail || data.message || "同步启动失败", false);
        // 生产 QA 复测（2026-07-14）：/sync 现在也是 fire-and-forget，响应
        // 只表示"已开始"，不是最终结果——轮询拿真正的成功/失败。
        showMsg("同步已开始…");
        loadRepos();
        pollRepoSyncStatus(id);
    } catch (err) {
        showMsg(`网络错误: ${err.message}`, false);
    } finally {
        btn.disabled = false;
    }
}

async function deleteRepo(id) {
    const ok = await confirmDialog({
        title: "删除仓库", message: "确定删除此仓库？相关权限也会被移除。",
        confirmLabel: "删除", danger: true,
    });
    if (!ok) return;
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
    const ok = await confirmDialog({
        title: "撤销权限", message: "确定撤销此权限？", confirmLabel: "撤销", danger: true,
    });
    if (!ok) return;
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

// ===== Issue progress tracking =====
const TRACK_STATUS = {
    submitted: { label: "已提报", color: "var(--mute)" },
    claimed:   { label: "修复中", color: "var(--ink-800)" },
    merged:    { label: "已合入", color: "var(--moss)" },
    closed:    { label: "已关闭", color: "var(--moss)" },
    reopened:  { label: "被打回", color: "var(--rust)" },
};

async function loadIssueTracking() {
    const resp = await fetch("/api/admin/issues/tracking?limit=100", { headers: authHeaders() });
    const data = await resp.json();
    const counts = data.counts || {};

    const m = data.metrics || {};
    document.getElementById("issues-summary-cards").innerHTML =
        ["submitted", "claimed", "merged", "closed", "reopened"].map(key => `
        <div class="stat-card">
            <div class="stat-label">${TRACK_STATUS[key].label}</div>
            <div class="stat-value" style="color:${key === 'reopened' && counts[key] ? 'var(--rust)' : 'inherit'}">${formatNumber(counts[key] || 0)}</div>
        </div>
    `).join("") + `
        <div class="stat-card">
            <div class="stat-label">已验证修复</div>
            <div class="stat-value" style="color:${m.fixed_count ? 'var(--moss)' : 'var(--faint)'}">${formatNumber(m.fixed_count || 0)}</div>
            <div class="stat-sub">平台校验 commit 已在 test</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">平均修复时长</div>
            <div class="stat-value">${m.avg_fix_hours != null ? m.avg_fix_hours + "h" : "—"}</div>
            <div class="stat-sub">${m.avg_fix_hours != null ? "提报 → 关闭" : "待结构化报告数据"}</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">嫌疑位置命中率</div>
            <div class="stat-value">${m.hit_rate != null ? Math.round(m.hit_rate * 100) + "%" : "—"}</div>
            <div class="stat-sub">${m.hit_rate != null ? `样本 ${m.hit_sample} 条` : "待结构化报告数据"}</div>
        </div>
    `;

    document.getElementById("issues-tracking-table").innerHTML = (data.submissions || []).map(s => {
        const st = TRACK_STATUS[s.track_status] || TRACK_STATUS.submitted;
        const codexLabels = (s.remote_labels || []).filter(l => l.startsWith("codex:"));
        const reports = s.fix_reports || [];
        const verified = reports.filter(r => r.verified === 1);
        const reportBadge = reports.length
            ? `<span title="${esc(reports.map(r =>
                  `${r.verified === 1 ? '✓已验证' : r.verified === 0 ? '✗验证失败' : '待验证'} ${(r.commit_sha || '').slice(0, 10)} (${(r.files || []).length} 文件)`
              ).join('\n'))}" style="font-family:var(--font-mono);font-size:11px;color:${verified.length ? 'var(--moss)' : 'var(--mute)'};cursor:help;margin-left:4px;">${verified.length ? '✓' : '…'}${reports.length > 1 ? '×' + reports.length : ''}</span>`
            : "";
        return `
        <tr>
            <td>${esc((s.submitted_at || "").replace("T", " ").slice(0, 16))}</td>
            <td>${esc(s.username || "-")}</td>
            <td>${esc(s.repo_name || "-")}</td>
            <td><a href="${esc(safeUrl(s.issue_url || '#'))}" target="_blank" rel="noopener" title="${esc(s.title)}">#${esc(s.issue_number)} ${esc(s.title.length > 30 ? s.title.slice(0, 30) + "…" : s.title)}</a></td>
            <td>
                <span class="badge" style="background:transparent;border:1px solid ${st.color};color:${st.color};">${st.label}</span>
                ${reportBadge}
                ${s.track_error ? `<span title="${esc(s.track_error)}" style="color:var(--rust);cursor:help;margin-left:4px;">⚠</span>` : ""}
                ${codexLabels.length ? `<span style="font-family:var(--font-mono);font-size:11px;color:var(--faint);margin-left:4px;" title="${esc(codexLabels.join(', '))}">${codexLabels.length}🏷</span>` : ""}
            </td>
            <td style="color:${s.reopen_count ? 'var(--rust)' : 'var(--faint)'}">${s.reopen_count || 0}</td>
            <td style="color:var(--faint)">${s.last_checked_at ? esc(s.last_checked_at.replace("T", " ").slice(5, 16)) : "未检查"}</td>
        </tr>`;
    }).join("") || `<tr><td colspan="7" style="color:var(--faint);">暂无提报工单</td></tr>`;
}

async function pollIssueTracking(btn) {
    btn.disabled = true; btn.textContent = "同步中…";
    try {
        const { ok, data } = await apiRequest("/api/admin/issues/tracking/poll", { method: "POST" });
        showMsg(ok ? `已同步 ${data.polled} 条工单状态` : "同步失败", ok);
        if (ok) await loadIssueTracking();
    } finally {
        btn.disabled = false; btn.textContent = "立即同步";
    }
}

// ===== Semantic search recall log =====
// score coloring is shared between the summary cards and the recent-queries
// table: null (no hits at all) reads the same as a genuinely low score,
// since both are the "this query didn't work" signal the panel exists to surface.
function scoreColor(score) {
    if (score == null || score < 0.5) return "var(--rust)";
    if (score >= 0.7) return "var(--moss)";
    return "var(--mute)";
}

async function loadSemanticSearch() {
    const lowOnly = document.getElementById("semantic-low-score-only").checked;
    const [summaryResp, recentResp] = await Promise.all([
        fetch("/api/admin/semantic-search/summary", { headers: authHeaders() }),
        fetch(`/api/admin/semantic-search/recent?limit=50&low_score_only=${lowOnly}`, { headers: authHeaders() }),
    ]);
    const summary = await summaryResp.json();
    const recent = await recentResp.json();

    const avgScore = Number(summary.avg_top1_score || 0);
    document.getElementById("semantic-summary-cards").innerHTML = `
        <div class="stat-card">
            <div class="stat-label">查询次数</div>
            <div class="stat-value">${formatNumber(summary.query_count)}</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">平均 Top1 分数</div>
            <div class="stat-value" style="color:${scoreColor(avgScore)}">${avgScore.toFixed(3)}</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">低分查询（&lt;0.5）</div>
            <div class="stat-value" style="color:var(--rust)">${formatNumber(summary.low_score_count)}</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">零召回查询</div>
            <div class="stat-value" style="color:var(--rust)">${formatNumber(summary.no_result_count)}</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">平均耗时</div>
            <div class="stat-value">${formatMs(summary.avg_duration_ms)}</div>
        </div>
    `;

    const dist = summary.distribution || {};
    const buckets = [
        { key: "bucket_none", label: "无结果", color: "var(--rust)" },
        { key: "bucket_0_3", label: "0.0-0.3", color: "var(--rust)" },
        { key: "bucket_3_5", label: "0.3-0.5", color: "var(--rust)" },
        { key: "bucket_5_7", label: "0.5-0.7", color: "var(--mute)" },
        { key: "bucket_7_10", label: "0.7-1.0", color: "var(--moss)" },
    ];
    const maxCount = Math.max(1, ...buckets.map(b => Number(dist[b.key] || 0)));
    document.getElementById("semantic-distribution").innerHTML = buckets.map(b => {
        const count = Number(dist[b.key] || 0);
        const pct = Math.round(count / maxCount * 100);
        return `
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;font-family:var(--font-mono);font-size:12.5px;">
                <div style="width:70px;color:var(--mute);">${b.label}</div>
                <div style="flex:1;background:var(--bg-tertiary);border-radius:3px;overflow:hidden;height:16px;">
                    <div style="width:${pct}%;background:${b.color};height:100%;"></div>
                </div>
                <div style="width:32px;text-align:right;">${count}</div>
            </div>
        `;
    }).join("");

    document.getElementById("semantic-recent-table").innerHTML = recent.map(r => `
        <tr>
            <td>${esc((r.created_at || "").replace("T", " ").slice(0, 19))}</td>
            <td>${esc(r.username || "-")}</td>
            <td>${esc(r.repo_name || (r.repo_id != null ? `#${r.repo_id}` : "-"))}</td>
            <td title="${esc(r.query)}">${esc(r.query.length > 40 ? r.query.slice(0, 40) + "…" : r.query)}</td>
            <td>${r.result_count}</td>
            <td style="color:${scoreColor(r.top1_score)}">${r.top1_score != null ? Number(r.top1_score).toFixed(3) : "—"}</td>
            <td>${formatMs(r.duration_ms)}</td>
        </tr>
    `).join("") || `<tr><td colspan="7" style="color:var(--faint);">暂无数据</td></tr>`;
}

// ===== Webhook config =====
async function loadWebhookConfig() {
    const resp = await fetch("/api/admin/webhook-config", { headers: authHeaders() });
    const data = await resp.json();
    document.getElementById("webhook-github-url").value = location.origin + data.github_path;
    document.getElementById("webhook-github-secret").value = data.github_secret;
    document.getElementById("webhook-gitlab-url").value = location.origin + data.gitlab_path;
    document.getElementById("webhook-gitlab-secret").value = data.gitlab_secret;
}

async function copyWebhookField(id) {
    const input = document.getElementById(id);
    try {
        await navigator.clipboard.writeText(input.value);
        showMsg("已复制到剪贴板");
    } catch {
        input.select();
        showMsg("剪贴板不可用，已为你选中文本，手动复制（Ctrl/Cmd+C）", false);
    }
}

// The whole point of moving these secrets into the DB (2026-07-14, GitHub
// issue #6) — rotating a leaked/misconfigured one used to mean SSHing into
// the host and restarting the container; now it's a button.
async function regenerateWebhookSecret(provider, btn) {
    const label = provider === "github" ? "GitHub" : "GitLab";
    const ok = await confirmDialog({
        title: `重新生成 ${label} Webhook Secret`,
        message: `旧的 secret 会立即失效——如果 ${label} 那边已经配置了 webhook，需要马上同步更新，否则投递会开始返回 401 直到你更新为止。确定继续吗？`,
        confirmLabel: "重新生成", danger: true,
    });
    if (!ok) return;
    btn.disabled = true;
    try {
        const { ok: reqOk, data } = await apiRequest("/api/admin/webhook-config/regenerate", {
            method: "POST", body: JSON.stringify({ provider }),
        });
        if (!reqOk) return showMsg(data.detail || "重新生成失败", false);
        document.getElementById(`webhook-${provider}-secret`).value = data.secret;
        showMsg(`${label} secret 已重新生成，别忘了同步更新到 ${label}`);
    } finally {
        btn.disabled = false;
    }
}

// ===== LLM config =====
// 2026-07-14 production P0: a host-side .env permission mismatch made the
// real ANTHROPIC_API_KEY silently unreadable and Agent 能力 failed with an
// opaque library error on every turn, with nothing in the deploy log to
// point at the actual cause (see main.ts's post-load DB override for the
// full incident). This tab replaces the .env file as the source of truth —
// GET never returns the real key (only whether one is configured, same
// has_token pattern repo credentials already use), and the API Key input is
// always left blank on load so re-saving other fields can't blank it out.
async function loadLlmConfig() {
    const resp = await fetch("/api/admin/llm-config", { headers: authHeaders() });
    const data = await resp.json();
    document.getElementById("llm-base-url").value = data.base_url || "";
    document.getElementById("llm-model").value = data.model || "";
    document.getElementById("llm-max-tokens").value = data.max_tokens || "";
    document.getElementById("llm-api-key").value = "";
    document.getElementById("llm-api-key").placeholder = data.configured
        ? "已配置（留空则不修改）" : "留空则不修改已保存的 key";
    document.getElementById("llm-config-status").innerHTML = data.configured
        ? '<span style="color:var(--moss)">✓ 已配置</span>'
        : '<span style="color:var(--rust)">✗ 未配置 — Agent 能力暂不可用</span>';
}

async function saveLlmConfig(btn) {
    const body = {
        base_url: document.getElementById("llm-base-url").value.trim(),
        model: document.getElementById("llm-model").value.trim(),
        max_tokens: Number(document.getElementById("llm-max-tokens").value) || undefined,
        api_key: document.getElementById("llm-api-key").value,
    };
    btn.disabled = true;
    try {
        const { ok, data } = await apiRequest("/api/admin/llm-config", {
            method: "POST", body: JSON.stringify(body),
        });
        if (!ok) return showMsg(data.detail || "保存失败", false);
        showMsg("LLM 配置已保存，立即生效，无需重启");
        await loadLlmConfig();
    } finally {
        btn.disabled = false;
    }
}

// QA-reported 2026-07-14: webhook-driven status changes land in the DB
// near-instantly, but this table only ever redrew on tab switch or the
// explicit "刷新"/"立即同步" buttons — an externally-closed issue kept
// showing "已提报" until an admin happened to click something. Poll gently
// (a cheap DB read, not a real tracker API call — that's what "立即同步"
// is for) while the 工单 tab is the one actually visible, and refresh
// immediately when the tab regains focus.
const ISSUE_TRACKING_POLL_MS = 20_000;
function issuesTabActive() {
    return document.getElementById("panel-issues").classList.contains("active");
}
setInterval(() => { if (isAuthorizedAdmin && issuesTabActive()) loadIssueTracking(); }, ISSUE_TRACKING_POLL_MS);
window.addEventListener("focus", () => { if (isAuthorizedAdmin && issuesTabActive()) loadIssueTracking(); });

// ===== Init =====
if (isAuthorizedAdmin) {
    loadUsers();
    loadRepos();
    loadPerms();
    loadIssueTracking();
    loadWebhookConfig();
    loadLlmConfig();
    loadUsage();
    loadSemanticSearch();
}
