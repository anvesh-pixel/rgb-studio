#!/usr/bin/env node
// RGB Studio: dependency-free local web UI for an OpenRGB SDK server.
// Usage: node server.mjs   (env: PORT=7420, OPENRGB_HOST=127.0.0.1, OPENRGB_PORT=6742, AGENT_PID_FILE=...)
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const WEB_PORT = Number(process.env.PORT || 7420);
const HOST = process.env.OPENRGB_HOST || '127.0.0.1';
const PORT = Number(process.env.OPENRGB_PORT || 6742);
// A detached software effect (openrgb-agent fire/wave) streams colors and would overwrite anything set here.
const AGENT_PID_FILE = process.env.AGENT_PID_FILE || 'D:\\claude\\Projects\\openrgb-agent\\fire.pid';
const PROTO = 4;

const PKT = { CONTROLLER_COUNT: 0, CONTROLLER_DATA: 1, PROTOCOL_VERSION: 40, SET_CLIENT_NAME: 50, RESIZEZONE: 1000, UPDATELEDS: 1050, UPDATEMODE: 1101, SAVEMODE: 1102 };
const FLAG = { SPEED: 1, DIR_LR: 2, DIR_UD: 4, DIR_HV: 8, BRIGHTNESS: 16, PER_LED: 32, MODE_SPECIFIC: 64, RANDOM: 128 };
const COLOR_MODE = { NONE: 0, PER_LED: 1, MODE_SPECIFIC: 2, RANDOM: 3 };
const DEVICE_TYPES = ['Motherboard', 'DRAM', 'GPU', 'Cooler', 'LED Strip', 'Keyboard', 'Mouse', 'Mousemat', 'Headset', 'Headset Stand', 'Gamepad', 'Light', 'Speaker', 'Virtual', 'Storage', 'Case', 'Microphone', 'Accessory', 'Keypad'];

// ---------- OpenRGB client ----------
class Client {
  constructor() { this.buf = Buffer.alloc(0); this.waiters = []; this.proto = 0; this.sock = null; }
  get connected() { return !!this.sock && !this.sock.destroyed; }
  async ensure() {
    if (this.connected) return;
    this.connecting ??= this.init().finally(() => { this.connecting = null; });
    await this.connecting;
  }
  async init() {
    await new Promise((res, rej) => {
      const s = net.createConnection({ host: HOST, port: PORT }, () => { this.sock = s; res(); });
      s.once('error', (e) => { s.destroy(); rej(new Error(`Cannot reach OpenRGB SDK server at ${HOST}:${PORT} (${e.code}). Start OpenRGB with the SDK server enabled.`)); });
      s.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.pump(); });
      s.on('close', () => { if (this.sock === s) this.sock = null; this.buf = Buffer.alloc(0); for (const w of this.waiters.splice(0)) w.rej(new Error('OpenRGB connection closed')); });
    });
    const v = Buffer.alloc(4); v.writeUInt32LE(PROTO);
    const r = await this.request(PKT.PROTOCOL_VERSION, 0, v).catch(() => null);
    this.proto = r ? Math.min(PROTO, r.readUInt32LE(0)) : 0;
    this.send(PKT.SET_CLIENT_NAME, 0, Buffer.from('RGB Studio\0'));
  }
  pump() {
    while (this.buf.length >= 16) {
      const size = this.buf.readUInt32LE(12);
      if (this.buf.length < 16 + size) return;
      const pkt = { dev: this.buf.readUInt32LE(4), id: this.buf.readUInt32LE(8), data: this.buf.subarray(16, 16 + size) };
      this.buf = this.buf.subarray(16 + size);
      const i = this.waiters.findIndex((w) => w.id === pkt.id && w.dev === pkt.dev);
      if (i >= 0) this.waiters.splice(i, 1)[0].res(pkt.data);
    }
  }
  send(id, dev = 0, data = Buffer.alloc(0)) {
    if (!this.connected) throw new Error('Not connected to OpenRGB');
    const h = Buffer.alloc(16);
    h.write('ORGB', 0, 'ascii'); h.writeUInt32LE(dev, 4); h.writeUInt32LE(id, 8); h.writeUInt32LE(data.length, 12);
    this.sock.write(Buffer.concat([h, data]));
  }
  request(id, dev = 0, data) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) this.waiters.splice(i, 1); rej(new Error(`Timeout waiting for OpenRGB packet ${id}`)); }, 5000);
      const w = { id, dev, res: (d) => { clearTimeout(t); res(d); }, rej: (e) => { clearTimeout(t); rej(e); } };
      this.waiters.push(w);
      this.send(id, dev, data);
    });
  }
  async devices() {
    await this.ensure();
    const n = (await this.request(PKT.CONTROLLER_COUNT)).readUInt32LE(0);
    const out = [];
    for (let i = 0; i < n; i++) {
      const p = Buffer.alloc(4); p.writeUInt32LE(this.proto);
      out.push({ index: i, ...parseController(await this.request(PKT.CONTROLLER_DATA, i, p), this.proto) });
    }
    return out;
  }
}

