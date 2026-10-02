/**
 * POPPO MULTIPLAYER SERVER
 * Cloudflare Workers + Durable Objects
 *
 * Features:
 * - Multiplayer WebSocket
 * - Admin Panel
 * - Server Registry
 * - Live Console
 * - Player Management
 * - Ban System
 * - Vehicle State
 * - Server Statistics
 *
 * Required binding:
 * GAME_ROOM -> Durable Object
 *
 * Environment:
 * ADMIN_KEY
 */

const VERSION = "2.0.0";

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    this.sessions = new Map();
    this.players = new Map();
    this.vehicles = new Map();

    this.logs = [];
    this.servers = [];

    this.loaded = false;
  }

  async loadData() {
    if (this.loaded) return;

    const savedServers =
      await this.state.storage.get("servers");

    const savedLogs =
      await this.state.storage.get("logs");

    this.servers =
      Array.isArray(savedServers)
        ? savedServers
        : [];

    this.logs =
      Array.isArray(savedLogs)
        ? savedLogs.slice(-300)
        : [];

    this.loaded = true;
  }

  async saveServers() {
    await this.state.storage.put(
      "servers",
      this.servers
    );
  }

  async saveLogs() {
    await this.state.storage.put(
      "logs",
      this.logs.slice(-300)
    );
  }

  addLog(type, message, extra = {}) {
    const log = {
      id: crypto.randomUUID(),
      time: Date.now(),
      type,
      message,
      ...extra
    };

    this.logs.push(log);

    if (this.logs.length > 300) {
      this.logs.shift();
    }

    this.state.storage.put(
      "logs",
      this.logs.slice(-300)
    ).catch(() => {});

    return log;
  }

  async fetch(request) {
    await this.loadData();

    const url = new URL(request.url);

    if (
      request.method === "GET" &&
      (
        url.pathname === "/" ||
        url.pathname === "/admin"
      )
    ) {
      return new Response(
        ADMIN_HTML,
        {
          headers: {
            "Content-Type":
              "text/html; charset=utf-8",
            "Cache-Control":
              "no-store"
          }
        }
      );
    }

    if (url.pathname === "/health") {
      return this.json({
        ok: true,
        version: VERSION,
        players: this.players.size,
        vehicles: this.vehicles.size,
        time: Date.now()
      });
    }

    if (
      request.headers.get("Upgrade") ===
      "websocket"
    ) {
      const pair = new WebSocketPair();

      const client = pair[0];
      const server = pair[1];

      this.handleSession(server);

      return new Response(null, {
        status: 101,
        webSocket: client
      });
    }

    return new Response(
      "Poppo Multiplayer Server OK",
      {
        headers: {
          "Content-Type":
            "text/plain; charset=utf-8"
        }
      }
    );
  }

  json(data, status = 200) {
    return new Response(
      JSON.stringify(data),
      {
        status,
        headers: {
          "Content-Type":
            "application/json; charset=utf-8"
        }
      }
    );
  }

  handleSession(ws) {
    ws.accept();

    let player = null;

    ws.addEventListener(
      "message",
      async event => {
        let data;

        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }

        if (!data || typeof data.type !== "string") {
          return;
        }

        switch (data.type) {

          /* =========================
             PLAYER AUTH
          ========================= */

          case "auth": {
            const id = String(
              data.id ||
              crypto.randomUUID()
            );

            player = {
              id,

              token: String(
                data.token || ""
              ),

              name: String(
                data.name || "Player"
              ).slice(0, 32),

              job: String(
                data.job || "بیکار"
              ).slice(0, 32),

              level:
                Number(data.level) || 0,

              is_admin:
                Boolean(data.is_admin),

              x: 0,
              y: 0,
              z: 0,
              rot: 0,
              anim: 0,

              is_banned: false,
              ban_expire: 0,
              ban_reason: ""
            };

            /*
             * Duplicate login
             */

            for (
              const [oldWs, oldPlayer]
              of this.sessions
            ) {
              if (
                oldPlayer.id === player.id &&
                oldWs !== ws
              ) {
                this.send(
                  oldWs,
                  {
                    type: "kick",
                    id: player.id,
                    reason: "duplicate"
                  }
                );

                try {
                  oldWs.close();
                } catch {}

                this.sessions.delete(oldWs);
              }
            }

            /*
             * Existing ban
             */

            const ban =
              await this.state.storage.get(
                `ban:${player.id}`
              );

            if (ban) {
              const expired =
                ban.expire !== 0 &&
                Date.now() / 1000 >= ban.expire;

              if (!expired) {
                player.is_banned = true;
                player.ban_expire =
                  ban.expire;
                player.ban_reason =
                  ban.reason;
              } else {
                await this.state.storage.delete(
                  `ban:${player.id}`
                );
              }
            }

            this.sessions.set(
              ws,
              player
            );

            this.players.set(
              player.id,
              player
            );

            this.send(
              ws,
              {
                type: "auth_ok",
                banned:
                  player.is_banned,
                ban_expire:
                  player.ban_expire,
                ban_reason:
                  player.ban_reason
              }
            );

            if (player.is_banned) {
              this.addLog(
                "ban",
                `بازیکن ${player.name} با بن وارد شد`,
                {
                  playerId: player.id
                }
              );

              try {
                ws.close();
              } catch {}

              return;
            }

            this.send(
              ws,
              this.getFullState()
            );

            this.broadcast(
              {
                type: "player_join",
                id: player.id,
                name: player.name,
                job: player.job,
                level: player.level,
                is_admin:
                  player.is_admin,
                x: player.x,
                y: player.y,
                z: player.z,
                rot: player.rot
              },
              player.id
            );

            this.addLog(
              "join",
              `${player.name} وارد سرور شد`,
              {
                playerId: player.id
              }
            );

            break;
          }

          /* =========================
             PING
          ========================= */

          case "ping": {
            this.send(ws, {
              type: "pong",
              time: Date.now()
            });

            break;
          }

          /* =========================
             POSITION
          ========================= */

          case "pos": {
            if (!player || player.is_banned) {
              return;
            }

            player.x =
              Number(data.x) || 0;

            player.y =
              Number(data.y) || 0;

            player.z =
              Number(data.z) || 0;

            player.rot =
              Number(data.rot) || 0;

            player.anim =
              Number(data.anim) || 0;

            this.broadcast(
              {
                type: "pos",
                id: player.id,
                x: player.x,
                y: player.y,
                z: player.z,
                rot: player.rot,
                anim: player.anim
              },
              player.id
            );

            break;
          }

          /* =========================
             CHAT
          ========================= */

          case "chat": {
            if (!player || player.is_banned) {
              return;
            }

            const message =
              String(
                data.message || ""
              ).slice(0, 300);

            if (!message) return;

            this.broadcast({
              type: "chat",
              id: player.id,
              name: player.name,
              message
            });

            this.addLog(
              "chat",
              `${player.name}: ${message}`,
              {
                playerId: player.id
              }
            );

            break;
          }

          /* =========================
             CREATE VEHICLE
          ========================= */

          case "create_vehicle": {
            if (!player || player.is_banned) {
              return;
            }

            const id =
              crypto.randomUUID();

            const vehicle = {
              id,

              owner_id:
                player.id,

              x:
                Number(
                  data.position?.x
                ) || 0,

              y:
                Number(
                  data.position?.y
                ) || 0,

              z:
                Number(
                  data.position?.z
                ) || 0,

              rot:
                Number(
                  data.rotation
                ) || 0,

              steering:
                Number(
                  data.steering
                ) || 0,

              car_type:
                String(
                  data.car_type || "1"
                ),

              occupants: []
            };

            this.vehicles.set(
              id,
              vehicle
            );

            this.broadcast({
              type:
                "vehicle_created",

              id:
                vehicle.id,

              x:
                vehicle.x,

              y:
                vehicle.y,

              z:
                vehicle.z,

              rot:
                vehicle.rot,

              steering:
                vehicle.steering,

              car_type:
                vehicle.car_type,

              owner_id:
                vehicle.owner_id,

              occupants:
                vehicle.occupants
            });

            this.addLog(
              "vehicle",
              `${player.name} یک ماشین ساخت`,
              {
                vehicleId: id,
                playerId: player.id
              }
            );

            break;
          }

          /* =========================
             VEHICLE STATE
          ========================= */

          case "vehicle_state": {
            if (!player || player.is_banned) {
              return;
            }

            const id =
              String(data.id || "");

            const vehicle =
              this.vehicles.get(id);

            if (!vehicle) return;

            vehicle.x =
              Number(data.x) ||
              vehicle.x;

            vehicle.y =
              Number(data.y) ||
              vehicle.y;

            vehicle.z =
              Number(data.z) ||
              vehicle.z;

            vehicle.rot =
              Number(data.rot) ||
              vehicle.rot;

            vehicle.steering =
              Number(data.steering) || 0;

            this.broadcast(
              {
                type:
                  "vehicle_state",

                id:
                  vehicle.id,

                x:
                  vehicle.x,

                y:
                  vehicle.y,

                z:
                  vehicle.z,

                rot:
                  vehicle.rot,

                steering:
                  vehicle.steering
              },
              player.id
            );

            break;
          }

          /* =========================
             SEATS
          ========================= */

          case "seat_update": {
            if (!player) return;

            const id =
              String(
                data.vehicleId || ""
              );

            const vehicle =
              this.vehicles.get(id);

            if (!vehicle) return;

            vehicle.occupants =
              Array.isArray(
                data.occupants
              )
                ? data.occupants
                : [];

            this.broadcast({
              type:
                "seat_update",

              vehicleId:
                id,

              occupants:
                vehicle.occupants
            });

            break;
          }

          /* =========================
             ADMIN AUTH
          ========================= */

          case "panel_auth": {
            const key =
              String(
                data.key || ""
              );

            const adminKey =
              String(
                this.env.ADMIN_KEY || ""
              );

            if (
              !adminKey ||
              key !== adminKey
            ) {
              this.send(ws, {
                type:
                  "panel_auth_failed",
                message:
                  "کلید ادمین اشتباه است"
              });

              try {
                ws.close();
              } catch {}

              return;
            }

            player = {
              id:
                "admin-panel-" +
                crypto.randomUUID(),

              name:
                "Admin Panel",

              job:
                "ادمین",

              level:
                999,

              is_admin:
                true,

              x: 0,
              y: 0,
              z: 0,
              rot: 0,
              anim: 0,

              is_banned:
                false
            };

            this.sessions.set(
              ws,
              player
            );

            this.send(ws, {
              type:
                "panel_auth_ok",
              version:
                VERSION
            });

            this.send(
              ws,
              this.getFullState()
            );

            this.send(ws, {
              type:
                "server_info",

              version:
                VERSION,

              players:
                this.players.size,

              vehicles:
                this.vehicles.size,

              servers:
                this.servers
            });

            break;
          }

          /* =========================
             ADMIN LIST
          ========================= */

          case "admin_list": {
            if (
              !player ||
              !player.is_admin
            ) {
              return;
            }

            this.send(ws, {
              type:
                "admin_list",

              players:
                [...this.players.values()]
                  .filter(
                    p =>
                      !p.id.startsWith(
                        "admin-panel-"
                      )
                  )
                  .map(p => ({
                    id:
                      p.id,

                    name:
                      p.name,

                    job:
                      p.job,

                    level:
                      p.level,

                    is_admin:
                      p.is_admin,

                    x:
                      p.x,

                    y:
                      p.y,

                    z:
                      p.z
                  }))
            });

            break;
          }

          /* =========================
             BAN
          ========================= */

          case "ban": {
            if (
              !player ||
              !player.is_admin
            ) {
              return;
            }

            const targetId =
              String(
                data.id || ""
              );

            const duration =
              Number(
                data.duration
              ) || 86400;

            const reason =
              String(
                data.reason ||
                "بن توسط ادمین"
              ).slice(0, 200);

            const target =
              this.players.get(
                targetId
              );

            if (!target) {
              this.send(ws, {
                type:
                  "error",
                message:
                  "بازیکن پیدا نشد"
              });

              return;
            }

            const expire =
              duration === -1
                ? 0
                : Math.floor(
                    Date.now() / 1000
                  ) + duration;

            target.is_banned = true;
            target.ban_expire =
              expire;
            target.ban_reason =
              reason;

            await this.state.storage.put(
              `ban:${targetId}`,
              {
                expire,
                reason
              }
            );

            for (
              const [tWs, tPlayer]
              of this.sessions
            ) {
              if (
                tPlayer.id === targetId
              ) {
                this.send(
                  tWs,
                  {
                    type:
                      "ban",

                    id:
                      targetId,

                    expire,

                    reason
                  }
                );

                try {
                  tWs.close();
                } catch {}
              }
            }

            this.broadcast({
              type:
                "ban",

              id:
                targetId,

              expire,

              reason
            });

            this.addLog(
              "ban",
              `بازیکن ${target.name} بن شد`,
              {
                playerId:
                  targetId,

                reason
              }
            );

            break;
          }

          /* =========================
             ADMIN CONSOLE
          ========================= */

          case "console": {
            if (
              !player ||
              !player.is_admin
            ) {
              return;
            }

            const command =
              String(
                data.command || ""
              ).trim();

            if (!command) return;

            this.addLog(
              "console",
              `> ${command}`
            );

            await this.executeCommand(
              command,
              ws
            );

            break;
          }

          /* =========================
             SERVER REGISTRY
          ========================= */

          case "server_add": {
            if (
              !player ||
              !player.is_admin
            ) {
              return;
            }

            const name =
              String(
                data.name ||
                "Poppo Server"
              ).slice(0, 50);

            const address =
              String(
                data.address || ""
              ).trim();

            if (!address) {
              this.send(ws, {
                type:
                  "error",
                message:
                  "آدرس سرور وارد نشده"
              });

              return;
            }

            const server = {
              id:
                crypto.randomUUID(),

              name,

              address,

              created_at:
                Date.now(),

              online:
                false
            };

            this.servers.push(
              server
            );

            await this.saveServers();

            this.send(ws, {
              type:
                "servers",
              servers:
                this.servers
            });

            this.addLog(
              "server",
              `سرور ${name} ثبت شد`
            );

            break;
          }

          case "server_delete": {
            if (
              !player ||
              !player.is_admin
            ) {
              return;
            }

            const id =
              String(
                data.id || ""
              );

            this.servers =
              this.servers.filter(
                s => s.id !== id
              );

            await this.saveServers();

            this.send(ws, {
              type:
                "servers",
              servers:
                this.servers
            });

            break;
          }

          case "server_list": {
            if (
              !player ||
              !player.is_admin
            ) {
              return;
            }

            this.send(ws, {
              type:
                "servers",
              servers:
                this.servers
            });

            break;
          }
        }
      }
    );

    ws.addEventListener(
      "close",
      () => {
        if (!player) return;

        this.sessions.delete(ws);

        if (
          !player.id.startsWith(
            "admin-panel-"
          )
        ) {
          this.players.delete(
            player.id
          );

          this.broadcast({
            type:
              "player_leave",

            id:
              player.id
          });

          this.addLog(
            "leave",
            `${player.name} از سرور خارج شد`,
            {
              playerId:
                player.id
            }
          );
        }
      }
    );

    ws.addEventListener(
      "error",
      () => {
        this.sessions.delete(ws);
      }
    );
  }

  async executeCommand(
    command,
    ws
  ) {
    const parts =
      command.split(/\s+/);

    const cmd =
      parts.shift()?.toLowerCase();

    switch (cmd) {

      case "help":
        this.send(ws, {
          type:
            "console_output",

          message:
            "commands: help, players, announce <text>, kick <id>, clearvehicles"
        });

        break;

      case "players":
        this.send(ws, {
          type:
            "console_output",

          message:
            `Players: ${this.players.size}`
        });

        break;

      case "announce": {
        const message =
          parts.join(" ");

        if (!message) {
          this.send(ws, {
            type:
              "console_output",

            message:
              "متن اعلان وارد نشده"
          });

          return;
        }

        this.broadcast({
          type:
            "server_announce",

          message
        });

        this.addLog(
          "announce",
          message
        );

        this.send(ws, {
          type:
            "console_output",

          message:
            "اعلان ارسال شد."
        });

        break;
      }

      case "kick": {
        const id =
          String(parts[0] || "");

        let found = false;

        for (
          const [client, p]
          of this.sessions
        ) {
          if (
            p.id === id &&
            !p.id.startsWith(
              "admin-panel-"
            )
          ) {
            this.send(client, {
              type:
                "kick",
              id,
              reason:
                "Kick by admin"
            });

            try {
              client.close();
            } catch {}

            found = true;
            break;
          }
        }

        this.send(ws, {
          type:
            "console_output",

          message:
            found
              ? "بازیکن Kick شد."
              : "بازیکن پیدا نشد."
        });

        break;
      }

      case "clearvehicles": {
        this.vehicles.clear();

        this.broadcast({
          type:
            "vehicles_clear"
        });

        this.send(ws, {
          type:
            "console_output",

          message:
            "تمام ماشین‌ها پاک شدند."
        });

        break;
      }

      default:
        this.send(ws, {
          type:
            "console_output",

          message:
            `Command not found: ${cmd}`
        });
    }
  }

  send(ws, obj) {
    try {
      ws.send(
        JSON.stringify(obj)
      );
    } catch {}
  }

  broadcast(
    obj,
    exceptId = null
  ) {
    const msg =
      JSON.stringify(obj);

    for (
      const [ws, player]
      of this.sessions
    ) {
      if (
        player.id === exceptId
      ) {
        continue;
      }

      try {
        ws.send(msg);
      } catch {}
    }
  }

  getFullState() {
    const players =
      [...this.players.values()]
        .filter(
          p =>
            !p.id.startsWith(
              "admin-panel-"
            )
        )
        .map(p => ({
          id:
            p.id,

          name:
            p.name,

          job:
            p.job,

          level:
            p.level,

          is_admin:
            p.is_admin,

          x:
            p.x,

          y:
            p.y,

          z:
            p.z,

          rot:
            p.rot
        }));

    const vehicles =
      [...this.vehicles.values()]
        .map(v => ({
          id:
            v.id,

          x:
            v.x,

          y:
            v.y,

          z:
            v.z,

          rot:
            v.rot,

          steering:
            v.steering,

          car_type:
            v.car_type,

          owner_id:
            v.owner_id,

          occupants:
            v.occupants
        }));

    return {
      type:
        "full_state",

      players,

      vehicles
    };
  }
}


