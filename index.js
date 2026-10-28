/**
 * dsh-pet-plus —— dsh-pet 的增强包（宿主半侧）
 *
 * 给已经装好的 dsh-pet 加四件事：
 *   1. QQ 互通：NapCat / OneBot 11 收到私聊或群消息 → 转给桌宠（同一个人设、同一份记忆、同一个气泡）
 *      → 回复同时发回 QQ；QQ 里也能用「摸摸 / 喂食 / 好感 / 签到 / 提醒」这些指令。
 *   2. 好感度养成：亲密度、饥饿度、每日签到，全部落盘到 $DSH_HOME/dsh-pet-plus/state.json。
 *   3. 定时提醒：喝水 / 久坐 / 番茄钟，到点让桌宠走到屏幕上说话并播动画，可选同步推到 QQ。
 *   4. 右键菜单 + 事件流：在桌宠右键菜单里加「摸摸 / 喂食 / 状态」，并把每次互动写成事件，
 *      供浏览器半侧（client.js）播提示音、渲染设置页。
 *
 * 与 dsh-pet 的关系：**只通过它自己的 HTTP 路由**调用（/dsh-pet-7340/chat|broadcast|anim|menu/*），
 * 不 import 它的内部模块、不改它的文件——所以 dsh-pet 升级不会把这层打坏；它没装时本插件静默降级。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'dsh-pet-plus';
/** webServer：对外路由（QQ 回调 + 设置页数据）；commands：/摸摸 /喂食 /养成 /提醒 /qq */
export const inject = ['webServer', 'commands'];

const ROUTE = '/dsh-pet-plus';
const PET = '/dsh-pet-7340';
const SHORT_MS = 12_000;
const DAY_MS = 86_400_000;

const DSH_HOME =
  typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
const DATA_DIR = join(DSH_HOME, 'dsh-pet-plus');
const CONFIG_PATH = join(DATA_DIR, 'config.json');
const STATE_PATH = join(DATA_DIR, 'state.json');

// ---------------------------------------------------------------- 默认配置

const DEFAULT_LINES = {
  pat: ['唔…主人又来摸头了。', '再摸一下也不是不行。', '嘿嘿…被摸到了。', '轻、轻一点啦！'],
  feed: ['好吃！还要！', '这个我喜欢，谢啦。', '吧唧吧唧…吃饱饱。', '唔…勉强算你有心。'],
  checkin: ['今天也签到啦，主人真守时。', '签到了，今天也要一起努力。'],
  levelup: ['关系变好了！', '好像更亲近了一点…'],
  hungry: ['肚子饿扁了…', '主人，该喂我了吧？', '咕噜噜…（肚子在叫）'],
  qqHello: ['在的，怎么啦？'],
};

const DEFAULT_CONFIG = {
  petId: 'main',
  sound: true,
  qq: {
    enabled: false,
    apiBase: 'http://127.0.0.1:3000',
    accessToken: '',
    selfId: '',
    privateEnabled: true,
    groupEnabled: true,
    allowedUsers: [],
    allowedGroups: [],
    groupRequireAt: true,
    groupPrefix: '',
    maxReplyChars: 500,
    mirrorInbound: false,
    inboundToken: '',
  },
  affection: {
    enabled: true,
    patCooldownSec: 45,
    feedCooldownSec: 300,
    hungerDecayPerHour: 8,
    chatReward: 1,
    chatRewardDailyCap: 15,
    lines: DEFAULT_LINES,
  },
  reminders: {
    enabled: true,
    quiet: { enabled: true, start: '23:30', end: '08:00' },
    list: [
      {
        id: 'water',
        label: '喝水',
        everyMin: 45,
        text: '该喝水啦，主人～',
        anim: '点击回应-元气挥手',
        enabled: true,
        pushToQQ: false,
      },
      {
        id: 'stand',
        label: '起来动动',
        everyMin: 60,
        text: '坐太久啦，起来伸个懒腰吧！',
        anim: '超大伸懒腰',
        enabled: true,
        pushToQQ: false,
      },
    ],
  },
};

/** 亲密度等级（门槛从低到高） */
const LEVELS = [
  { min: 0, name: '初次见面' },
  { min: 50, name: '有点熟了' },
  { min: 150, name: '亲近' },
  { min: 320, name: '黏人' },
  { min: 600, name: '形影不离' },
];

// ---------------------------------------------------------------- 小工具