function reader(b) {
  let o = 0;
  return {
    u16: () => { const v = b.readUInt16LE(o); o += 2; return v; },
    u32: () => { const v = b.readUInt32LE(o); o += 4; return v; },
    i32: () => { const v = b.readInt32LE(o); o += 4; return v; },
    str: () => { const l = b.readUInt16LE(o); o += 2; const s = b.toString('utf8', o, o + l).replace(/\0$/, ''); o += l; return s; },
    color: () => { const c = { r: b[o], g: b[o + 1], b: b[o + 2] }; o += 4; return c; },
    skip: (n) => { o += n; },
  };
}
function parseController(b, proto) {
  const r = reader(b);
  r.u32();
  const d = { type: DEVICE_TYPES[r.i32()] ?? 'Unknown', name: r.str() };
  d.vendor = proto >= 1 ? r.str() : '';
  d.description = r.str(); d.version = r.str(); d.serial = r.str(); d.location = r.str();
  const nModes = r.u16(); d.activeMode = r.i32(); d.modes = [];
  for (let i = 0; i < nModes; i++) {
    const m = { index: i, name: r.str(), value: r.i32(), flags: r.u32(), speedMin: r.u32(), speedMax: r.u32(), brightnessMin: 0, brightnessMax: 0, brightness: 0 };
    if (proto >= 3) { m.brightnessMin = r.u32(); m.brightnessMax = r.u32(); }
    m.colorsMin = r.u32(); m.colorsMax = r.u32(); m.speed = r.u32();
    if (proto >= 3) m.brightness = r.u32();
    m.direction = r.u32(); m.colorMode = r.u32();
    const nc = r.u16(); m.colors = Array.from({ length: nc }, r.color);
    d.modes.push(m);
  }
  const nZones = r.u16(); d.zones = [];
  for (let i = 0; i < nZones; i++) {
    const z = { index: i, name: r.str(), type: ['single', 'linear', 'matrix'][r.i32()] ?? 'unknown', ledsMin: r.u32(), ledsMax: r.u32(), ledsCount: r.u32() };
    const ml = r.u16(); if (ml > 0) r.skip(ml);
    if (proto >= 4) { const ns = r.u16(); for (let s = 0; s < ns; s++) { r.str(); r.i32(); r.u32(); r.u32(); } }
    d.zones.push(z);
  }
  const nLeds = r.u16(); d.ledCount = nLeds; for (let i = 0; i < nLeds; i++) { r.str(); r.u32(); }
  const nCol = r.u16(); d.colors = Array.from({ length: nCol }, r.color);
  return d;
}
const colorsBuf = (cs) => Buffer.concat(cs.map((c) => Buffer.from([c.r, c.g, c.b, 0])));
function modeBuffer(m, proto) {
  const parts = [];
  const u32 = (v) => { const x = Buffer.alloc(4); x.writeUInt32LE(v >>> 0); parts.push(x); };
  const i32 = (v) => { const x = Buffer.alloc(4); x.writeInt32LE(v); parts.push(x); };
  const nb = Buffer.from(m.name + '\0'); const nl = Buffer.alloc(2); nl.writeUInt16LE(nb.length); parts.push(nl, nb);
  i32(m.value); u32(m.flags); u32(m.speedMin); u32(m.speedMax);
  if (proto >= 3) { u32(m.brightnessMin); u32(m.brightnessMax); }
  u32(m.colorsMin); u32(m.colorsMax); u32(m.speed);
  if (proto >= 3) u32(m.brightness);
  u32(m.direction); u32(m.colorMode);
  const cn = Buffer.alloc(2); cn.writeUInt16LE(m.colors.length); parts.push(cn, colorsBuf(m.colors));
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8); head.writeUInt32LE(8 + body.length, 0); head.writeInt32LE(m.index, 4);
  return Buffer.concat([head, body]);
}