/* =========================================
   WORKER ENTRY
========================================= */

export default {
  async fetch(
    request,
    env
  ) {
    const id =
      env.GAME_ROOM.idFromName(
        "main"
      );

    const stub =
      env.GAME_ROOM.get(id);

    return stub.fetch(request);
  }
};


/* =========================================
   ADMIN PANEL
========================================= */

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Poppo Control Center</title>

<style>

:root{
  --bg:#07070c;
  --panel:#101019;
  --panel2:#151522;
  --border:#272738;
  --text:#f4f4fa;
  --muted:#85859b;
  --primary:#8b5cf6;
  --primary2:#6d28d9;
  --green:#22c55e;
  --red:#ef4444;
  --yellow:#f59e0b;
  --cyan:#22d3ee;
  --shadow:0 20px 60px rgba(0,0,0,.35);
}

*{
  box-sizing:border-box;
}

html,
body{
  margin:0;
  min-height:100%;
}

body{
  font-family:
    Tahoma,
    Arial,
    system-ui,
    sans-serif;

  background:
    radial-gradient(
      circle at top right,
      rgba(139,92,246,.16),
      transparent 32%
    ),
    radial-gradient(
      circle at bottom left,
      rgba(34,211,238,.08),
      transparent 30%
    ),
    var(--bg);

  color:var(--text);
}

