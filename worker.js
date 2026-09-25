
const ADMIN_USER = "admin";
const ADMIN_PASS = "admin123"; // بعداً عوض کن
const JWT_SECRET = "change-this-secret-key-now";

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/" || path === "/index.html") {
      return html(LOGIN_PAGE);
    }
    if (path === "/admin") {
      return html(ADMIN_PAGE);
    }

    if (path === "/api/login" && req.method === "POST") {
      return handleLogin(req, env);
    }

    if (path.startsWith("/api/")) {
      const auth = await requireAuth(req, env);
      if (auth instanceof Response) return auth;

      if (path === "/api/stats" && req.method === "GET") {
        return handleStats(env);
      }
      if (path === "/api/users" && req.method === "GET") {
        return handleUsers(env);
      }
      if (path === "/api/logout" && req.method === "POST") {
        return handleLogout(req, env);
      }
    }

    return json({ error: "not found" }, 404);
  },
};

// ---------- Auth ----------
async function handleLogin(req, env) {
  try {
    const body = await req.json();
    const username = (body.username || "").trim();
    const password = body.password || "";

    if (!username || !password) {
      return json({ error: "نام کاربری و رمز الزامی است" }, 400);
    }

    await sleep(300);

    if (username !== ADMIN_USER || password !== ADMIN_PASS) {
      return json({ error: "نام کاربری یا رمز اشتباه است" }, 401);
    }

    const token = await createToken(username);
    if (env.KV) {
      await env.KV.put("session:" + token, username, { expirationTtl: 43200 });
    }
    return json({ ok: true, token, username });
  } catch {
    return json({ error: "خطای سرور" }, 500);
  }
}

async function requireAuth(req, env) {
  const h = req.headers.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return json({ error: "Unauthorized" }, 401);

  if (env.KV) {
    const user = await env.KV.get("session:" + token);
    if (!user) return json({ error: "سشن منقضی شده" }, 401);
    return user;
  }

  const ok = await verifyToken(token);
  if (!ok) return json({ error: "Unauthorized" }, 401);
  return "admin";
}

async function handleLogout(req, env) {
  const h = req.headers.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (token && env.KV) await env.KV.delete("session:" + token);
  return json({ ok: true });
}

async function createToken(user) {
  const payload = btoa(JSON.stringify({ u: user, t: Date.now() }));
  const sig = (await sha256(payload + JWT_SECRET)).slice(0, 32);
  return payload + "." + sig;
}