// ---------- actions ----------
const client = new Client();
const hex = (s) => { const h = String(s).replace(/^#/, ''); if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`Bad color "${s}"`); return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }; };
const toHex = (c) => '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('');
const isOffMode = (m) => /^off$/i.test(m.name);
const isDirect = (m) => /^(direct|custom)$/i.test(m.name);

function setLeds(dev, colors) {
  const n = Buffer.alloc(2); n.writeUInt16LE(colors.length);
  const body = Buffer.concat([n, colorsBuf(colors)]);
  const s = Buffer.alloc(4); s.writeUInt32LE(4 + body.length);
  client.send(PKT.UPDATELEDS, dev.index, Buffer.concat([s, body]));
}
// ARGB headers report 0 LEDs after an OpenRGB restart; give them a size so per-LED colors land.
async function sizeEmptyZones(dev) {
  let changed = false;
  for (const z of dev.zones) {
    if (z.type === 'linear' && z.ledsCount === 0 && z.ledsMax > 0) {
      const b = Buffer.alloc(8); b.writeInt32LE(z.index, 0); b.writeInt32LE(Math.min(60, z.ledsMax), 4);
      client.send(PKT.RESIZEZONE, dev.index, b); changed = true;
    }
  }
  if (!changed) return dev;
  await new Promise((r) => setTimeout(r, 150));
  return (await client.devices())[dev.index];
}

function stopAgentEffect() {
  let pid; try { pid = Number(fs.readFileSync(AGENT_PID_FILE, 'utf8').trim()); } catch { return false; }
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid); } catch { return false; }
  try { fs.unlinkSync(AGENT_PID_FILE); } catch {}
  return true;
}
function agentEffectRunning() {
  try { const pid = Number(fs.readFileSync(AGENT_PID_FILE, 'utf8').trim()); process.kill(pid, 0); return pid; } catch { return 0; }
}

async function applyMode(dev, modeIndex, opts = {}) {
  const base = dev.modes[modeIndex];
  if (!base) throw new Error(`${dev.name}: no mode ${modeIndex}`);
  const m = { ...base, colors: [...base.colors] };
  const colors = (opts.colors || []).map(hex);
  if (opts.random && m.flags & FLAG.RANDOM) m.colorMode = COLOR_MODE.RANDOM;
  else if (colors.length && m.flags & FLAG.MODE_SPECIFIC && m.colorsMax > 0) {
    m.colorMode = COLOR_MODE.MODE_SPECIFIC;
    const n = Math.max(m.colorsMin, Math.min(m.colorsMax, colors.length));
    m.colors = Array.from({ length: n }, (_, i) => colors[i % colors.length]);
  } else if (colors.length && m.flags & FLAG.PER_LED) m.colorMode = COLOR_MODE.PER_LED;
  const clamp = (v, a, b) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), Math.round(v)));
  if (opts.speed !== undefined && m.flags & FLAG.SPEED) m.speed = clamp(m.speedMin + (m.speedMax - m.speedMin) * opts.speed / 100, m.speedMin, m.speedMax);
  if (opts.brightness !== undefined && m.flags & FLAG.BRIGHTNESS) m.brightness = clamp(m.brightnessMin + (m.brightnessMax - m.brightnessMin) * opts.brightness / 100, m.brightnessMin, m.brightnessMax);
  if (opts.direction !== undefined && m.flags & (FLAG.DIR_LR | FLAG.DIR_UD | FLAG.DIR_HV)) m.direction = Number(opts.direction);
  client.send(PKT.UPDATEMODE, dev.index, modeBuffer(m, client.proto));
  if (m.colorMode === COLOR_MODE.PER_LED && colors.length) {
    const d = await sizeEmptyZones(dev);
    setLeds(d, Array.from({ length: d.ledCount }, (_, i) => colors[i % colors.length]));
  }
}

async function solid(dev, color) {
  const direct = dev.modes.find(isDirect);
  if (direct) {
    client.send(PKT.UPDATEMODE, dev.index, modeBuffer(direct, client.proto));
    const d = await sizeEmptyZones(dev);
    setLeds(d, Array(d.ledCount).fill(hex(color)));
    return;
  }
  const stat = dev.modes.find((m) => /^static$/i.test(m.name));
  if (!stat) throw new Error(`${dev.name}: no Direct or Static mode`);
  await applyMode(dev, stat.index, { colors: [color] });
}
async function off(dev) {
  const o = dev.modes.find(isOffMode);
  if (o) return applyMode(dev, o.index);
  return solid(dev, '#000000');
}