button,
input,
select{
  font:inherit;
}

button{
  cursor:pointer;
}

.app{
  min-height:100vh;
  display:flex;
}

/* SIDEBAR */

.sidebar{
  width:260px;
  background:
    rgba(10,10,17,.92);

  border-left:
    1px solid var(--border);

  padding:22px 16px;

  position:fixed;
  right:0;
  top:0;
  bottom:0;

  z-index:20;

  backdrop-filter:
    blur(18px);
}

.brand{
  display:flex;
  align-items:center;
  gap:12px;

  padding:
    8px 10px 22px;

  border-bottom:
    1px solid var(--border);

  margin-bottom:18px;
}

.logo{
  width:42px;
  height:42px;

  display:grid;
  place-items:center;

  border-radius:13px;

  background:
    linear-gradient(
      135deg,
      var(--primary),
      #4f46e5
    );

  box-shadow:
    0 10px 35px
    rgba(139,92,246,.3);

  font-weight:900;
}

.brand strong{
  display:block;
  font-size:15px;
}

.brand small{
  color:var(--muted);
  font-size:11px;
}

.nav{
  display:grid;
  gap:7px;
}

.nav button{
  border:0;
  color:#aaaabd;
  background:transparent;

  text-align:right;

  padding:
    12px 13px;

  border-radius:11px;

  transition:.18s;
}