async function verifyToken(token) {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const expect = (await sha256(parts[0] + JWT_SECRET)).slice(0, 32);
  return parts[1] === expect;
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- Stats ----------
async function handleStats(env) {
  let total_users = 0,
    banned = 0,
    messages = 0;
  try {
    if (env.DB) {
      const u = await env.DB.prepare("SELECT COUNT(*) as c FROM players").first();
      total_users = u?.c ?? 0;
      try {
        const b = await env.DB.prepare("SELECT COUNT(*) as c FROM players WHERE banned = 1").first();
        banned = b?.c ?? 0;
      } catch {}
      try {
        const m = await env.DB.prepare("SELECT COUNT(*) as c FROM messages").first();
        messages = m?.c ?? 0;
      } catch {}
    }
  } catch {}
  return json({ total_users, banned, messages });
}

async function handleUsers(env) {
  try {
    if (!env.DB) return json({ users: [] });
    const rows = await env.DB.prepare(
      "SELECT id, display_name, coins, trophies, level, created_at FROM players ORDER BY created_at DESC LIMIT 100"
    ).all();
    return json({ users: rows.results || [] });
  } catch {
    return json({ users: [] });
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function html(body) {
  return new Response(body, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ---------- Pages ----------
const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>ورود | پنل مدیریت</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Tahoma,sans-serif;background:#0d0f14;color:#e8eaed;min-height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:#161a22;border:1px solid #252a35;border-radius:20px;padding:32px 28px;width:min(360px,92vw)}
h1{font-size:1.25rem;text-align:center;margin-bottom:6px}
.sub{text-align:center;color:#8b93a7;font-size:.85rem;margin-bottom:24px}
label{display:block;font-size:.8rem;color:#9aa3b5;margin-bottom:6px}
input{width:100%;padding:12px 14px;border-radius:12px;border:1px solid #2a3140;background:#0f1218;color:#fff;font-size:1rem;margin-bottom:14px;outline:none}
input:focus{border-color:#3b82f6}
button{width:100%;padding:13px;border:none;border-radius:12px;background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;font-size:1rem;font-weight:600;cursor:pointer}
.err{color:#f87171;font-size:.85rem;text-align:center;min-height:1.2em;margin-top:10px}
</style>
</head>
<body>
<div class="card">
<h1>پنل مدیریت</h1>
<p class="sub">برای ادامه وارد شوید</p>
<label>نام کاربری</label>
<input id="user" placeholder="admin"/>
<label>رمز عبور</label>
<input id="pass" type="password" placeholder="••••••••"/>
<button id="btn">ورود</button>
<p class="err" id="err"></p>
</div>
<script>
document.getElementById('btn').onclick=async()=>{
  const err=document.getElementById('err');err.textContent='';
  const username=document.getElementById('user').value.trim();
  const password=document.getElementById('pass').value;
  try{
    const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
    const j=await r.json();
    if(!r.ok){err.textContent=j.error||'خطا';return}
    localStorage.setItem('admin_token',j.token);
    location.href='/admin';
  }catch(e){err.textContent='ارتباط برقرار نشد'}
};
document.getElementById('pass').onkeydown=e=>{if(e.key==='Enter')document.getElementById('btn').click()};
</script>
</body>
</html>`;

const ADMIN_PAGE = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>پنل مدیریت</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Tahoma,sans-serif;background:#0d0f14;color:#e8eaed;min-height:100vh;padding:12px}
header{display:flex;align-items:center;justify-content:space-between;padding:10px 4px 16px;flex-wrap:wrap;gap:8px}
.title{font-size:1.1rem;font-weight:700}
.actions{display:flex;gap:8px}
.btn{padding:8px 14px;border-radius:20px;border:1px solid #2a3140;background:#161a22;color:#e8eaed;font-size:.85rem;cursor:pointer}
nav{display:flex;gap:4px;border-bottom:1px solid #1e2430;margin-bottom:16px;overflow-x:auto}
nav button{background:none;border:none;color:#8b93a7;padding:10px 14px;font-size:.9rem;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap}
nav button.active{color:#60a5fa;border-bottom-color:#3b82f6}
.panel{background:#161a22;border-radius:16px;padding:18px;border:1px solid #1e2430}
.panel h2{font-size:1rem;margin-bottom:14px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.stat{background:#0f1218;border-radius:14px;padding:20px 12px;text-align:center}
.stat .n{font-size:1.8rem;font-weight:700}
.stat .l{font-size:.8rem;color:#8b93a7;margin-top:4px}
.refresh{margin-top:14px;text-align:left}
.refresh button{padding:8px 16px;border-radius:20px;border:1px solid #2a3140;background:#0f1218;color:#c0c6d4;font-size:.85rem;cursor:pointer}
table{width:100%;border-collapse:collapse;font-size:.85rem}
th,td{padding:10px 8px;text-align:right;border-bottom:1px solid #1e2430}
th{color:#8b93a7}
.hidden{display:none}
#gate{position:fixed;inset:0;background:#0d0f14;display:flex;align-items:center;justify-content:center;z-index:99;color:#8b93a7}
</style>
</head>
<body>
<div id="gate">در حال بررسی ورود...</div>
<header>
<div class="title">📊 پنل مدیریت</div>
<div class="actions">
<button class="btn" id="adminTag">مدیر</button>
<button class="btn" id="logout">خروج</button>
</div>
</header>
<nav>
<button class="active" data-tab="stats">آمار</button>
<button data-tab="users">کاربران</button>
<button data-tab="chat">چت عمومی</button>
<button data-tab="treasure">گنج‌ها</button>
</nav>
<section id="tab-stats" class="panel">
<h2>📊 آمار کلی</h2>
<div class="grid">
<div class="stat"><div class="n" id="s-users">—</div><div class="l">کل کاربران</div></div>
<div class="stat"><div class="n" id="s-banned">—</div><div class="l">مسدود شده</div></div>
<div class="stat" style="grid-column:1/-1"><div class="n" id="s-msgs">—</div><div class="l">پیام‌ها</div></div>
</div>
<div class="refresh"><button id="refresh">به‌روزرسانی</button></div>
</section>
<section id="tab-users" class="panel hidden">
<h2>👥 کاربران</h2>
<table><thead><tr><th>نام</th><th>سکه</th><th>کاپ</th><th>لول</th></tr></thead>
<tbody id="users-body"></tbody></table>
</section>
<section id="tab-chat" class="panel hidden"><h2>💬 چت عمومی</h2><p style="color:#8b93a7">به‌زودی...</p></section>
<section id="tab-treasure" class="panel hidden"><h2>💎 گنج‌ها</h2><p style="color:#8b93a7">به‌زودی...</p></section>
<script>
const token=localStorage.getItem('admin_token');
if(!token)location.href='/';
async function api(path,opts={}){
  const r=await fetch(path,{...opts,headers:{...(opts.headers||{}),'Authorization':'Bearer '+token,'Content-Type':'application/json'}});
  if(r.status===401){localStorage.removeItem('admin_token');location.href='/';return null}
  return r.json();
}
async function loadStats(){
  const j=await api('/api/stats');if(!j)return;
  document.getElementById('s-users').textContent=j.total_users??0;
  document.getElementById('s-banned').textContent=j.banned??0;
  document.getElementById('s-msgs').textContent=j.messages??0;
}
async function loadUsers(){
  const j=await api('/api/users');if(!j)return;
  const tb=document.getElementById('users-body');tb.innerHTML='';
  (j.users||[]).forEach(u=>{
    const tr=document.createElement('tr');
    tr.innerHTML='<td>'+(u.display_name||u.id)+'</td><td>'+(u.coins??0)+'</td><td>'+(u.trophies??0)+'</td><td>'+(u.level??1)+'</td>';
    tb.appendChild(tr);
  });
  if(!(j.users||[]).length)tb.innerHTML='<tr><td colspan="4" style="color:#8b93a7;text-align:center">کاربری نیست</td></tr>';
}
document.getElementById('refresh').onclick=()=>loadStats();
document.getElementById('logout').onclick=async()=>{
  await api('/api/logout',{method:'POST'});
  localStorage.removeItem('admin_token');location.href='/';
};
document.querySelectorAll('nav button').forEach(b=>{
  b.onclick=()=>{
    document.querySelectorAll('nav button').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    document.querySelectorAll('section.panel').forEach(s=>s.classList.add('hidden'));
    document.getElementById('tab-'+b.dataset.tab).classList.remove('hidden');
    if(b.dataset.tab==='users')loadUsers();
  };
});
loadStats().then(()=>{document.getElementById('gate').style.display='none'});
</script>
</body>
</html>`;