function serialize(d) {
  return {
    index: d.index, name: d.name, type: d.type, vendor: d.vendor, description: d.description, location: d.location, serial: d.serial,
    activeMode: d.activeMode, ledCount: d.ledCount,
    preview: d.colors.slice(0, 120).map(toHex),
    zones: d.zones.map((z) => ({ index: z.index, name: z.name, type: z.type, leds: z.ledsCount, ledsMax: z.ledsMax })),
    modes: d.modes.map((m) => ({
      index: m.index, name: m.name,
      speed: !!(m.flags & FLAG.SPEED), brightness: !!(m.flags & FLAG.BRIGHTNESS),
      direction: [m.flags & FLAG.DIR_LR && 'lr', m.flags & FLAG.DIR_UD && 'ud', m.flags & FLAG.DIR_HV && 'hv'].filter(Boolean),
      perLed: !!(m.flags & FLAG.PER_LED), modeSpecific: !!(m.flags & FLAG.MODE_SPECIFIC) && m.colorsMax > 0, random: !!(m.flags & FLAG.RANDOM),
      colorsMin: m.colorsMin, colorsMax: m.colorsMax, colorMode: m.colorMode, colors: m.colors.map(toHex),
      speedPct: m.speedMax !== m.speedMin ? Math.round(100 * (m.speed - m.speedMin) / (m.speedMax - m.speedMin)) : 50,
      brightnessPct: m.brightnessMax !== m.brightnessMin ? Math.round(100 * (m.brightness - m.brightnessMin) / (m.brightnessMax - m.brightnessMin)) : 100,
      dir: m.direction,
    })),
  };
}

// ---------- HTTP ----------
const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const body = (req) => new Promise((res, rej) => { let s = ''; req.on('data', (c) => { s += c; if (s.length > 1e5) req.destroy(); }); req.on('end', () => { try { res(s ? JSON.parse(s) : {}); } catch (e) { rej(e); } }); });

async function targets(sel) {
  const devs = await client.devices();
  if (sel === 'all' || sel === undefined) return devs;
  const d = devs[Number(sel)]; if (!d) throw new Error(`No device ${sel}`);
  return [d];
}
const settle = () => new Promise((r) => setTimeout(r, 120));

const routes = {
  'GET /api/devices': async () => ({ devices: (await client.devices()).map(serialize), proto: client.proto, server: `${HOST}:${PORT}`, agentEffect: agentEffectRunning() }),
  'POST /api/mode': async (b) => {
    const stopped = stopAgentEffect();
    const [dev] = await targets(b.device);
    await applyMode(dev, Number(b.mode), b);
    await settle(); return { ok: true, stoppedAgentEffect: stopped };
  },
  // Apply a mode by name to every device that has it (e.g. "Rainbow Wave" everywhere).
  'POST /api/mode-all': async (b) => {
    const stopped = stopAgentEffect();
    const name = String(b.name).toLowerCase(); const applied = [], skipped = [];
    for (const dev of await client.devices()) {
      const m = dev.modes.find((x) => x.name.toLowerCase() === name);
      if (m) { await applyMode(dev, m.index, b); applied.push(dev.name); } else skipped.push(dev.name);
    }
    await settle(); return { ok: true, applied, skipped, stoppedAgentEffect: stopped };
  },
  'POST /api/color': async (b) => { const stopped = stopAgentEffect(); for (const d of await targets(b.device)) await solid(d, b.color); await settle(); return { ok: true, stoppedAgentEffect: stopped }; },
  'POST /api/off': async (b) => { const stopped = stopAgentEffect(); for (const d of await targets(b.device)) await off(d); await settle(); return { ok: true, stoppedAgentEffect: stopped }; },
  'POST /api/save': async (b) => { for (const d of await targets(b.device)) { const m = d.modes[d.activeMode]; if (m) client.send(PKT.SAVEMODE, d.index, modeBuffer(m, client.proto)); } return { ok: true }; },
  'POST /api/stop-agent': async () => ({ ok: true, stopped: stopAgentEffect() }),
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = routes[`${req.method} ${url.pathname}`];
  if (route) {
    try { json(res, 200, await route(req.method === 'POST' ? await body(req) : {})); }
    catch (e) { json(res, 502, { error: e.message }); }
    return;
  }
  if (req.method !== 'GET') return json(res, 404, { error: 'not found' });
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (rel.includes('..')) return json(res, 400, { error: 'bad path' });
  fs.readFile(PUBLIC + rel, (err, data) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[rel.slice(rel.lastIndexOf('.'))] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
}).listen(WEB_PORT, '127.0.0.1', () => console.log(`RGB Studio on http://localhost:${WEB_PORT}  (OpenRGB ${HOST}:${PORT})`));