.nav button:hover,
.nav button.active{
  color:#fff;

  background:
    linear-gradient(
      90deg,
      rgba(139,92,246,.25),
      rgba(139,92,246,.08)
    );
}

.sidebar-bottom{
  position:absolute;
  bottom:20px;
  left:16px;
  right:16px;
}

.connection{
  padding:13px;

  border:
    1px solid var(--border);

  border-radius:13px;

  background:
    rgba(255,255,255,.025);
}

.connection-title{
  font-size:11px;
  color:var(--muted);
  margin-bottom:7px;
}

.connection-status{
  display:flex;
  align-items:center;
  gap:8px;
  font-size:12px;
}

.dot{
  width:8px;
  height:8px;
  border-radius:50%;
  background:var(--red);
}

.dot.online{
  background:var(--green);
  box-shadow:
    0 0 12px var(--green);
}

/* MAIN */

.main{
  width:
    calc(100% - 260px);

  margin-right:260px;

  padding:25px;

  min-height:100vh;
}

.topbar{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:20px;

  margin-bottom:24px;
}

.page-title h1{
  margin:0 0 5px;
  font-size:25px;
}

.page-title p{
  margin:0;
  color:var(--muted);
  font-size:12px;
}

.top-actions{
  display:flex;
  gap:8px;
}

/* BUTTON */

.btn{
  border:0;
  border-radius:10px;

  padding:
    10px 14px;

  color:white;

  background:
    var(--primary);

  transition:.18s;
}

.btn:hover{
  transform:translateY(-1px);
  filter:brightness(1.1);
}

.btn.secondary{
  background:#222231;
}

.btn.green{
  background:
    #15803d;
}

.btn.red{
  background:
    #b91c1c;
}

.btn.yellow{
  background:
    #b45309;
}

/* SECTIONS */

.section{
  display:none;
}

.section.active{
  display:block;
}

/* STATS */

.stats{
  display:grid;

  grid-template-columns:
    repeat(4,minmax(0,1fr));

  gap:13px;

  margin-bottom:15px;
}

.stat{
  background:
    linear-gradient(
      145deg,
      rgba(255,255,255,.045),
      rgba(255,255,255,.018)
    );

  border:
    1px solid var(--border);

  border-radius:16px;

  padding:17px;

  box-shadow:
    var(--shadow);
}

.stat-top{
  display:flex;
  justify-content:space-between;
  align-items:center;
}

.stat-label{
  color:var(--muted);
  font-size:12px;
}

.stat-icon{
  width:32px;
  height:32px;
  display:grid;
  place-items:center;
  border-radius:9px;
  background:
    rgba(139,92,246,.13);
}

.stat-value{
  margin-top:10px;
  font-size:27px;
  font-weight:800;
}

/* GRID */

.grid{
  display:grid;

  grid-template-columns:
    minmax(0,2fr)
    minmax(280px,1fr);

  gap:15px;

  margin-bottom:15px;
}

.card{
  background:
    rgba(16,16,25,.84);

  border:
    1px solid var(--border);

  border-radius:16px;

  padding:17px;

  box-shadow:
    var(--shadow);
}

.card-title{
  display:flex;
  align-items:center;
  justify-content:space-between;

  margin-bottom:14px;
}

.card-title h2{
  font-size:14px;
  margin:0;
}

.card-title span{
  font-size:11px;
  color:var(--muted);
}

/* SERVER */

.server-address{
  display:flex;
  align-items:center;
  gap:8px;
}

.server-address input{
  flex:1;
}

input,
select{
  width:100%;

  border:
    1px solid var(--border);

  background:#0b0b12;

  color:#fff;

  border-radius:10px;

  padding:
    10px 12px;

  outline:none;
}

input:focus,
select:focus{
  border-color:
    var(--primary);
}

.form-grid{
  display:grid;
  grid-template-columns:
    1fr 1fr;
  gap:10px;
}

.form-row{
  margin-bottom:10px;
}

.form-row label{
  display:block;
  color:var(--muted);
  font-size:11px;
  margin-bottom:6px;
}

/* TABLE */

.table-wrap{
  overflow-x:auto;
}

table{
  width:100%;
  border-collapse:collapse;
}

th,
td{
  padding:
    11px 9px;

  border-bottom:
    1px solid var(--border);

  text-align:right;

  font-size:12px;

  white-space:nowrap;
}

th{
  color:var(--muted);
  font-weight:500;
}

.badge{
  display:inline-flex;

  padding:
    4px 8px;

  border-radius:999px;

  font-size:10px;

  background:
    rgba(34,197,94,.1);

  color:
    #86efac;
}

.badge.admin{
  color:#c4b5fd;
  background:
    rgba(139,92,246,.12);
}

/* CONSOLE */

.console{
  background:#050509;

  border:
    1px solid #20202b;

  border-radius:12px;

  height:380px;

  display:flex;
  flex-direction:column;

  overflow:hidden;
}

.console-output{
  flex:1;

  overflow-y:auto;

  padding:13px;

  font-family:
    "Courier New",
    monospace;

  font-size:12px;

  line-height:1.8;

  direction:ltr;

  text-align:left;
}

.console-line{
  color:#a5b4fc;
}

.console-line.system{
  color:#94a3b8;
}

.console-line.error{
  color:#fca5a5;
}

.console-line.success{
  color:#86efac;
}

.console-input{
  display:flex;

  border-top:
    1px solid #20202b;
}

.console-input input{
  border:0;
  border-radius:0;

  direction:ltr;
  text-align:left;
}

.console-input button{
  border:0;
  width:90px;

  color:#fff;

  background:
    var(--primary);
}

/* LOG */

.logs{
  height:330px;
  overflow-y:auto;
}

