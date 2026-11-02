"use strict";
/* Par ou Ímpar online — servidor sem dependências (Node 18+).
   Serve public/index.html e fala WebSocket em /ws. */
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = process.env.PORT || 3000, GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const GRACE = 20000, ASK = 25000, SPEED = Number(process.env.PI_TIMING || 1); // PI_TIMING só para testes

/* ---------- WebSocket mínimo (texto) ---------- */
const conns = new Set();
function upgrade(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return null; }
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
    crypto.createHash("sha1").update(key + GUID).digest("base64") + "\r\n\r\n");
  socket.setNoDelay(true);
  const conn = { open: true, alive: true, P: null, onmessage: null, onclose: null };
  let buf = Buffer.alloc(0), frag = [];
  function write(op, payload) {
    if (!conn.open) return;
    const len = payload.length; let head;
    if (len < 126) head = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    socket.write(Buffer.concat([head, payload]));
  }
  conn.send = (o) => write(1, Buffer.from(JSON.stringify(o)));
  conn.ping = () => write(9, Buffer.alloc(0));
  conn.close = () => { if (conn.open) { write(8, Buffer.alloc(0)); socket.end(); } };
  conn.kill = () => socket.destroy();
  function finish() {
    if (!conn.open) return;
    conn.open = false; conns.delete(conn);
    if (conn.onclose) conn.onclose();
  }
  socket.on("close", finish); socket.on("error", finish);
  socket.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const b0 = buf[0], b1 = buf[1], fin = !!(b0 & 0x80), op = b0 & 15;
      let len = b1 & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 16384 || !(b1 & 0x80)) { socket.destroy(); return; }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4), data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      conn.alive = true;
      if (op === 8) { conn.close(); return; }
      if (op === 9) { write(10, data); continue; }
      if (op === 10) continue;
      frag.push(data);
      if (fin) { const txt = Buffer.concat(frag).toString("utf8"); frag = []; if (conn.onmessage) conn.onmessage(txt); }
    }
  });
  conns.add(conn);
  return conn;
}
setInterval(() => { conns.forEach((c) => { if (!c.alive) return c.kill(); c.alive = false; c.ping(); }); }, 25000);

/* ---------- Jogadores e sala ---------- */
const players = new Map();
let nextId = 1;
const online = (p) => !!(p.conn && p.conn.open);
const send = (p, o) => { if (online(p)) p.conn.send(o); };
const free = (p) => { if (!p.match) p.st = "free"; };
function lobby() {
  const list = [...players.values()].filter(online).map((p) => ({ id: p.id, name: p.name, st: p.st }));
  players.forEach((p) => send(p, { t: "lobby", players: list.filter((x) => x.id !== p.id) }));
}

/* ---------- Desafios ---------- */
function ask(C, toId) {
  const T = players.get(toId);
  if (!T || T === C || !online(T) || T.st !== "free" || C.st !== "free") { send(C, { t: "toast", msg: "Esse jogador não está disponível." }); return; }
  C.st = T.st = "busy"; T.inc = C.id;
  C.out = { to: T.id, timer: setTimeout(() => {
    const t = players.get(C.out && C.out.to); const nm = t ? t.name : "O jogador";
    endAsk(C, true); send(C, { t: "waitEnd", msg: nm + " não respondeu." }); lobby();
  }, ASK) };
  send(C, { t: "waiting", name: T.name }); send(T, { t: "incoming", name: C.name }); lobby();
}
function endAsk(C, tellTarget) {
  if (!C.out) return;
  clearTimeout(C.out.timer);
  const T = players.get(C.out.to); C.out = null; free(C);
  if (T && T.inc === C.id) { T.inc = null; free(T); if (tellTarget) send(T, { t: "incomingEnd", msg: C.name + " cancelou o desafio." }); }
}
function respond(T, ok) {
  const C = players.get(T.inc);
  T.inc = null;
  if (!C || !C.out || C.out.to !== T.id) { free(T); return; }
  clearTimeout(C.out.timer); C.out = null;
  send(C, { t: "waitEnd" }); send(T, { t: "incomingEnd" });
  if (ok) startMatch(C, T);
  else { free(C); free(T); send(C, { t: "waitEnd", msg: T.name + " recusou o desafio." }); lobby(); }
}
function dropChallenges(P, reason) {
  if (P.out) { endAsk(P, true); }
  if (P.inc) {
    const C = players.get(P.inc); P.inc = null;
    if (C && C.out) { clearTimeout(C.out.timer); C.out = null; free(C); send(C, { t: "waitEnd", msg: P.name + " " + reason + "." }); }
  }
  free(P);
}

