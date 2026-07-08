// ===== Auth check =====
const token = localStorage.getItem("token");
const user = JSON.parse(localStorage.getItem("user") || "{}");
if (!token || user.role !== "admin") { window.location.href = "/login"; }

document.getElementById("admin-user").textContent = user.username || "";

function esc(str) {
    const d = document.createElement("div");
    d.textContent = String(str ?? "");
    return d.innerHTML;
}

function authHeaders() {
    return { "Content-Type": "application/json", "Authorization": `Bearer ${token}` };
}

function showMsg(text, ok = true) {
    const area = document.getElementById("msg-area");
    area.innerHTML = `<div class="msg ${ok ? 'msg-ok' : 'msg-err'}">${text}</div>`;
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
            <td>${u.is_active ? '✅' : '🚫'}</td>
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
    const resp = await fetch("/api/admin/users", {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ username, password, role }),
    });
    if (!resp.ok) { const d = await resp.json(); return showMsg(d.detail || "创建失败", false); }
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
async function loadRepos() {
    const resp = await fetch("/api/admin/repos", { headers: authHeaders() });
    const repos = await resp.json();
    const tbody = document.getElementById("repos-table");
    tbody.innerHTML = repos.map(r => `
        <tr>
            <td>${r.id}</td>
            <td>${esc(r.name)}</td>
            <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis">${esc(r.url)}</td>
            <td>${esc(r.description || '-')}</td>
            <td><button class="btn btn-sm btn-danger" onclick="deleteRepo(${r.id})">删除</button></td>
        </tr>
    `).join("");
    // Update permission dropdown
    const sel = document.getElementById("perm-repo");
    sel.innerHTML = '<option value="">选择仓库</option>' + repos.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join("");
}

async function createRepo() {
    const name = document.getElementById("new-repo-name").value.trim();
    const url = document.getElementById("new-repo-url").value.trim();
    const desc = document.getElementById("new-repo-desc").value.trim();
    if (!name || !url) return showMsg("请填写名称和 URL", false);
    const resp = await fetch("/api/admin/repos", {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ name, url, description: desc }),
    });
    if (!resp.ok) { const d = await resp.json(); return showMsg(d.detail || "创建失败", false); }
    showMsg(`仓库 ${name} 添加成功`);
    document.getElementById("new-repo-name").value = "";
    document.getElementById("new-repo-url").value = "";
    document.getElementById("new-repo-desc").value = "";
    loadRepos();
}

async function deleteRepo(id) {
    if (!confirm("确定删除此仓库？相关权限也会被移除。")) return;
    await fetch(`/api/admin/repos/${id}`, { method: "DELETE", headers: authHeaders() });
    showMsg("仓库已删除");
    loadRepos();
    loadPerms();
}

// ===== Permissions =====
async function loadPerms() {
    const resp = await fetch("/api/admin/permissions", { headers: authHeaders() });
    const perms = await resp.json();
    const tbody = document.getElementById("perms-table");
    tbody.innerHTML = perms.map(p => `
        <tr>
            <td>${esc(p.username)}</td>
            <td>${esc(p.repo_name)}</td>
            <td><span class="badge ${p.access_level === 'read' ? 'badge-read' : 'badge-write'}">${esc(p.access_level)}</span></td>
            <td><button class="btn btn-sm btn-danger" onclick="revokePerm(${p.user_id}, ${p.repo_id})">撤销</button></td>
        </tr>
    `).join("");
}

async function grantPerm() {
    const userId = parseInt(document.getElementById("perm-user").value);
    const repoId = parseInt(document.getElementById("perm-repo").value);
    const level = document.getElementById("perm-level").value;
    if (!userId || !repoId) return showMsg("请选择用户和仓库", false);
    const resp = await fetch("/api/admin/permissions", {
        method: "POST", headers: authHeaders(),
        body: JSON.stringify({ user_id: userId, repo_id: repoId, access_level: level }),
    });
    if (!resp.ok) { const d = await resp.json(); return showMsg(d.detail || "授权失败", false); }
    showMsg("权限已授予");
    loadPerms();
}

async function revokePerm(userId, repoId) {
    if (!confirm("确定撤销此权限？")) return;
    await fetch(`/api/admin/permissions/${userId}/${repoId}`, { method: "DELETE", headers: authHeaders() });
    showMsg("权限已撤销");
    loadPerms();
}

// ===== Init =====
loadUsers();
loadRepos();
loadPerms();
