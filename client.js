/**
 * dsh-pet-plus 的浏览器半侧：
 *   1. 在「设置 → 插件」里加一页「桌宠增强」，可视化配置 QQ 接入 / 养成 / 提醒；
 *   2. 轮询 /dsh-pet-plus/state：摸摸、喂食、提醒到点时播一声提示音（WebAudio 合成，不带素材）。
 *
 * 只读宿主自己的路由，不碰 dsh-pet 的 DOM；宠物显示在桌面端时这里也照样工作（声音在页面里响）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-pet-plus',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const BASE = '/dsh-pet-plus';
    const box = {
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      fontSize: '13px',
      lineHeight: 1.6,
      color: 'inherit',
      maxWidth: '720px',
    };
    const card = {
      border: '1px solid rgba(127,127,127,.28)',
      borderRadius: '10px',
      padding: '14px 16px',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      background: 'rgba(127,127,127,.05)',
    };
    const row = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' };
    const label = { minWidth: '132px', opacity: 0.78 };
    const input = {
      flex: '1 1 220px',
      minWidth: '160px',
      padding: '5px 8px',
      borderRadius: '6px',
      border: '1px solid rgba(127,127,127,.4)',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
    };
    const button = {
      padding: '5px 12px',
      borderRadius: '6px',
      border: '1px solid rgba(127,127,127,.45)',
      background: 'rgba(127,127,127,.12)',
      color: 'inherit',
      cursor: 'pointer',
      font: 'inherit',
    };
    const hint = { opacity: 0.6, fontSize: '12px' };
    const bar = (pct, color) =>
      h(
        'div',
        { style: { height: '7px', borderRadius: '4px', background: 'rgba(127,127,127,.22)', overflow: 'hidden' } },
        h('div', {
          style: {
            width: Math.max(0, Math.min(100, pct)) + '%',
            height: '100%',
            borderRadius: '4px',
            background: color,
            transition: 'width .4s ease',
          },
        }),
      );

    async function api(path, init) {
      const res = await fetch(BASE + path, { credentials: 'same-origin', ...init });
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        return { ok: false, error: 'bad response: ' + text.slice(0, 120) };
      }
    }

    let audio = null;
    function play(type) {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        audio = audio || new Ctx();
        if (audio.state === 'suspended') void audio.resume();
        const now = audio.currentTime;
        const notes =
          type === 'reminder'
            ? [880, 1174, 1568]
            : type === 'levelup'
              ? [784, 988, 1319, 1568]
              : type === 'feed'
                ? [523, 659]
                : [659, 880];
        notes.forEach((f, i) => {
          const osc = audio.createOscillator();
          const gain = audio.createGain();
          osc.type = 'sine';
          osc.frequency.value = f;
          gain.gain.setValueAtTime(0.0001, now + i * 0.09);
          gain.gain.exponentialRampToValueAtTime(0.09, now + i * 0.09 + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.09 + 0.26);
          osc.connect(gain).connect(audio.destination);
          osc.start(now + i * 0.09);
          osc.stop(now + i * 0.09 + 0.3);
        });
      } catch {
        /* 无声环境忽略 */
      }
    }

    function Page() {
      const [state, setState] = React.useState(null);
      const [cfg, setCfg] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [msg, setMsg] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const seq = React.useRef(0);

      const load = React.useCallback(async () => {
        const s = await api('/state?since=' + seq.current);
        if (s && s.ok) {
          seq.current = s.seq || seq.current;
          setState(s);
          if (s.sound && Array.isArray(s.events)) {
            for (const e of s.events) {
              if (e.type === 'pat' || e.type === 'feed' || e.type === 'reminder' || e.type === 'levelup' || e.type === 'checkin') {
                play(e.type);
                break;
              }
            }
          }
        }
      }, []);

      React.useEffect(() => {
        void load();
        const timer = setInterval(() => void load(), 4000);
        return () => clearInterval(timer);
      }, [load]);

      React.useEffect(() => {
        void (async () => {
          const c = await api('/config');
          if (c && c.ok) {
            setCfg(c.config);
            setDraft(c.config);
          }
        })();
      }, []);

      const set = (path, value) => {
        setDraft((prev) => {
          const next = JSON.parse(JSON.stringify(prev));
          const keys = path.split('.');
          let cur = next;
          for (let i = 0; i < keys.length - 1; i += 1) {
            const k = keys[i];
            if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
            cur = cur[k];
          }
          cur[keys[keys.length - 1]] = value;
          return next;
        });
      };

      const save = async () => {
        setBusy(true);
        setMsg('保存中…');
        const r = await api('/config', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(draft),
        });
        setBusy(false);
        if (r && r.ok) {
          setCfg(r.config);
          setDraft(r.config);
          setMsg('已保存');
        } else setMsg('保存失败：' + (r?.error ?? 'unknown'));
      };

      const act = async (action, extra) => {
        setBusy(true);
        const r = await api('/action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, ...(extra ?? {}) }),
        });
        setBusy(false);
        setMsg(r?.result?.text || r?.text || r?.error || (r?.ok ? '完成' : '失败'));
        void load();
      };

      const health = async () => {
        setMsg('测试中…');
        const r = await api('/qq/health');
        setMsg(r?.ok ? `连接成功：${r.nickname || ''}（${r.selfId || ''}）` : `连不上：${r?.reason ?? r?.error ?? 'unknown'}`);
      };

      if (!draft) return h('div', { style: box }, '加载中…');

      const aff = state?.affection;
      const qq = state?.qq ?? {};

      return h(
        'div',
        { style: box },
        h(
          'div',
          { style: card },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            h('strong', {}, '桌宠增强'),
            h('span', { style: hint }, `宠物：${state?.petId ?? draft.petId}`),
          ),
          h('div', { style: hint },
            'QQ 互通（NapCat / OneBot 11）· 好感度养成 · 定时提醒 · 互动音效。依赖已安装的 dsh-pet。'),
          aff
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px' } },
                h('div', { style: row },
                  h('span', { style: label }, `亲密度 ${aff.points}`),
                  h('span', { style: hint }, `Lv.${aff.level.index} ${aff.level.name}`),
                  h('span', { style: { flex: 1 } }),
                  h('span', { style: hint }, aff.level.nextAt ? `距下一级 ${Math.max(0, aff.level.nextAt - aff.points)}` : '满级'),
                ),
                bar(aff.level.progress, 'linear-gradient(90deg,#7ac9ff,#4f8cff)'),
                h('div', { style: row }, h('span', { style: label }, `饥饿度 ${aff.hunger}%`)),
                bar(aff.hunger, aff.hunger < 28 ? '#ff8a5c' : '#68d391'),
                h('div', { style: row },
                  h('button', { style: button, disabled: busy, onClick: () => act('pat') }, '摸摸'),
                  h('button', { style: button, disabled: busy, onClick: () => act('feed', { food: '' }) }, '喂食'),
                  h('button', { style: button, disabled: busy, onClick: () => act('checkin') }, '签到'),
                  h('button', { style: button, disabled: busy, onClick: () => act('remind', {}) }, '立刻提醒一次'),
                  h('span', { style: { flex: 1 } }),
                  h('span', { style: hint }, `被摸 ${aff.pats} · 被喂 ${aff.feeds} · 连签 ${aff.checkinStreak} 天`),
                ),
              )
            : null,
        ),

        h(
          'div',
          { style: card },
          h('div', { style: row },
            h('strong', {}, 'QQ 接入'),
            h('span', {
              style: {
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: qq.enabled ? (qq.lastEventAt && Date.now() - qq.lastEventAt < 120000 ? '#48bb78' : '#ecc94b') : '#a0aec0',
              },
            }),
            h('span', { style: hint }, qq.enabled ? (qq.selfId ? `已启用（${qq.selfId}）` : '已启用，等待 NapCat') : '未启用'),
            h('span', { style: { flex: 1 } }),
            h('button', { style: button, onClick: health }, '测试连接'),
          ),
          h('div', { style: row },
            h('label', { style: { ...label, display: 'flex', gap: '6px', alignItems: 'center' } },
              h('input', {
                type: 'checkbox',
                checked: draft.qq.enabled === true,
                onChange: (e) => set('qq.enabled', e.target.checked),
              }),
              '启用 QQ 互通',
            ),
          ),
          h('div', { style: row }, h('span', { style: label }, 'NapCat API 地址'),
            h('input', { style: input, value: draft.qq.apiBase ?? '', placeholder: 'http://127.0.0.1:3000', onChange: (e) => set('qq.apiBase', e.target.value) })),
          h('div', { style: row }, h('span', { style: label }, 'Access Token'),
            h('input', { style: input, value: draft.qq.accessToken ?? '', onChange: (e) => set('qq.accessToken', e.target.value) })),
          h('div', { style: row }, h('span', { style: label }, '机器人 QQ 号'),
            h('input', { style: input, value: draft.qq.selfId ?? '', placeholder: '登录 NapCat 的那个号', onChange: (e) => set('qq.selfId', e.target.value) })),
          h('div', { style: row }, h('span', { style: label }, '允许私聊的 QQ'),
            h('input', { style: input, value: (draft.qq.allowedUsers ?? []).join(','), placeholder: '留空 = 所有人；多个用逗号', onChange: (e) => set('qq.allowedUsers', e.target.value.split(',').map((s) => s.trim()).filter(Boolean)) })),
          h('div', { style: row }, h('span', { style: label }, '允许的群号'),
            h('input', { style: input, value: (draft.qq.allowedGroups ?? []).join(','), placeholder: '留空 = 不响应群聊', onChange: (e) => set('qq.allowedGroups', e.target.value.split(',').map((s) => s.trim()).filter(Boolean)) })),
          h('div', { style: row }, h('label', { style: { ...label, display: 'flex', gap: '6px', alignItems: 'center' } },
            h('input', { type: 'checkbox', checked: draft.qq.groupRequireAt !== false, onChange: (e) => set('qq.groupRequireAt', e.target.checked) }),
            '群里必须 @ 才回应',
          )),
          h('div', { style: hint }, 'NapCat 的 HTTP 上报地址填：本机 /dsh-pet-plus/qq/event（详见 README）。'),
        ),

        h(
          'div',
          { style: card },
          h('strong', {}, '定时提醒'),
          ...(draft.reminders.list ?? []).map((r, i) =>
            h('div', { style: row, key: r.id || i },
              h('input', { type: 'checkbox', checked: r.enabled !== false, onChange: (e) => set(`reminders.list.${i}.enabled`, e.target.checked) }),
              h('input', { style: { ...input, flex: '0 1 110px' }, value: r.label ?? '', onChange: (e) => set(`reminders.list.${i}.label`, e.target.value) }),
              h('input', { style: { ...input, flex: '0 1 70px' }, value: r.everyMin ?? 45, onChange: (e) => set(`reminders.list.${i}.everyMin`, Number(e.target.value) || 1) }),
              h('span', { style: hint }, '分钟'),
              h('input', { style: input, value: r.text ?? '', onChange: (e) => set(`reminders.list.${i}.text`, e.target.value) }),
              h('label', { style: { ...hint, display: 'flex', gap: '4px', alignItems: 'center' } },
                h('input', { type: 'checkbox', checked: r.pushToQQ === true, onChange: (e) => set(`reminders.list.${i}.pushToQQ`, e.target.checked) }),
                '推 QQ',
              ),
            ),
          ),
          h('div', { style: row },
            h('label', { style: { ...label, display: 'flex', gap: '6px', alignItems: 'center' } },
              h('input', { type: 'checkbox', checked: draft.reminders.quiet?.enabled !== false, onChange: (e) => set('reminders.quiet.enabled', e.target.checked) }),
              '免打扰',
            ),
            h('input', { style: { ...input, flex: '0 1 90px' }, value: draft.reminders.quiet?.start ?? '23:30', onChange: (e) => set('reminders.quiet.start', e.target.value) }),
            h('span', { style: hint }, '至'),
            h('input', { style: { ...input, flex: '0 1 90px' }, value: draft.reminders.quiet?.end ?? '08:00', onChange: (e) => set('reminders.quiet.end', e.target.value) }),
            h('span', { style: { flex: 1 } }),
            h('label', { style: { ...hint, display: 'flex', gap: '4px', alignItems: 'center' } },
              h('input', { type: 'checkbox', checked: draft.sound !== false, onChange: (e) => set('sound', e.target.checked) }),
              '提示音',
            ),
          ),
        ),

        h('div', { style: row },
          h('button', { style: button, disabled: busy, onClick: save }, '保存设置'),
          h('span', { style: hint }, msg),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.plugins.tab', () =>
          ctx.slots.register(
            { name: 'settings.plugins.tab', id: 'dsh-pet-plus', order: 60, label: () => '桌宠增强' },
            Page,
          ),
        );
      },
    };
  },
});