/* ---------- Partida (a lógica fica toda aqui, no servidor) ---------- */
function startMatch(C, T) {
  const m = { p: [C, T], alive: true, timers: [], sid: 0, v: 0 };
  C.match = T.match = m; C.st = T.st = "busy";
  startSeries(m, 3); lobby();
}
function later(m, ms, fn) { m.timers.push(setTimeout(() => { if (m.alive) fn(); }, ms * SPEED)); }
function view(m, i) {
  const o = m.p[1 - i];
  return { me: i, opp: o.name, oppOn: online(o), sid: m.sid, st: m.st, n: m.n, sc: m.sc, rd: m.rd, toss: m.toss, tw: m.tw, ch: m.ch,
    pk: m.pk, who: [m.nums[0] != null, m.nums[1] != null], my: m.nums[i], rv: m.rv, fin: m.fin, sw: m.sw, rq: m.rq, dc: m.dc };
}
function push(m) { m.v++; m.p.forEach((p, i) => send(p, { t: "match", g: view(m, i) })); }
function startSeries(m, n, keep) { // o desafiante (índice 0) é sempre Cara; keep = revanche (placar continua)
  m.timers.forEach(clearTimeout); m.timers = [];
  m.sid++; m.n = n; if (!keep) { m.sc = [0, 0]; m.rd = 1; } m.nums = [null, null]; m.pk = null; m.rv = null; m.fin = false; m.sw = null; m.rq = null; m.dc = false;
  m.toss = Math.random() < 0.5 ? "cara" : "coroa"; m.tw = m.toss === "cara" ? 0 : 1; m.st = "toss";
  push(m); later(m, 7500, () => startChoose(m, m.tw));
}
function startChoose(m, ch) { m.st = "choose"; m.ch = ch; m.pk = null; m.nums = [null, null]; m.rv = null; push(m); }
function resolveRound(m) {
  const sum = m.nums[0] + m.nums[1], res = sum % 2 ? "impar" : "par", w = res === m.pk ? m.ch : 1 - m.ch;
  m.sc[w]++; m.fin = m.sc[w] >= m.n; // n = pontos para vencer (3, 5 ou 7)
  m.rv = { n: m.nums.slice(), sum, res, w }; m.st = "reveal"; push(m);
  later(m, m.fin ? 7000 : 9500, () => {
    if (m.fin) { m.st = "end"; m.sw = w; m.rq = null; push(m); }
    else { m.rd++; startChoose(m, 1 - w); } // quem perdeu o ponto escolhe par/ímpar
  });
}
function endMatch(m, leaver) {
  if (!m.alive) return;
  m.alive = false; m.timers.forEach(clearTimeout);
  const other = m.p[m.p[0] === leaver ? 1 : 0];
  m.p.forEach((p) => { p.match = null; });
  leaver.st = "free"; other.st = "busy"; // o outro fica ocupado até voltar à sala
  send(other, { t: "oppLeft" }); lobby();
}
function removePlayer(P) {
  clearTimeout(P.dropT); dropChallenges(P, "saiu da sala");
  if (P.match) endMatch(P.match, P);
  players.delete(P.id); lobby();
}

function onMessage(conn, txt) {
  let msg; try { msg = JSON.parse(txt); } catch (e) { return; }
  if (!msg || typeof msg !== "object") return;
  if (msg.t === "join") {
    if (conn.P) return;
    const name = String(msg.name || "").trim().slice(0, 16);
    if (!name) return conn.send({ t: "err", msg: "Digite um nome." });
    for (const p of players.values()) if (p.name.toLowerCase() === name.toLowerCase()) return conn.send({ t: "err", msg: "Esse nome já está em uso na sala." });
    const P = { id: nextId++, name, conn, token: crypto.randomBytes(12).toString("hex"), st: "free", match: null, out: null, inc: null, dropT: null };
    players.set(P.id, P); conn.P = P;
    conn.send({ t: "joined", id: P.id, name, token: P.token, inMatch: false }); lobby(); return;
  }
  if (msg.t === "resume") {
    let P = null; for (const p of players.values()) if (p.token === msg.token) P = p;
    if (!P) return conn.send({ t: "noresume" });
    if (P.conn && P.conn !== conn) { P.conn.P = null; P.conn.close(); }
    clearTimeout(P.dropT); P.conn = conn; conn.P = P;
    conn.send({ t: "joined", id: P.id, name: P.name, token: P.token, inMatch: !!P.match }); lobby();
    if (P.match) push(P.match); return;
  }
  const P = conn.P; if (!P) return;
  const m = P.match, i = m ? m.p.indexOf(P) : -1, v = msg.v;
  switch (msg.t) {
    case "challenge": ask(P, msg.to); break;
    case "cancel": if (P.out) { endAsk(P, true); send(P, { t: "waitEnd" }); lobby(); } break;
    case "respond": if (P.inc) respond(P, !!msg.ok); break;
    case "pick":
      if (m && m.st === "choose" && m.ch === i && (v === "par" || v === "impar")) { m.pk = v; m.st = "num"; m.nums = [null, null]; push(m); } break;
    case "num":
      if (m && m.st === "num" && Number.isInteger(v) && v >= 0 && v <= 10 && m.nums[i] == null) {
        m.nums[i] = v; if (m.nums[0] != null && m.nums[1] != null) resolveRound(m); else push(m);
      } break;
    case "rematch":
      if (m && m.st === "end" && m.rq == null && !m.dc && m.n < 7 && i === 1 - m.sw) { m.rq = i; push(m); } break;
    case "rematchResp":
      if (m && m.st === "end" && m.rq != null && m.rq !== i && !m.dc) { if (msg.ok) startSeries(m, m.n + 2, true); else { m.dc = true; push(m); } } break;
    case "leave": if (m) endMatch(m, P); free(P); lobby(); break;
    case "exit": removePlayer(P); conn.P = null; break;
  }
}

function onConnection(conn) {
  conn.onmessage = (txt) => onMessage(conn, txt);
  conn.onclose = () => {
    const P = conn.P; if (!P || P.conn !== conn) return;
    P.conn = null; dropChallenges(P, "perdeu a conexão");
    if (P.match) push(P.match);
    P.dropT = setTimeout(() => removePlayer(P), GRACE); lobby();
  };
}

/* ---------- HTTP ---------- */
const server = http.createServer((req, res) => {
  if (req.url === "/healthz") { res.end("ok"); return; }
  fs.readFile(path.join(__dirname, "public", "index.html"), (e, d) => {
    if (e) { res.writeHead(500); res.end("Erro ao carregar a página."); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }); res.end(d);
  });
});
server.on("upgrade", (req, socket) => {
  if (req.url.split("?")[0] !== "/ws") { socket.destroy(); return; }
  const conn = upgrade(req, socket); if (conn) onConnection(conn);
});
server.listen(PORT, () => console.log("Par ou Ímpar rodando em http://localhost:" + PORT));