.log-item{
  display:flex;
  gap:10px;

  padding:
    9px 0;

  border-bottom:
    1px solid var(--border);

  font-size:11px;
}

.log-time{
  color:#66667a;
  min-width:70px;
}

.log-type{
  color:#a78bfa;
  min-width:65px;
}

.log-message{
  color:#c9c9d5;
}

/* SERVER LIST */

.server-list{
  display:grid;
  gap:10px;
}

.server-item{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;

  padding:13px;

  background:#0c0c13;

  border:
    1px solid var(--border);

  border-radius:12px;
}

.server-info strong{
  display:block;
  font-size:13px;
}

.server-info span{
  display:block;
  color:var(--muted);
  font-size:10px;
  margin-top:4px;
  direction:ltr;
  text-align:right;
}

.server-actions{
  display:flex;
  gap:5px;
}

/* EMPTY */

.empty{
  color:var(--muted);
  text-align:center;
  padding:35px 10px;
  font-size:12px;
}

/* MOBILE */

.mobile-menu{
  display:none;
}

@media(max-width:900px){

  .sidebar{
    transform:
      translateX(100%);
    transition:.2s;
  }

  .sidebar.open{
    transform:
      translateX(0);
  }

  .main{
    width:100%;
    margin-right:0;
    padding:15px;
  }

  .mobile-menu{
    display:block;
  }

  .stats{
    grid-template-columns:
      repeat(2,1fr);
  }

  .grid{
    grid-template-columns:1fr;
  }

  .topbar{
    align-items:flex-start;
  }
}

@media(max-width:520px){

  .stats{
    grid-template-columns:1fr 1fr;
  }

  .form-grid{
    grid-template-columns:1fr;
  }

  .top-actions{
    flex-wrap:wrap;
  }

  .page-title h1{
    font-size:20px;
  }
}

</style>
</head>

<body>

<div class="app">

<aside class="sidebar" id="sidebar">

  <div class="brand">
    <div class="logo">P</div>
    <div>
      <strong>POPPO</strong>
      <small>Multiplayer Control</small>
    </div>
  </div>

  <div class="nav">

    <button
      class="active"
      data-page="dashboard">
      ◈ داشبورد
    </button>

    <button
      data-page="players">
      ◉ بازیکنان
    </button>

    <button
      data-page="servers">
      ◈ سرورها
    </button>

    <button
      data-page="console">
      ▣ کنسول
    </button>

    <button
      data-page="logs">
      ≡ لاگ سیستم
    </button>

  </div>

  <div class="sidebar-bottom">

    <div class="connection">

      <div class="connection-title">
        وضعیت ارتباط
      </div>

      <div class="connection-status">
        <span
          class="dot"
          id="sideDot">
        </span>

        <span id="sideStatus">
          قطع
        </span>
      </div>

    </div>

  </div>

</aside>