function ensureDir() {
  mkdirSync(DATA_DIR, { recursive: true });
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 只合并已知键的深合并（数组整体替换：reminders.list / allowedUsers 都是这样） */
function mergeConfig(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!isPlainObject(patch)) return out;
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject(base[k])) out[k] = mergeConfig(base[k], v);
    else out[k] = v;
  }
  return out;
}

function num(v, fallback, min = -Infinity, max = Infinity) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function clampPct(v) {
  return Math.max(0, Math.min(100, Math.round(v)));
}

function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "23:30" → 分钟数；非法 → null */
function parseClock(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function inQuietHours(q, nowMs = Date.now()) {
  if (!q || !q.enabled) return false;
  const a = parseClock(q.start);
  const b = parseClock(q.end);
  if (a === null || b === null) return false;
  const d = new Date(nowMs);
  const cur = d.getHours() * 60 + d.getMinutes();
  return a <= b ? cur >= a && cur < b : cur >= a || cur < b;
}

function todayKey(nowMs = Date.now()) {
  const d = new Date(nowMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function levelOf(points) {
  let idx = 0;
  for (let i = 0; i < LEVELS.length; i += 1) if (points >= LEVELS[i].min) idx = i;
  const cur = LEVELS[idx];
  const next = LEVELS[idx + 1];
  return {
    index: idx + 1,
    name: cur.name,
    min: cur.min,
    nextAt: next ? next.min : null,
    progress: next ? Math.round(((points - cur.min) / (next.min - cur.min)) * 100) : 100,
  };
}

// ---------------------------------------------------------------- 消息解析

function stripCQ(text) {
  return String(text ?? '')
    .replace(/\[CQ:at,qq=(\d+)\]/g, '')
    .replace(/\[CQ:[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasAtSelf(raw, selfId) {
  if (!selfId) return false;
  const s = String(raw ?? '');
  if (typeof raw === 'string') return s.includes(`[CQ:at,qq=${selfId}]`);
  return false;
}

/** OneBot 的 message 可能是 CQ 字符串，也可能是消息段数组 */
function parseMessage(raw, selfId) {
  if (Array.isArray(raw)) {
    let text = '';
    let atSelf = false;
    let images = 0;
    for (const seg of raw) {
      if (!seg || typeof seg !== 'object') continue;
      const type = seg.type;
      const data = seg.data ?? {};
      if (type === 'text') text += String(data.text ?? '');
      else if (type === 'at') {
        if (String(data.qq ?? '') === String(selfId)) atSelf = true;
      } else if (type === 'image') images += 1;
    }
    return { text: text.replace(/\s+/g, ' ').trim(), atSelf, images };
  }
  const str = String(raw ?? '');
  return {
    text: stripCQ(str),
    atSelf: hasAtSelf(str, selfId),
    images: (str.match(/\[CQ:image/g) ?? []).length,
  };
}

// ---------------------------------------------------------------- 插件主体

export function apply(ctx) {
  let cfg = mergeConfig(DEFAULT_CONFIG, {});
  let disposed = false;
  const origin = ctx.webServer.getOrigin();

  // ---- 配置读写
  function loadConfig() {
    ensureDir();
    try {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      cfg = mergeConfig(DEFAULT_CONFIG, raw);
    } catch {
      cfg = mergeConfig(DEFAULT_CONFIG, {});
    }
    // 防御：坏配置不炸插件
    cfg.qq.allowedUsers = (cfg.qq.allowedUsers ?? []).map(String).filter(Boolean);
    cfg.qq.allowedGroups = (cfg.qq.allowedGroups ?? []).map(String).filter(Boolean);
    if (!Array.isArray(cfg.reminders.list)) cfg.reminders.list = DEFAULT_CONFIG.reminders.list.slice();
  }
  function saveConfig() {
    ensureDir();
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  }

  // ---- 状态（养成 + 提醒上次触发时间）
  let state = {
    affection: 0,
    hunger: 70,
    totalPats: 0,
    totalFeeds: 0,
    lastPat: 0,
    lastFeed: 0,
    lastDecay: Date.now(),
    lastHungryNag: 0,
    checkinDate: '',
    checkinStreak: 0,
    chatRewardDate: '',
    chatRewardToday: 0,
    lastFired: {},
  };
  function loadState() {
    ensureDir();
    try {
      const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
      if (isPlainObject(raw)) state = { ...state, ...raw, lastFired: isPlainObject(raw.lastFired) ? raw.lastFired : {} };
    } catch {
      /* 首次运行 */
    }
  }
  function saveState() {
    ensureDir();
    try {
      writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
    } catch {
      /* 落盘失败不影响交互 */
    }
  }

  // ---- 客户端事件流（设置页轮询 /state?since=N 取增量）
  let eventSeq = 0;
  const events = [];
  function pushEvent(type, text, extra) {
    eventSeq += 1;
    events.push({ id: eventSeq, type, text: String(text ?? ''), ts: Date.now(), ...(extra ?? {}) });
    if (events.length > 60) events.splice(0, events.length - 60);
  }

  // ---- 宠物 HTTP 调用
  const petUrl = (path, params = {}) => {
    const q = new URLSearchParams({ pet: String(cfg.petId || 'main'), ...params });
    return `${origin}${PET}${path}?${q.toString()}`;
  };
  async function petPost(path, body, params = {}) {
    const res = await fetch(petUrl(path, params), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(70_000),
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return { ok: false, reason: 'bad-response', message: text.slice(0, 200) };
    }
  }
  /** 让桌宠说一句；anim 为 true 时联动碎碎念动画 */
  async function petSay(text, anim = true) {
    if (!text) return { ok: false, reason: 'empty' };
    return petPost('/broadcast', { text: String(text).slice(0, 900), duration: 12_000, anim: !!anim });
  }
  /** 点播动画：名字不在池内时 dsh-pet 会返回 ok:false，这里吞掉（动画不是必需） */
  async function petAnim(name) {
    if (!name) return;
    try {
      await petPost('/anim', { name });
    } catch {
      /* 忽略 */
    }
  }
  async function petChat(text) {
    return petPost('/chat', { text });
  }

  // ---- QQ / OneBot 11
  const seenMessages = new Set();
  const lastByUser = new Map();
  let qqMetaAt = 0;
  let qqLastError = '';
  let qqSelf = {};

  function qqHeaders() {
    const h = { 'content-type': 'application/json' };
    if (cfg.qq.accessToken) h.authorization = `Bearer ${cfg.qq.accessToken}`;
    return h;
  }
  function qqBase() {
    return String(cfg.qq.apiBase || '').replace(/\/+$/, '');
  }
  async function qqApi(action, payload) {
    const base = qqBase();
    if (!base) throw new Error('未配置 NapCat HTTP API 地址');
    const res = await fetch(`${base}/${action}`, {
      method: 'POST',
      headers: qqHeaders(),
      body: JSON.stringify(payload ?? {}),
      signal: AbortSignal.timeout(SHORT_MS),
    });
    const text = await res.text();
    let json = {};
    try {
      json = JSON.parse(text);
    } catch {
      json = { status: 'failed', raw: text.slice(0, 200) };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (json && json.status === 'failed') throw new Error(String(json.message ?? json.wording ?? 'OneBot 调用失败'));
    return json;
  }
  async function qqSend(kind, target, message) {
    const body =
      kind === 'group'
        ? { group_id: Number(target), message: String(message), auto_escape: true }
        : { user_id: Number(target), message: String(message), auto_escape: true };
    return qqApi(kind === 'group' ? 'send_group_msg' : 'send_private_msg', body);
  }
  async function qqHealth() {
    const base = qqBase();
    if (!base) return { ok: false, reason: '未配置 API 地址' };
    try {
      const res = await fetch(`${base}/get_login_info`, {
        headers: cfg.qq.accessToken ? { authorization: `Bearer ${cfg.qq.accessToken}` } : {},
        signal: AbortSignal.timeout(6000),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.status === 'failed') return { ok: false, reason: `HTTP ${res.status}` };
      const d = json.data ?? {};
      qqSelf = { id: String(d.user_id ?? ''), nickname: String(d.nickname ?? '') };
      return { ok: true, selfId: qqSelf.id, nickname: qqSelf.nickname };
    } catch (e) {
      qqLastError = e instanceof Error ? e.message : String(e);
      return { ok: false, reason: qqLastError };
    }
  }

  // ---- 养成动作
  function refreshHunger() {
    const now = Date.now();
    const hours = (now - (state.lastDecay || now)) / 3_600_000;
    if (hours > 0.01) {
      const rate = num(cfg.affection.hungerDecayPerHour, 8, 0, 100);
      state.hunger = clampPct(state.hunger - hours * rate);
      state.lastDecay = now;
      saveState();
    }
    return state.hunger;
  }

  function affectionSummary() {
    const lv = levelOf(state.affection);
    const lines = [];
    lines.push(`亲密度 ${state.affection}（Lv.${lv.index} ${lv.name}）`);
    lines.push(`饥饿度 ${clampPct(state.hunger)}%`);
    if (state.checkinStreak > 0) lines.push(`连续签到 ${state.checkinStreak} 天`);
    lines.push(`被摸 ${state.totalPats} 次 · 被喂 ${state.totalFeeds} 次`);
    return lines.join('\n');
  }

  async function doPat(source = 'user') {
    if (!cfg.affection.enabled) return { ok: false, text: '养成关掉了哦' };
    const now = Date.now();
    const cd = num(cfg.affection.patCooldownSec, 45, 0, 3600) * 1000;
    const left = cd - (now - (state.lastPat || 0));
    if (left > 0) return { ok: false, text: `摸太勤啦，${Math.ceil(left / 1000)} 秒后再来～` };
    state.lastPat = now;
    state.totalPats += 1;
    const before = levelOf(state.affection).index;
    state.affection += 2;
    saveState();
    const after = levelOf(state.affection).index;
    const line = pick(cfg.affection.lines.pat ?? DEFAULT_LINES.pat);
    await petSay(line);
    await petAnim(pick(['点击回应-害羞惊讶', '点击回应-开心跃动', '点击回应-挠痒咯咯笑']));
    pushEvent('pat', line, { source, affection: state.affection });
    if (after > before) {
      const up = pick(cfg.affection.lines.levelup ?? DEFAULT_LINES.levelup) + `（Lv.${after} ${levelOf(state.affection).name}）`;
      await petSay(up);
      pushEvent('levelup', up, { level: after });
      return { ok: true, text: `亲密度 +2（${state.affection}）\n${up}` };
    }
    return { ok: true, text: `亲密度 +2（${state.affection}）` };
  }

  async function doFeed(food = '') {
    if (!cfg.affection.enabled) return { ok: false, text: '养成关掉了哦' };
    const now = Date.now();
    const cd = num(cfg.affection.feedCooldownSec, 300, 0, 86_400) * 1000;
    const left = cd - (now - (state.lastFeed || 0));
    if (left > 0) return { ok: false, text: `刚吃过啦，${Math.ceil(left / 60_000)} 分钟后再喂～` };
    if (state.hunger >= 98) return { ok: false, text: '已经吃得饱饱的了，吃不下了…' };
    state.lastFeed = now;
    state.totalFeeds += 1;
    const before = levelOf(state.affection).index;
    state.affection += 6;
    state.hunger = clampPct(state.hunger + 35);
    saveState();
    const line = `${food ? `「${food}」` : ''}${pick(cfg.affection.lines.feed ?? DEFAULT_LINES.feed)}`;
    await petSay(line);
    await petAnim(pick(['吃白饭', '大口吃零食', '吃饱饱摸肚子']));
    pushEvent('feed', line, { food, hunger: state.hunger });
    const after = levelOf(state.affection).index;
    if (after > before) {
      const up = pick(cfg.affection.lines.levelup ?? DEFAULT_LINES.levelup) + `（Lv.${after} ${levelOf(state.affection).name}）`;
      await petSay(up);
      pushEvent('levelup', up, { level: after });
      return { ok: true, text: `亲密度 +6（${state.affection}）· 饥饿度 ${state.hunger}%\n${up}` };
    }
    return { ok: true, text: `亲密度 +6（${state.affection}）· 饥饿度 ${state.hunger}%` };
  }

  async function doCheckin() {
    const today = todayKey();
    if (state.checkinDate === today) return { ok: false, text: `今天已经签过啦（连签 ${state.checkinStreak} 天）` };
    const y = todayKey(Date.now() - DAY_MS);
    state.checkinStreak = state.checkinDate === y ? state.checkinStreak + 1 : 1;
    state.checkinDate = today;
    const bonus = 3 + Math.min(7, state.checkinStreak);
    state.affection += bonus;
    saveState();
    const line = pick(cfg.affection.lines.checkin ?? DEFAULT_LINES.checkin);
    await petSay(line);
    await petAnim('点击回应-元气挥手');
    pushEvent('checkin', line, { streak: state.checkinStreak });
    return { ok: true, text: `签到成功，连签 ${state.checkinStreak} 天，亲密度 +${bonus}` };
  }

  // ---- 提醒
  async function fireReminder(r, manual = false) {
    const text = `${r.label ? `【${r.label}】` : ''}${r.text}`;
    await petSay(text, true);
    await petAnim(r.anim);
    pushEvent('reminder', text, { id: r.id, manual });
    state.lastFired[r.id] = Date.now();
    saveState();
    if (cfg.qq.enabled && cfg.qq.selfId && (r.pushToQQ || manual === 'qq')) {
      try {
        await qqSend('private', cfg.qq.selfId, text);
      } catch (e) {
        qqLastError = e instanceof Error ? e.message : String(e);
      }
    }
    return text;
  }

  function reminderSnapshot() {
    const now = Date.now();
    return (cfg.reminders.list ?? []).map((r) => {
      const last = state.lastFired?.[r.id] ?? 0;
      const every = num(r.everyMin, 45, 1, 10_080) * 60_000;
      return {
        id: String(r.id ?? ''),
        label: String(r.label ?? ''),
        text: String(r.text ?? ''),
        everyMin: num(r.everyMin, 45, 1, 10_080),
        anim: String(r.anim ?? ''),
        enabled: r.enabled !== false,
        pushToQQ: r.pushToQQ === true,
        lastAt: last || null,
        nextAt: last ? last + every : null,
        nextLabel: last ? fmtTime(last + every) : '下次启动后',
      };
    });
  }

  async function tick() {
    if (disposed) return;
    try {
      refreshHunger();
      // 饿了会自己喊
      if (cfg.affection.enabled && state.hunger < 28 && Date.now() - (state.lastHungryNag || 0) > 40 * 60_000) {
        state.lastHungryNag = Date.now();
        saveState();
        const line = pick(cfg.affection.lines.hungry ?? DEFAULT_LINES.hungry);
        await petSay(line);
        pushEvent('hungry', line, { hunger: state.hunger });
      }
      if (!cfg.reminders.enabled) return;
      if (inQuietHours(cfg.reminders.quiet)) return;
      const now = Date.now();
      for (const r of cfg.reminders.list ?? []) {
        if (r.enabled === false) continue;
        const every = num(r.everyMin, 45, 1, 10_080) * 60_000;
        const last = state.lastFired?.[r.id] ?? now;
        if (!state.lastFired?.[r.id]) {
          state.lastFired[r.id] = now; // 首次启动从"现在"开始计时，不立刻轰炸
          saveState();
          continue;
        }
        if (now - last >= every) await fireReminder(r);
      }
    } catch (e) {
      console.warn('[dsh-pet-plus] tick 失败：' + (e instanceof Error ? e.message : String(e)));
    }
  }

  // ---- QQ 入站
  async function handleIncoming(evt) {
    const c = cfg.qq;
    if (!c.enabled) return;
    if (!evt || typeof evt !== 'object') return;
    if (evt.post_type === 'meta_event') {
      qqMetaAt = Date.now();
      return;
    }
    if (evt.post_type !== 'message') return;
    const selfId = String(c.selfId || evt.self_id || '');
    const userId = String(evt.user_id ?? '');
    if (!userId || userId === selfId) return;
    const mid = String(evt.message_id ?? '');
    if (mid) {
      if (seenMessages.has(mid)) return;
      seenMessages.add(mid);
      if (seenMessages.size > 400) seenMessages.delete(seenMessages.values().next().value);
    }
    const isGroup = evt.message_type === 'group';
    const groupId = String(evt.group_id ?? '');
    if (isGroup) {
      if (!c.groupEnabled) return;
      if (!c.allowedGroups.length || !c.allowedGroups.includes(groupId)) return;
    } else {
      if (!c.privateEnabled) return;
      if (c.allowedUsers.length && !c.allowedUsers.includes(userId)) return;
    }
    // 同一用户 0.8 秒内只处理一条，防刷屏
    const lastAt = lastByUser.get(userId) ?? 0;
    if (Date.now() - lastAt < 800) return;
    lastByUser.set(userId, Date.now());

    const parsed = parseMessage(evt.message, selfId);
    let text = parsed.text.trim();
    if (isGroup) {
      if (c.groupPrefix) {
        if (!text.startsWith(c.groupPrefix)) {
          if (!(c.groupRequireAt && parsed.atSelf)) return;
        } else text = text.slice(c.groupPrefix.length).trim();
      } else if (c.groupRequireAt && !parsed.atSelf) return;
    }
    const replyTo = isGroup ? groupId : userId;
    const say = async (msg) => {
      const body = isGroup ? `[CQ:at,qq=${userId}] ${msg}` : msg;
      await qqSend(isGroup ? 'group' : 'private', replyTo, String(body).slice(0, 1500));
    };

    if (!text) {
      if (parsed.atSelf) await say(pick(DEFAULT_LINES.qqHello));
      return;
    }

    // 指令
    const cmd = matchCommand(text);
    if (cmd) {
      try {
        const r = await cmd.run(cmd.arg);
        await say(r.text);
      } catch (e) {
        await say('出错了：' + (e instanceof Error ? e.message : String(e)));
      }
      return;
    }

    // 聊天：走 dsh-pet 自己的人设 + 记忆 + 气泡
    if (parsed.images > 0) text = `${text}（对方发了 ${parsed.images} 张图片）`;
    if (c.mirrorInbound) pushEvent('qq-in', text, { userId, groupId: isGroup ? groupId : undefined });
    const r = await petChat(String(text).slice(0, 1900));
    if (r && r.ok) {
      await say(String(r.text ?? '').slice(0, num(c.maxReplyChars, 500, 40, 2000)));
      // 聊天也涨亲密度（每日封顶）
      const today = todayKey();
      if (state.chatRewardDate !== today) {
        state.chatRewardDate = today;
        state.chatRewardToday = 0;
      }
      if (state.chatRewardToday < num(cfg.affection.chatRewardDailyCap, 15, 0, 200)) {
        state.chatRewardToday += 1;
        state.affection += num(cfg.affection.chatReward, 1, 0, 10);
        saveState();
      }
      pushEvent('qq-reply', String(r.text ?? ''), { userId });
    } else {
      await say('呜…我现在说不了话（' + String(r?.reason ?? 'unknown') + '）');
    }
  }

  function matchCommand(text) {
    const defs = [
      { keys: ['摸摸', '摸', 'rua', 'pat'], run: (arg) => (arg ? feedLike(arg, true) : doPat('qq')) },
      { keys: ['喂食', '喂', 'feed'], run: (arg) => doFeed(arg) },
      { keys: ['好感', '好感度', '亲密度', '状态', '养成'], run: async () => ({ text: affectionSummary() }) },
      { keys: ['签到', 'checkin'], run: () => doCheckin() },
      {
        keys: ['提醒', 'reminders'],
        run: async () => ({
          text: reminderSnapshot()
            .map((r) => `${r.enabled ? '✅' : '⭕'} ${r.label}（每 ${r.everyMin} 分钟，下次 ${r.nextLabel}）`)
            .join('\n') || '还没有配置提醒',
        }),
      },
      {
        keys: ['帮助', 'help', '?', '菜单'],
        run: async () => ({
          text: [
            '可用指令：',
            '摸摸 · 喂食 [食物] · 好感 · 签到 · 提醒 · 帮助',
            '直接说话就是陪我聊天～',
          ].join('\n'),
        }),
      },
    ];
    const t = text.trim();
    for (const d of defs) {
      for (const k of d.keys) {
        if (t === k) return { run: d.run, arg: '' };
        if (t.startsWith(k) && /^[\s，,、:：]/.test(t.slice(k.length))) {
          return { run: d.run, arg: t.slice(k.length).replace(/^[\s，,、:：]+/, '').trim() };
        }
      }
    }
    return null;
  }
  function feedLike(arg) {
    // 「摸摸 小鱼干」这种写法当喂食处理
    return doFeed(arg);
  }

  // ---- 路由
  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1_000_000) throw new Error('body too large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  }

  function publicConfig() {
    return {
      ...cfg,
      qq: { ...cfg.qq, accessToken: cfg.qq.accessToken ? '***' : '' },
    };
  }

  async function handleRoute(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.startsWith(ROUTE) ? url.pathname.slice(ROUTE.length) : url.pathname;
    const method = req.method ?? 'GET';
    const body = method === 'POST' || method === 'PUT' ? await readBody(req) : '';

    if (path === '/state' || path === '/') {
      const since = Number(url.searchParams.get('since') ?? '0') || 0;
      refreshHunger();
      const lv = levelOf(state.affection);
      return sendJson(res, 200, {
        ok: true,
        now: Date.now(),
        sound: cfg.sound !== false,
        petId: cfg.petId,
        affection: {
          points: state.affection,
          hunger: clampPct(state.hunger),
          level: lv,
          pats: state.totalPats,
          feeds: state.totalFeeds,
          checkinStreak: state.checkinStreak,
          checkedToday: state.checkinDate === todayKey(),
        },
        reminders: reminderSnapshot(),
        qq: {
          enabled: !!cfg.qq.enabled,
          apiBase: cfg.qq.apiBase,
          selfId: cfg.qq.selfId || qqSelf.id || '',
          nickname: qqSelf.nickname || '',
          lastEventAt: qqMetaAt || null,
          lastError: qqLastError || null,
        },
        events: events.filter((e) => e.id > since),
        seq: eventSeq,
      });
    }

    if (path === '/config' && method === 'GET') return sendJson(res, 200, { ok: true, config: publicConfig() });

    if (path === '/config' && method === 'PUT') {
      let patch;
      try {
        patch = JSON.parse(body || '{}');
      } catch {
        return sendJson(res, 400, { ok: false, error: 'invalid JSON' });
      }
      const before = cfg;
      const next = mergeConfig(cfg, patch);
      // 关键字段兜底
      next.petId = String(next.petId || 'main');
      next.qq.apiBase = String(next.qq.apiBase || '').trim();
      next.qq.allowedUsers = (next.qq.allowedUsers ?? []).map((v) => String(v).trim()).filter(Boolean);
      next.qq.allowedGroups = (next.qq.allowedGroups ?? []).map((v) => String(v).trim()).filter(Boolean);
      next.reminders.list = (next.reminders.list ?? []).map((r, i) => ({
        id: String(r.id || `r${i + 1}`),
        label: String(r.label ?? ''),
        text: String(r.text ?? ''),
        everyMin: num(r.everyMin, 45, 1, 10_080),
        anim: String(r.anim ?? ''),
        enabled: r.enabled !== false,
        pushToQQ: r.pushToQQ === true,
      }));
      cfg = next;
      saveConfig();
      pushEvent('config', '设置已更新');
      void before;
      return sendJson(res, 200, { ok: true, config: publicConfig() });
    }

    if (path === '/action' && method === 'POST') {
      let p = {};
      try {
        p = JSON.parse(body || '{}');
      } catch {
        return sendJson(res, 400, { ok: false, error: 'invalid JSON' });
      }
      const action = String(p.action ?? '');
      try {
        if (action === 'pat') return sendJson(res, 200, { ok: true, result: await doPat('ui') });
        if (action === 'feed') return sendJson(res, 200, { ok: true, result: await doFeed(String(p.food ?? '')) });
        if (action === 'checkin') return sendJson(res, 200, { ok: true, result: await doCheckin() });
        if (action === 'status') return sendJson(res, 200, { ok: true, text: affectionSummary() });
        if (action === 'remind') {
          const r = (cfg.reminders.list ?? []).find((x) => x.id === p.id) ?? (cfg.reminders.list ?? [])[0];
          if (!r) return sendJson(res, 200, { ok: false, error: '没有提醒项' });
          return sendJson(res, 200, { ok: true, text: await fireReminder(r, true) });
        }
        if (action === 'sound') {
          cfg.sound = p.value !== false;
          saveConfig();
          return sendJson(res, 200, { ok: true, sound: cfg.sound });
        }
        if (action === 'say') {
          const r = await petSay(String(p.text ?? ''));
          return sendJson(res, 200, { ok: !!r?.ok, result: r });
        }
        return sendJson(res, 400, { ok: false, error: '未知 action' });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }

    if (path === '/qq/health') {
      const h = await qqHealth();
      return sendJson(res, 200, { ok: true, ...h });
    }

    if (path === '/qq/event') {
      // NapCat 的 HTTP 上报目标。token 校验（在 NapCat 的 上报地址 里带上 ?token=）
      const need = cfg.qq.inboundToken;
      if (need) {
        const got = url.searchParams.get('token') ?? String(req.headers['x-dsh-token'] ?? '');
        if (got !== need) return sendJson(res, 403, { ok: false });
      }
      let evt;
      try {
        evt = JSON.parse(body || '{}');
      } catch {
        return sendJson(res, 400, { ok: false });
      }
      // 立刻回执，别让 NapCat 等模型
      sendJson(res, 200, { ok: true });
      void handleIncoming(evt).catch((e) => {
        qqLastError = e instanceof Error ? e.message : String(e);
        console.warn('[dsh-pet-plus] QQ 入站处理失败：' + qqLastError);
      });
      return;
    }

    return sendJson(res, 404, { ok: false, error: 'not found' });
  }

  // ---- 右键菜单扩展（dsh-pet 的第三方菜单注册表）
  async function menuLoop() {
    let registered = false;
    while (!disposed) {
      try {
        if (!registered) {
          const res = await fetch(`${origin}${PET}/menu/item`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ owner: 'dsh-pet-plus', labels: ['摸摸', '喂食', '状态'] }),
            signal: AbortSignal.timeout(SHORT_MS),
          });
          const j = await res.json().catch(() => ({}));
          registered = j?.ok === true;
          if (!registered) {
            await new Promise((r) => setTimeout(r, 5000));
            continue;
          }
        }
        const res = await fetch(`${origin}${PET}/menu/events?owner=dsh-pet-plus&wait=10000`, {
          signal: AbortSignal.timeout(20_000),
        });
        const j = await res.json().catch(() => ({}));
        if (j?.ok && j.events) {
          for (const [label, petId] of Object.entries(j.events)) {
            if (!petId) continue;
            if (label === '摸摸') await doPat('menu');
            else if (label === '喂食') await doFeed('');
            else if (label === '状态') await petSay(affectionSummary());
          }
        } else if (j?.reason === 'unknown-owner') {
          registered = false;
        }
      } catch {
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
  }

  // ---- 启动
  loadConfig();
  loadState();

  ctx.effect(() => {
    const off = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: (req, res) => {
        handleRoute(req, res).catch((e) => {
          try {
            if (!res.writableEnded) sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
          } catch {
            /* 连接已断 */
          }
        });
      },
    });
    return () => off();
  }, 'dsh-pet-plus: routes');

  ctx.effect(() => {
    const timer = setInterval(() => void tick(), 20_000);
    void tick();
    return () => clearInterval(timer);
  }, 'dsh-pet-plus: reminder timer');

  ctx.effect(() => {
    void menuLoop();
    return () => {
      disposed = true;
    };
  }, 'dsh-pet-plus: menu loop');

  // ---- 斜杠命令
  // 命令名必须是 /^[a-z][a-z0-9_-]*$/，所以用英文短名，描述保持中文。
  const commandDefs = [
    { name: 'pat', description: '摸摸桌宠（+亲密度）', run: () => doPat('command') },
    { name: 'feed', description: '喂桌宠吃东西（+亲密度、+饱食）', hint: '[食物名]', run: (a) => doFeed(a) },
    { name: 'raise', description: '查看亲密度 / 饥饿度 / 签到', run: async () => ({ text: affectionSummary() }) },
    {
      name: 'remind',
      description: '查看定时提醒（喝水 / 久坐 / 番茄钟）',
      run: async () => ({
        text: reminderSnapshot()
          .map((r) => `${r.enabled ? '✅' : '⭕'} ${r.label}（每 ${r.everyMin} 分钟，下次 ${r.nextLabel}）`)
          .join('\n'),
      }),
    },
    {
      name: 'qq',
      description: '查看 QQ 接入状态（NapCat / OneBot 11）',
      run: async () => {
        if (!cfg.qq.enabled) return { text: 'QQ 接入未启用：设置 → 插件 → 桌宠增强 里打开' };
        const h = await qqHealth();
        return {
          text: h.ok ? `NapCat 已连接：${h.nickname || ''}（${h.selfId}）` : `NapCat 连不上：${h.reason ?? 'unknown'}`,
        };
      },
    },
  ];
  for (const def of commandDefs) {
    ctx.effect(
      () =>
        ctx.commands.register({
          name: def.name,
          description: def.description,
          ...(def.hint ? { input: { hint: def.hint } } : {}),
          handler: async ({ rawInput }) => {
            try {
              const r = await def.run(String(rawInput ?? '').trim());
              return { kind: r.ok === false ? 'error' : 'success', text: r.text };
            } catch (e) {
              return { kind: 'error', text: e instanceof Error ? e.message : String(e) };
            }
          },
        }),
      'dsh-pet-plus: /' + def.name,
    );
  }

  pushEvent('boot', '桌宠增强已启动');
  console.log('[dsh-pet-plus] 已加载，宠物=' + cfg.petId + '，QQ=' + (cfg.qq.enabled ? 'on' : 'off'));
}
