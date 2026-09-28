const token=localStorage.getItem('admin_token');

if(!token)location.href='/';

async function api(path,opts={}){
const r=await fetch(path,{
...opts,
headers:{
...(opts.headers||{}),
'Authorization':'Bearer '+token,
'Content-Type':'application/json'
}
});

if(r.status===401){
localStorage.removeItem('admin_token');
location.href='/';
return null
}

return r.json();
}

async function loadStats(){
const j=await api('/api/stats');
if(!j)return;

document.getElementById('s-users').textContent=j.total_users??0;
document.getElementById('s-banned').textContent=j.banned??0;
document.getElementById('s-msgs').textContent=j.messages??0;
}

async function loadUsers(){
const j=await api('/api/users');
if(!j)return;

const tb=document.getElementById('users-body');

tb.innerHTML='';

(j.users||[]).forEach(u=>{
const tr=document.createElement('tr');

tr.innerHTML=
  '<td>'+(u.display_name||u.id)+'</td>'+
  '<td>'+(u.coins??0)+'</td>'+
  '<td>'+(u.trophies??0)+'</td>'+
  '<td>'+(u.level??1)+'</td>';

tb.appendChild(tr);

});

if(!(j.users||[]).length){
tb.innerHTML=
'<tr>'+
'<td colspan="4" style="color:#8b93a7;text-align:center">'+
'کاربری نیست'+
'</td>'+
'</tr>';
}
}

document.getElementById('refresh').onclick=()=>{
loadStats()
};

document.getElementById('logout').onclick=async()=>{
await api('/api/logout',{
method:'POST'
});

localStorage.removeItem('admin_token');
location.href='/';
};

document.querySelectorAll('nav button').forEach(b=>{
b.onclick=()=>{
document.querySelectorAll('nav button')
.forEach(x=>x.classList.remove('active'));

b.classList.add('active');

document.querySelectorAll('section.panel')
  .forEach(s=>s.classList.add('hidden'));

document.getElementById(
  'tab-'+b.dataset.tab
).classList.remove('hidden');

if(b.dataset.tab==='users'){
  loadUsers()
}

};
});

loadStats().then(()=>{
document.getElementById('gate').style.display='none'
});