<main class="main">

  <header class="topbar">

    <div class="page-title">

      <h1 id="pageTitle">
        داشبورد
      </h1>

      <p>
        مدیریت کامل سرور Multiplayer
      </p>

    </div>

    <div class="top-actions">

      <button
        class="btn secondary mobile-menu"
        onclick="toggleSidebar()">
        ☰
      </button>

      <button
        class="btn green"
        onclick="connect()">
        اتصال
      </button>

      <button
        class="btn red"
        onclick="disconnect()">
        قطع
      </button>

    </div>

  </header>


  <!-- DASHBOARD -->

  <section
    class="section active"
    id="dashboard">

    <div class="stats">

      <div class="stat">
        <div class="stat-top">
          <span class="stat-label">
            بازیکنان آنلاین
          </span>
          <span class="stat-icon">
            ◉
          </span>
        </div>

        <div
          class="stat-value"
          id="playerCount">
          0
        </div>
      </div>


      <div class="stat">
        <div class="stat-top">
          <span class="stat-label">
            ماشین‌ها
          </span>
          <span class="stat-icon">
            🚗
          </span>
        </div>

        <div
          class="stat-value"
          id="vehicleCount">
          0
        </div>
      </div>


      <div class="stat">
        <div class="stat-top">
          <span class="stat-label">
            سرورهای ثبت‌شده
          </span>
          <span class="stat-icon">
            ◈
          </span>
        </div>

        <div
          class="stat-value"
          id="serverCount">
          0
        </div>
      </div>


      <div class="stat">
        <div class="stat-top">
          <span class="stat-label">
            نسخه
          </span>
          <span class="stat-icon">
            #
          </span>
        </div>

        <div
          class="stat-value"
          id="version">
          2.0
        </div>
      </div>

    </div>


    <div class="grid">

      <div class="card">

        <div class="card-title">

          <h2>
            آدرس سرور
          </h2>

          <span id="serverStatus">
            Offline
          </span>

        </div>

        <div class="server-address">

          <input
            id="currentAddress"
            readonly
            value="در حال دریافت...">

          <button
            class="btn"
            onclick="copyAddress()">
            کپی
          </button>

        </div>

      </div>


      <div class="card">

        <div class="card-title">

          <h2>
            وضعیت WebSocket
          </h2>

          <span>
            Real-time
          </span>

        </div>

        <div
          style="
          display:flex;
          align-items:center;
          gap:10px;
          padding:12px 0;
          ">

          <span
            class="dot"
            id="mainDot">
          </span>

          <strong
            id="mainStatus">
            قطع
          </strong>

        </div>

      </div>

    </div>


    <div class="grid">

      <div class="card">

        <div class="card-title">

          <h2>
            بازیکنان اخیر
          </h2>

          <button
            class="btn secondary"
            onclick="go('players')">
            مشاهده همه
          </button>

        </div>

        <div
          class="table-wrap">

          <table>

            <thead>
              <tr>
                <th>نام</th>
                <th>ID</th>
                <th>لول</th>
                <th>وضعیت</th>
              </tr>
            </thead>

            <tbody
              id="dashboardPlayers">
            </tbody>

          </table>

        </div>

      </div>


      <div class="card">

        <div class="card-title">

          <h2>
            رویدادهای اخیر
          </h2>

        </div>

        <div
          class="logs"
          id="dashboardLogs">
        </div>

      </div>

    </div>

  </section>


  <!-- PLAYERS -->

  <section
    class="section"
    id="players">

    <div class="card">

      <div class="card-title">

        <h2>
          مدیریت بازیکنان
        </h2>

        <span id="playerTableCount">
          0 بازیکن
        </span>

      </div>

      <div class="table-wrap">

        <table>

          <thead>
            <tr>
              <th>نام</th>
              <th>شناسه</th>
              <th>شغل</th>
              <th>لول</th>
              <th>ادمین</th>
              <th>موقعیت</th>
              <th>عملیات</th>
            </tr>
          </thead>

          <tbody
            id="playersTable">
          </tbody>

        </table>

      </div>

    </div>


    <div
      class="grid"
      style="margin-top:15px">

      <div class="card">

        <div class="card-title">
          <h2>بن بازیکن</h2>
        </div>

        <div class="form-row">
          <label>
            شناسه بازیکن
          </label>

          <input
            id="banId"
            placeholder="Player ID">
        </div>

        <div class="form-grid">

          <div class="form-row">

            <label>
              مدت
            </label>

            <select id="banDuration">

              <option value="86400">
                ۱ روز
              </option>

              <option value="259200">
                ۳ روز
              </option>

              <option value="604800">
                ۱ هفته
              </option>

              <option value="2592000">
                ۱ ماه
              </option>

              <option value="-1">
                دائمی
              </option>

            </select>

          </div>

          <div class="form-row">

            <label>
              دلیل
            </label>

            <input
              id="banReason"
              value="بن از پنل ادمین">

          </div>

        </div>

        <button
          class="btn red"
          onclick="banPlayer()">
          🚫 بن کردن
        </button>

      </div>


      <div class="card">

        <div class="card-title">
          <h2>ماشین‌ها</h2>
          <span id="vehicleCount2">0</span>
        </div>

        <button
          class="btn red"
          onclick="clearVehicles()">
          پاک کردن تمام ماشین‌ها
        </button>

      </div>

    </div>

  </section>


  <!-- SERVERS -->

  <section
    class="section"
    id="servers">

    <div class="grid">

      <div class="card">

        <div class="card-title">
          <h2>
            ثبت سرور جدید
          </h2>

          <span>
            Server Registry
          </span>
        </div>

        <div class="form-row">

          <label>
            نام سرور
          </label>

          <input
            id="newServerName"
            placeholder="Poppo RP">

        </div>

        <div class="form-row">

          <label>
            آدرس سرور
          </label>

          <input
            id="newServerAddress"
            placeholder="wss://example.workers.dev">

        </div>

        <button
          class="btn"
          onclick="addServer()">
          + ثبت سرور
        </button>

      </div>


      <div class="card">

        <div class="card-title">
          <h2>
            سرور فعلی
          </h2>
        </div>

        <input
          id="activeServerAddress"
          readonly>

        <button
          class="btn secondary"
          style="margin-top:10px"
          onclick="copyActiveServer()">
          کپی آدرس
        </button>

      </div>

    </div>


    <div class="card">

      <div class="card-title">

        <h2>
          سرورهای ثبت‌شده
        </h2>

        <span>
          Registry
        </span>

      </div>

      <div
        class="server-list"
        id="serverList">
      </div>

    </div>

  </section>


  <!-- CONSOLE -->

  <section
    class="section"
    id="console">

    <div class="card">

      <div class="card-title">

        <h2>
          کنسول زنده سرور
        </h2>

        <span>
          Live Console
        </span>

      </div>

      <div class="console">

        <div
          class="console-output"
          id="consoleOutput">

          <div
            class="console-line system">
            Poppo Control Console v2.0
          </div>

          <div
            class="console-line system">
            Type "help" for commands.
          </div>

        </div>

        <div class="console-input">

          <input
            id="consoleInput"
            placeholder="announce Hello World"
            onkeydown="
            if(event.key==='Enter')
            sendCommand()
            ">

          <button
            onclick="sendCommand()">
            اجرا
          </button>

        </div>

      </div>

    </div>


    <div
      class="grid"
      style="margin-top:15px">

      <div class="card">

        <div class="card-title">
          <h2>
            دستورات سریع
          </h2>
        </div>

        <div
          style="
          display:grid;
          grid-template-columns:
          repeat(2,1fr);
          gap:8px;
          ">

          <button
            class="btn secondary"
            onclick="quickCommand('help')">
            help
          </button>

          <button
            class="btn secondary"
            onclick="quickCommand('players')">
            players
          </button>

          <button
            class="btn secondary"
            onclick="
            quickCommand(
            'clearvehicles'
            )">
            clearvehicles
          </button>

        </div>

      </div>

      <div class="card">

        <div class="card-title">
          <h2>
            ارسال اعلان
          </h2>
        </div>

        <input
          id="announceText"
          placeholder="متن اعلان...">

        <button
          class="btn"
          style="margin-top:8px"
          onclick="announce()">
          ارسال اعلان
        </button>

      </div>

    </div>

  </section>


  <!-- LOGS -->

  <section
    class="section"
    id="logs">

    <div class="card">

      <div class="card-title">

        <h2>
          لاگ سیستم
        </h2>

        <button
          class="btn secondary"
          onclick="clearLocalLogs()">
          پاک کردن نمایش
        </button>

      </div>

      <div
        class="logs"
        id="allLogs">
      </div>

    </div>

  </section>

</main>

</div>


<script>

let ws = null;

let players = [];

let vehicles = [];

let servers = [];

let logs = [];

let reconnectTimer = null;

let manuallyDisconnected = false;


/* =========================
   NAVIGATION
========================= */

const pageNames = {
  dashboard:"داشبورد",
  players:"بازیکنان",
  servers:"سرورها",
  console:"کنسول",
  logs:"لاگ سیستم"
};

function go(page){

  document
    .querySelectorAll(".section")
    .forEach(
      s => s.classList.remove("active")
    );

  document
    .querySelectorAll(".nav button")
    .forEach(
      b => b.classList.remove("active")
    );

  document
    .getElementById(page)
    ?.classList.add("active");

  document
    .querySelector(
      '[data-page="'+page+'"]'
    )
    ?.classList.add("active");

  document
    .getElementById("pageTitle")
    .textContent =
    pageNames[page] || page;

  if(
    window.innerWidth <= 900
  ){
    document
      .getElementById("sidebar")
      .classList.remove("open");
  }
}

document
  .querySelectorAll(".nav button")
  .forEach(btn => {

    btn.addEventListener(
      "click",
      () => go(btn.dataset.page)
    );

  });


function toggleSidebar(){

  document
    .getElementById("sidebar")
    .classList.toggle("open");

}


/* =========================
   CONNECTION
========================= */

