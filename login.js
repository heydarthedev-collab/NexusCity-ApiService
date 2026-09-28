const API_URL = 'https://nexuscityapiserviceir.zeus-9dhmbw.workers.dev';

document.getElementById('btn').onclick=async()=>{
const err=document.getElementById('err');
err.textContent='';

const username=document.getElementById('user').value.trim();
const password=document.getElementById('pass').value;

try{
const r=await fetch(API_URL+'/api/login',{
method:'POST',
headers:{
'Content-Type':'application/json'
},
body:JSON.stringify({
username,
password
})
});

const j=await r.json();

if(!r.ok){
  err.textContent=j.error||'خطا';
  return;
}

localStorage.setItem('admin_token',j.token);
location.href='admin.html';

}catch(e){
err.textContent='ارتباط برقرار نشد';
}
};

document.getElementById('pass').onkeydown=e=>{
if(e.key==='Enter'){
document.getElementById('btn').click();
}
};