function connect(){

  manuallyDisconnected = false;

  if(
    ws &&
    (
      ws.readyState ===
      WebSocket.OPEN ||

      ws.readyState ===
      WebSocket.CONNECTING
    )
  ){
    return;
  }

  const protocol =
    location.protocol ===
    "https:"
      ? "wss://"
      : "ws://";

  const url =
    protocol +
    location.host;

  writeConsole(
    "Connecting to " + url,
    "system"
  );

  ws =
    new WebSocket(url);

  ws.onopen = () => {

    setConnection(true);

    writeConsole(
      "WebSocket connected.",
      "success"
    );

    const key =
      prompt(
        "کلید ADMIN_KEY را وارد کنید:"
      );

    if(!key){

      writeConsole(
        "Admin key وارد نشد.",
        "error"
      );

      disconnect();

      return;
    }

    ws.send(
      JSON.stringify({
        type:
          "panel_auth",

        key
      })
    );

  };


  ws.onmessage = event => {

    let d;

    try{
      d =
        JSON.parse(event.data);
    }catch{
      return;
    }

    handleMessage(d);

  };


  ws.onclose = () => {

    setConnection(false);

    writeConsole(
      "WebSocket disconnected.",
      "error"
    );

    if(
      !manuallyDisconnected
    ){

      clearTimeout(
        reconnectTimer
      );

      reconnectTimer =
        setTimeout(
          connect,
          5000
        );

    }

  };


  ws.onerror = () => {

    writeConsole(
      "WebSocket error.",
      "error"
    );

  };

}


function disconnect(){

  manuallyDisconnected = true;

  clearTimeout(
    reconnectTimer
  );

  if(ws){

    try{
      ws.close();
    }catch{}

  }

  setConnection(false);

}


function setConnection(on){

  const dots =
    [
      document.getElementById(
        "sideDot"
      ),

      document.getElementById(
        "mainDot"
      )
    ];

  dots.forEach(
    d =>
      d.classList.toggle(
        "online",
        on
      )
  );

  document
    .getElementById(
      "sideStatus"
    )
    .textContent =
    on
      ? "متصل"
      : "قطع";

  document
    .getElementById(
      "mainStatus"
    )
    .textContent =
    on
      ? "متصل"
      : "قطع";

  document
    .getElementById(
      "serverStatus"
    )
    .textContent =
    on
      ? "Online"
      : "Offline";

}


/* =========================
   MESSAGE HANDLER
========================= */

function handleMessage(d){

  if(
    d.type ===
    "panel_auth_ok"
  ){

    writeConsole(
      "Admin authentication successful.",
      "success"
    );

    if(d.version){

      document
        .getElementById(
          "version"
        )
        .textContent =
        d.version;

    }

    request("admin_list");

    request("server_list");

  }


  if(
    d.type ===
    "panel_auth_failed"
  ){

    writeConsole(
      d.message ||
      "Authentication failed.",
      "error"
    );

  }


  if(
    d.type ===
    "full_state"
  ){

    players =
      d.players || [];

    vehicles =
      d.vehicles || [];

    renderAll();

  }


  if(
    d.type ===
    "admin_list"
  ){

    players =
      d.players || [];

    renderAll();

  }


  if(
    d.type ===
    "player_join"
  ){

    if(
      !players.some(
        p => p.id === d.id
      )
    ){

      players.push(d);

    }

    addLog(
      "join",
      d.name +
      " وارد سرور شد"
    );

    renderAll();

  }


  if(
    d.type ===
    "player_leave"
  ){

    players =
      players.filter(
        p => p.id !== d.id
      );

    addLog(
      "leave",
      d.id +
      " خارج شد"
    );

    renderAll();

  }


  if(
    d.type ===
    "chat"
  ){

    addLog(
      "chat",
      d.name +
      ": " +
      d.message
    );

  }


  if(
    d.type ===
    "ban"
  ){

    addLog(
      "ban",
      "Ban: " +
      d.id +
      " | " +
      d.reason
    );

    writeConsole(
      "Player banned: " +
      d.id,
      "error"
    );

  }


  if(
    d.type ===
    "servers"
  ){

    servers =
      d.servers || [];

    renderServers();

  }


  if(
    d.type ===
    "console_output"
  ){

    writeConsole(
      d.message
    );

  }


  if(
    d.type ===
    "server_announce"
  ){

    addLog(
      "announce",
      d.message
    );

  }


  if(
    d.type ===
    "vehicles_clear"
  ){

    vehicles = [];

    renderAll();

  }

}


/* =========================
   SEND
========================= */

function request(type, data={}){

  if(
    !ws ||
    ws.readyState !==
    WebSocket.OPEN
  ){

    writeConsole(
      "WebSocket is not connected.",
      "error"
    );

    return;
  }

  ws.send(
    JSON.stringify({
      type,
      ...data
    })
  );

}


/* =========================
   PLAYERS
========================= */

function renderPlayers(){

  const tbody =
    document.getElementById(
      "playersTable"
    );

  const dashboard =
    document.getElementById(
      "dashboardPlayers"
    );

  document
    .getElementById(
      "playerTableCount"
    )
    .textContent =
    players.length +
    " بازیکن";


  if(!players.length){

    tbody.innerHTML =
      '<tr><td colspan="7" class="empty">بازیکنی آنلاین نیست</td></tr>';

    dashboard.innerHTML =
      '<tr><td colspan="4" class="empty">بازیکنی آنلاین نیست</td></tr>';

    return;

  }


  tbody.innerHTML =
    players.map(p => `

      <tr>

        <td>
          ${escapeHtml(
            p.name || "-"
          )}
        </td>

        <td
          style="
          direction:ltr;
          user-select:all;
          font-family:monospace">
          ${escapeHtml(
            p.id
          )}
        </td>

        <td>
          ${escapeHtml(
            p.job || "-"
          )}
        </td>

        <td>
          ${p.level || 0}
        </td>

        <td>
          ${
            p.is_admin
              ? '<span class="badge admin">ADMIN</span>'
              : "-"
          }
        </td>

        <td
          style="
          direction:ltr;
          font-family:monospace">
          ${Number(p.x || 0).toFixed(1)},
          ${Number(p.y || 0).toFixed(1)},
          ${Number(p.z || 0).toFixed(1)}
        </td>

        <td>

          <button
            class="btn red"
            style="
            padding:5px 8px;
            font-size:10px"
            onclick="
            quickBan(
              '${escapeAttr(p.id)}'
            )">

            بن

          </button>

        </td>

      </tr>

    `).join("");


  dashboard.innerHTML =
    players
      .slice(0,5)
      .map(p => `

        <tr>

          <td>
            ${escapeHtml(
              p.name || "-"
            )}
          </td>

          <td
            style="
            direction:ltr;
            font-family:monospace">

            ${escapeHtml(
              String(p.id)
                .slice(0,16)
            )}

          </td>

          <td>
            ${p.level || 0}
          </td>

          <td>
            <span class="badge">
              آنلاین
            </span>
          </td>

        </tr>

      `).join("");

}


function quickBan(id){

  document
    .getElementById(
      "banId"
    )
    .value = id;

  go("players");

  document
    .getElementById(
      "banId"
    )
    .focus();

}


function banPlayer(){

  const id =
    document
      .getElementById(
        "banId"
      )
      .value
      .trim();

  const duration =
    Number(
      document
        .getElementById(
          "banDuration"
        )
        .value
    );

  const reason =
    document
      .getElementById(
        "banReason"
      )
      .value
      .trim() ||
    "بن از پنل ادمین";


  if(!id){

    alert(
      "شناسه بازیکن را وارد کنید."
    );

    return;

  }


  request(
    "ban",
    {
      id,
      duration,
      reason
    }
  );

}


function clearVehicles(){

  if(
    !confirm(
      "تمام ماشین‌های سرور پاک شوند؟"
    )
  ){
    return;
  }

  request(
    "console",
    {
      command:
        "clearvehicles"
    }
  );

}


/* =========================
   SERVERS
========================= */

function addServer(){

  const name =
    document
      .getElementById(
        "newServerName"
      )
      .value
      .trim();

  const address =
    document
      .getElementById(
        "newServerAddress"
      )
      .value
      .trim();


  if(!name || !address){

    alert(
      "نام و آدرس سرور را وارد کنید."
    );

    return;

  }


  request(
    "server_add",
    {
      name,
      address
    }
  );

  document
    .getElementById(
      "newServerName"
    )
    .value = "";

  document
    .getElementById(
      "newServerAddress"
    )
    .value = "";

}


function renderServers(){

  document
    .getElementById(
      "serverCount"
    )
    .textContent =
    servers.length;


  const list =
    document.getElementById(
      "serverList"
    );


  if(!servers.length){

    list.innerHTML =
      '<div class="empty">هنوز سروری ثبت نشده است.</div>';

    return;

  }


  list.innerHTML =
    servers.map(s => `

      <div class="server-item">

        <div class="server-info">

          <strong>
            ${escapeHtml(
              s.name
            )}
          </strong>

          <span>
            ${escapeHtml(
              s.address
            )}
          </span>

        </div>

        <div class="server-actions">

          <button
            class="btn secondary"
            style="
            padding:6px 9px;
            font-size:10px"
            onclick="
            selectServer(
              '${escapeAttr(
                s.address
              )}'
            )">

            انتخاب

          </button>

          <button
            class="btn red"
            style="
            padding:6px 9px;
            font-size:10px"
            onclick="
            deleteServer(
              '${escapeAttr(
                s.id
              )}'
            )">

            حذف

          </button>

        </div>

      </div>

    `).join("");

}


function selectServer(address){

  document
    .getElementById(
      "currentAddress"
    )
    .value =
    address;

  document
    .getElementById(
      "activeServerAddress"
    )
    .value =
    address;

  localStorage
    .setItem(
      "poppo_active_server",
      address
    );

}


function deleteServer(id){

  if(
    !confirm(
      "این سرور حذف شود؟"
    )
  ){
    return;
  }

  request(
    "server_delete",
    { id }
  );

}


/* =========================
   CONSOLE
========================= */

function sendCommand(){

  const input =
    document
      .getElementById(
        "consoleInput"
      );

  const command =
    input.value.trim();

  if(!command) return;

  writeConsole(
    "> " + command
  );

  request(
    "console",
    { command }
  );

  input.value = "";

}


function quickCommand(command){

  document
    .getElementById(
      "consoleInput"
    )
    .value =
    command;

  sendCommand();

}


function announce(){

  const input =
    document
      .getElementById(
        "announceText"
      );

  const message =
    input.value.trim();

  if(!message) return;

  quickCommand(
    "announce " +
    message
  );

  input.value = "";

}


function writeConsole(
  message,
  type=""
){

  const output =
    document.getElementById(
      "consoleOutput"
    );

  const line =
    document.createElement(
      "div"
    );

  line.className =
    "console-line " +
    type;

  line.textContent =
    "[" +
    new Date()
      .toLocaleTimeString(
        "fa-IR"
      ) +
    "] " +
    message;

  output.appendChild(
    line
  );

  output.scrollTop =
    output.scrollHeight;

}


/* =========================
   LOGS
========================= */

function addLog(
  type,
  message
){

  logs.unshift({

    type,

    message,

    time:
      Date.now()

  });

  if(
    logs.length > 200
  ){
    logs.pop();
  }

  renderLogs();

}


function renderLogs(){

  const html =
    logs.map(l => `

      <div class="log-item">

        <div class="log-time">
          ${new Date(
            l.time
          ).toLocaleTimeString(
            "fa-IR"
          )}
        </div>

        <div class="log-type">
          ${escapeHtml(
            l.type
          )}
        </div>

        <div class="log-message">
          ${escapeHtml(
            l.message
          )}
        </div>

      </div>

    `).join("");


  document
    .getElementById(
      "allLogs"
    )
    .innerHTML =
    html ||
    '<div class="empty">لاگی وجود ندارد.</div>';

  document
    .getElementById(
      "dashboardLogs"
    )
    .innerHTML =
    logs
      .slice(0,7)
      .map(l => `

        <div class="log-item">

          <div class="log-time">
            ${new Date(
              l.time
            ).toLocaleTimeString(
              "fa-IR"
            )}
          </div>

          <div class="log-message">
            ${escapeHtml(
              l.message
            )}
          </div>

        </div>

      `).join("");

}


function clearLocalLogs(){

  logs = [];

  renderLogs();

}


/* =========================
   RENDER
========================= */

function renderAll(){

  document
    .getElementById(
      "playerCount"
    )
    .textContent =
    players.length;

  document
    .getElementById(
      "vehicleCount"
    )
    .textContent =
    vehicles.length;

  document
    .getElementById(
      "vehicleCount2"
    )
    .textContent =
    vehicles.length;

  renderPlayers();

  renderServers();

}


/* =========================
   COPY
========================= */

async function copyAddress(){

  const value =
    document
      .getElementById(
        "currentAddress"
      )
      .value;

  if(!value) return;

  try{

    await navigator.clipboard
      .writeText(value);

    writeConsole(
      "Server address copied.",
      "success"
    );

  }catch{

    alert(value);

  }

}


async function copyActiveServer(){

  const value =
    document
      .getElementById(
        "activeServerAddress"
      )
      .value;

  if(!value) return;

  try{

    await navigator.clipboard
      .writeText(value);

  }catch{

    alert(value);

  }

}


/* =========================
   SECURITY HELPERS
========================= */

function escapeHtml(value){

  return String(value)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");

}


function escapeAttr(value){

  return String(value)
    .replaceAll("\\","\\\\")
    .replaceAll("'","\\\\'");

}


/* =========================
   INIT
========================= */

document
  .getElementById(
    "currentAddress"
  )
  .value =
  location.origin
    .replace(
      /^http/,
      "ws"
    );

document
  .getElementById(
    "activeServerAddress"
  )
  .value =
  location.origin
    .replace(
      /^http/,
      "ws"
    );


const savedServer =
  localStorage.getItem(
    "poppo_active_server"
  );

if(savedServer){

  selectServer(
    savedServer
  );

}

renderLogs();

</script>

</body>
</html>`;
