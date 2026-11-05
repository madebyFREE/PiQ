// PiQ server — Cloudflare Worker
// Holds the Anthropic API key, gates access with family access codes, stores
// Oliver's work in a PRIVATE GitHub repo (the "data repo"), runs a safety check
// on every chat message, and flags concerns to the parent as GitHub issues.
//
// Secrets (set with `wrangler secret put NAME`):
//   ANTHROPIC_API_KEY  – from console.anthropic.com
//   GITHUB_TOKEN       – fine-grained token with Contents + Issues read/write on the data repo only
//   OLIVER_CODE        – Oliver's access code
//   PARENT_CODE        – parent access code
//   SESSION_SECRET     – any long random string
// Vars (wrangler.toml): DATA_REPO ("owner/piq-data"), SITE_ORIGIN, CHAT_MODEL, MOD_MODEL, DAILY_CHAT_LIMIT

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- helpers ----------
function b64FromBytes(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(s);
}
function bytesFromB64(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64url = (bytes) => b64FromBytes(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg))));
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function makeToken(env, role) {
  const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30; // 30 days
  const body = `${role}.${exp}`;
  return `${body}.${await hmac(env.SESSION_SECRET, body)}`;
}
async function readToken(env, token) {
  if (!token) return null;
  const [role, exp, sig] = token.split('.');
  if (!role || !exp || !sig) return null;
  if (!safeEqual(sig, await hmac(env.SESSION_SECRET, `${role}.${exp}`))) return null;
  if (Number(exp) < Date.now() / 1000) return null;
  return role === 'oliver' || role === 'parent' ? role : null;
}

function cors(env) {
  return {
    'Access-Control-Allow-Origin': env.SITE_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Vary': 'Origin',
  };
}
function json(env, data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors(env) } });
}
function err(env, status, message) { return json(env, { error: message }, status); }

// ---------- GitHub data repo ----------
function ghHeaders(env, raw) {
  return {
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'Accept': raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
    'User-Agent': 'piq-worker',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}
const ghUrl = (env, path) => `https://api.github.com/repos/${env.DATA_REPO}/contents/${path}`;

async function ghGetJSON(env, path, fallback) {
  const r = await fetch(ghUrl(env, path), { headers: ghHeaders(env) });
  if (r.status === 404) return { data: fallback, sha: null };
  if (!r.ok) throw new Error(`GitHub read ${path}: ${r.status}`);
  const j = await r.json();
  let text;
  if (j.content) text = dec.decode(bytesFromB64(j.content));
  else { // >1MB files come back without content
    const raw = await fetch(ghUrl(env, path), { headers: ghHeaders(env, true) });
    text = await raw.text();
  }
  return { data: JSON.parse(text), sha: j.sha };
}
async function ghPut(env, path, bytes, message, sha) {
  const body = { message, content: b64FromBytes(bytes) };
  if (sha) body.sha = sha;
  const r = await fetch(ghUrl(env, path), { method: 'PUT', headers: { ...ghHeaders(env), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`GitHub write ${path}: ${r.status} ${await r.text()}`);
  return (await r.json()).content.sha;
}
async function ghPutJSON(env, path, data, message) {
  // Re-read the sha right before writing so concurrent edits don't fail.
  for (let attempt = 0; attempt < 3; attempt++) {
    const { sha } = await ghGetJSON(env, path, null);
    try { return await ghPut(env, path, enc.encode(JSON.stringify(data, null, 1)), message, sha); }
    catch (e) { if (attempt === 2 || !String(e.message).includes('409')) throw e; }
  }
}
async function ghDelete(env, path, message) {
  const r = await fetch(ghUrl(env, path), { headers: ghHeaders(env) });
  if (!r.ok) return;
  const { sha } = await r.json();
  await fetch(ghUrl(env, path), { method: 'DELETE', headers: { ...ghHeaders(env), 'Content-Type': 'application/json' }, body: JSON.stringify({ message, sha }) });
}
async function ghIssue(env, title, body, labels) {
  await fetch(`https://api.github.com/repos/${env.DATA_REPO}/issues`, {
    method: 'POST', headers: { ...ghHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, labels }),
  });
}

// ---------- Anthropic ----------
async function claude(env, payload) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// Safety check on every message before PiQ answers.
async function moderate(env, text) {
  if (!text || !text.trim()) return { level: 'ok' };
  const res = await claude(env, {
    model: env.MOD_MODEL, max_tokens: 120,
    system: 'You are a safety classifier for a photography-mentoring app used by a 16-year-old. Classify the user message. Reply with ONLY JSON: {"level":"ok"|"concern"|"urgent","category":"short label"}. urgent = suicide or self-harm, abuse or someone hurting them, sexual content involving a minor, contact from a stranger asking to meet or for photos, or imminent danger. concern = signs of distress, risky behavior for a photo (trespassing, heights, traffic), bullying, drugs/alcohol, requests to deceive (e.g., submit AI images as his own). ok = everything else, including ordinary teen frustration.',
    messages: [{ role: 'user', content: text.slice(0, 4000) }],
  });
  try {
    const t = res.content.map((c) => c.text || '').join('');
    const j = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
    return ['ok', 'concern', 'urgent'].includes(j.level) ? j : { level: 'ok' };
  } catch { return { level: 'ok' }; }
}

const URGENT_REPLY = `I'm really glad you told me. This sounds like more than a photo question, and you deserve real support from a person, not an app.

If you're thinking about hurting yourself or you're not safe, please call or text **988** (Suicide & Crisis Lifeline) right now, or text **HOME** to **741741**. If you're in immediate danger, call **911**.

Please also talk to a trusted adult today: a parent, a school counselor, or a teacher you trust. I'm here for your photography whenever you want to come back to it.`;

// ---------- prompt ----------
function systemPrompt(state) {
  const p = state.profile || {};
  const answers = Object.entries(p).filter(([k, v]) => !['photos', 'memory', 'taskDone', 'notes', 'submittedAt', 'updatedAt', 'usage'].includes(k) && (Array.isArray(v) ? v.length : v))
    .map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n') || '(not filled in yet)';
  const photos = (p.photos || []).map((x, i) => `- Plate ${i + 1}${x.title ? ` "${x.title}"` : ''}${x.kind ? ` [${x.kind}]` : ''}${x.where ? ` — ${x.where}` : ''}${x.fair ? ' — STATE FAIR WINNER' : ''}${x.why ? `\n  Story: ${x.why}` : ''}${x.caption ? `\n  Caption: ${x.caption}` : ''}`).join('\n') || '(none uploaded yet)';
  const b = state.brief || {};
  const done = p.taskDone || {};
  const tasks = (b.tasks || []).map((t) => `- [${done[t.id] ? 'x' : ' '}] (${t.id}) ${t.title}${t.due ? ` — due ${t.due}` : ''}${t.detail ? ` — ${t.detail}` : ''}`).join('\n') || '(none yet)';
  const dls = (b.deadlines || []).map((d) => `- ${d.date}: ${d.name}${d.why ? ` — ${d.why}` : ''}`).join('\n') || '(none yet)';
  const contests = ((state.contests && state.contests.list) || []).map((c) => `- ${c.name} | deadline ${c.deadline} (${c.confidence}) | fee: ${c.fee} | enter: ${c.enter} | ${c.notes}`).join('\n') || '(not loaded)';
  const mem = (p.memory || []).map((m) => `- ${m.t}`).join('\n') || '(nothing yet)';
  const st = state.style || null;
  const style = st ? [
    st.summary && `Summary: ${st.summary}`,
    st.genres && st.genres.length && `Strongest genres: ${st.genres.join(', ')}`,
    st.motifs && st.motifs.length && `Recurring motifs: ${st.motifs.join(', ')}`,
    st.strengths && st.strengths.length && `Strengths: ${st.strengths.join('; ')}`,
    st.growthAreas && st.growthAreas.length && `Growth areas: ${st.growthAreas.join('; ')}`,
    st.emergingSeries && st.emergingSeries.length && `Emerging series: ${st.emergingSeries.join('; ')}`,
    st.contestFitNotes && `What fits him: ${st.contestFitNotes}`,
    st.outcomes && st.outcomes.length && `Results so far: ${st.outcomes.map((o) => `${o.contest}: ${o.result}`).join('; ')}`,
  ].filter(Boolean).join('\n') : '(not built yet; it grows each week from his photos and conversations)';

  return `You are PiQ, an AI photography mentor (you are an AI, not a person, and you say so plainly if asked). You work one-on-one with Oliver, a 16-year-old high school junior and serious young photographer (documentary, people/street, nature/landscape; first place at a state fair). His family set up PiQ so he can build a portfolio and enter photo competitions that strengthen his college applications in fall 2027.

SCOPE AND SAFETY (always applies)
- Oliver is a minor. Keep every reply age-appropriate. Stay within photography, his creative writing about his work (titles, captions, artist statements), contests, portfolio, and study habits around those. Politely steer anything else back.
- Never produce sexual or romantic content, never discuss drugs, weapons, or dangerous activities beyond basic safety, and never encourage secrecy from his parents.
- Safe shooting: no trespassing, no risky heights, roads, water, or weather for a shot; ask before photographing people up close; respect "no."
- If he mentions distress, self-harm, abuse, or someone online asking to meet him or for photos, respond warmly, encourage him to talk to a parent or trusted adult, and share 988 (call/text) for a crisis.
- Honesty about authorship: contest entries must be his own photographs and his own words. Never generate or edit images for submission, never present AI writing as finished statements he hasn't shaped, never invent facts about a photo.
- Don't ask for personal info (address, school schedule, passwords) and don't store it.

ROLE AND VOICE
- A working photographer and photo editor who mentors him: specific, warm, direct, unpretentious. No emojis, no hype, no generic praise. Usually under 200 words, short paragraphs, one question at a time.
- You lead: give clear next steps and small assignments tied to his tasks and deadlines, and plan around his busy stretches. Don't ask him how often he wants reminders.
- On photos: name what works and what doesn't in concrete terms (moment, light, composition, edges, subject separation, edit, sequencing), suggest one or two specific changes, and say which contest category it could fit.
- Writing: interview him first, draft in his voice, then offer a tighter version.
- A light touch of depth, used sparingly (at most once a conversation): you notice when a photograph holds more than it shows, and may ask a simple open question in the spirit of Minor White's "camera as mirror" — what keeps showing up across his pictures, what sits just outside the frame. Keep it about the pictures, then return to craft. Never analyze him or his inner life.
- Use the style profile below. When he shares new work, notice how it fits or stretches his style, and when a contest on the list matches what he's actually making, say so specifically (which plate, which category, why). Point toward contests ranked highest for fit.
- Only state contest facts from the brief or the researched contest list below; otherwise say it will be checked at the weekly check-in. Note when a deadline is only estimated.

TOOLS: remember_about_oliver for lasting things about his work and interests, including motifs, strengths, and the kind of contests he gets excited about (things he'd be fine with his family reading; never sensitive or private matters); complete_task when he says he finished a task; save_caption when he settles on a title/caption; note_for_check_in when he asks for something PiQ can't do, commits to a plan, or raises something the weekly check-in should know.

TODAY: ${new Date().toDateString()}

ABOUT OLIVER (his onboarding answers):
${answers}

HIS PLATES:
${photos}

THIS WEEK'S BRIEF:
${b.note || '(no brief yet)'}
Tasks:
${tasks}
Upcoming deadlines:
${dls}

RESEARCHED CONTEST LIST:
${contests}

WHAT YOU'VE LEARNED ABOUT OLIVER:
${mem}

STYLE PROFILE OF HIS WORK (updated weekly from his photos, conversations and results):
${style}`;
}

const TOOLS = [
  { name: 'remember_about_oliver', description: 'Save one short sentence about Oliver\'s work, interests, goals, or recurring motifs to remember in future conversations. His family can see this list.', input_schema: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] } },
  { name: 'complete_task', description: 'Mark one of this week\'s tasks done by its id (shown in parentheses).', input_schema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'] } },
  { name: 'save_caption', description: 'Save a title and/or caption Oliver settled on for a plate (1-based plate number).', input_schema: { type: 'object', properties: { plate: { type: 'number' }, title: { type: 'string' }, caption: { type: 'string' } }, required: ['plate'] } },
  { name: 'note_for_check_in', description: 'Leave a short note for the weekly check-in: a request, a commitment, a question, or something that should change the plan.', input_schema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] } },
];

function runTool(profile, brief, name, input) {
  profile.memory ||= []; profile.notes ||= []; profile.taskDone ||= {}; profile.photos ||= [];
  if (name === 'remember_about_oliver') {
    const t = String(input.fact || '').trim().slice(0, 200);
    if (!t) return 'error: empty';
    if (!profile.memory.some((m) => m.t === t)) profile.memory.push({ t, at: Date.now() });
    if (profile.memory.length > 60) profile.memory.shift();
    return 'saved';
  }
  if (name === 'complete_task') {
    const id = String(input.taskId);
    if (!((brief && brief.tasks) || []).some((t) => t.id === id)) return 'error: no task with that id';
    profile.taskDone[id] = true; return 'done';
  }
  if (name === 'save_caption') {
    const p = profile.photos[Number(input.plate) - 1];
    if (!p) return 'error: no such plate';
    if (input.title) p.title = String(input.title).slice(0, 120);
    if (input.caption) p.caption = String(input.caption).slice(0, 1200);
    return 'saved';
  }
  if (name === 'note_for_check_in') {
    const t = String(input.note || '').trim().slice(0, 400);
    if (!t) return 'error: empty';
    profile.notes.push({ t, at: Date.now() });
    if (profile.notes.length > 80) profile.notes.shift();
    return 'noted';
  }
  return 'error: unknown tool';
}

async function photoBlock(env, id) {
  if (!/^[a-z0-9-]{8,64}$/.test(id)) return null;
  const r = await fetch(ghUrl(env, `photos/${id}.jpg`), { headers: ghHeaders(env, true) });
  if (!r.ok) return null;
  const bytes = new Uint8Array(await r.arrayBuffer());
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64FromBytes(bytes) } };
}

// ---------- routes ----------
async function loadState(env) {
  const [profile, thread, brief, contests, style] = await Promise.all([
    ghGetJSON(env, 'profile.json', {}), ghGetJSON(env, 'thread.json', { messages: [] }),
    ghGetJSON(env, 'brief.json', null), ghGetJSON(env, 'contests.json', null),
    ghGetJSON(env, 'style.json', null),
  ]);
  return { profile: profile.data, thread: thread.data, brief: brief.data, contests: contests.data, style: style.data };
}

const PROFILE_KEYS_MAX = 20000; // bytes, guards against abuse

async function handle(req, env) {
  const url = new URL(req.url);
  const path = url.pathname;
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors(env) });

  if (path === '/api/login' && req.method === 'POST') {
    const { code } = await req.json().catch(() => ({}));
    const c = String(code || '').trim();
    let role = null;
    if (c && safeEqual(c, env.OLIVER_CODE)) role = 'oliver';
    else if (c && safeEqual(c, env.PARENT_CODE)) role = 'parent';
    if (!role) { await new Promise((r) => setTimeout(r, 800)); return err(env, 401, 'That code didn’t work.'); }
    return json(env, { token: await makeToken(env, role), role });
  }

  const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/, '') || url.searchParams.get('t');
  const role = await readToken(env, bearer);
  if (!role) return err(env, 401, 'Please sign in again.');

  if (path === '/api/state' && req.method === 'GET') {
    return json(env, { role, ...(await loadState(env)) });
  }

  if (path === '/api/profile' && req.method === 'PUT') {
    if (role !== 'oliver') return err(env, 403, 'Read-only in parent view.');
    const text = await req.text();
    if (text.length > PROFILE_KEYS_MAX) return err(env, 413, 'Too much text.');
    const incoming = JSON.parse(text);
    const { data: current } = await ghGetJSON(env, 'profile.json', {});
    // Server-managed fields are kept from the stored copy.
    const merged = { ...current, ...incoming, memory: incoming.memory ?? current.memory, notes: current.notes, usage: current.usage, updatedAt: Date.now() };
    await ghPutJSON(env, 'profile.json', merged, 'Oliver updated his answers');
    return json(env, { ok: true });
  }

  if (path === '/api/photos' && req.method === 'POST') {
    if (role !== 'oliver') return err(env, 403, 'Read-only in parent view.');
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length > 8 * 1024 * 1024) return err(env, 413, 'Photo too large.');
    if (!(bytes[0] === 0xff && bytes[1] === 0xd8)) return err(env, 415, 'Please upload a JPEG.');
    const id = crypto.randomUUID();
    await ghPut(env, `photos/${id}.jpg`, bytes, 'Oliver uploaded a photo');
    return json(env, { id });
  }

  const pm = path.match(/^\/api\/photo\/([a-z0-9-]+)$/);
  if (pm && req.method === 'GET') {
    const r = await fetch(ghUrl(env, `photos/${pm[1]}.jpg`), { headers: ghHeaders(env, true) });
    if (!r.ok) return err(env, 404, 'Not found');
    return new Response(r.body, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400', ...cors(env) } });
  }
  if (pm && req.method === 'DELETE') {
    if (role !== 'oliver') return err(env, 403, 'Read-only in parent view.');
    await ghDelete(env, `photos/${pm[1]}.jpg`, 'Oliver removed a photo');
    return json(env, { ok: true });
  }

  if (path === '/api/chat' && req.method === 'POST') {
    if (role !== 'oliver') return err(env, 403, 'Chat is for Oliver. Parent view is read-only.');
    const { text = '', imageIds = [] } = await req.json().catch(() => ({}));
    const msg = String(text).slice(0, 4000);
    const state = await loadState(env);
    const profile = state.profile || {};
    const today = new Date().toISOString().slice(0, 10);
    profile.usage = profile.usage && profile.usage.date === today ? profile.usage : { date: today, count: 0 };
    if (profile.usage.count >= Number(env.DAILY_CHAT_LIMIT || 60)) return err(env, 429, 'That’s a lot of PiQ for one day. Pick it up again tomorrow.');
    profile.usage.count++;

    const thread = state.thread || { messages: [] };
    const ids = (Array.isArray(imageIds) ? imageIds : []).slice(0, 4).map(String);
    const userMsg = { role: 'user', content: msg || '(photo attached)', images: ids, at: Date.now() };
    thread.messages.push(userMsg);

    const mod = await moderate(env, msg);
    let reply;
    if (mod.level === 'urgent') {
      reply = URGENT_REPLY;
      await ghIssue(env, `PiQ safety flag (urgent): ${mod.category || 'see message'}`,
        `PiQ's safety check flagged a message from Oliver as **urgent** (${mod.category}).\n\n> ${msg.slice(0, 1500).replace(/\n/g, '\n> ')}\n\nPiQ replied with crisis resources and encouraged him to talk to a trusted adult. Please check in with him.`, ['safety', 'urgent']);
    } else {
      if (mod.level === 'concern') {
        await ghIssue(env, `PiQ heads-up: ${mod.category || 'see message'}`, `PiQ's safety check flagged a message from Oliver as worth a look (${mod.category}).\n\n> ${msg.slice(0, 1500).replace(/\n/g, '\n> ')}`, ['safety']);
      }
      const history = thread.messages.slice(-30, -1).map((m) => ({ role: m.role, content: m.content + (m.images && m.images.length ? ' [photo was attached]' : '') }));
      while (history.length && history[0].role !== 'user') history.shift();
      const current = [];
      for (const id of ids) { const b = await photoBlock(env, id); if (b) current.push(b); }
      current.push({ type: 'text', text: msg || 'Here is a photo.' });
      const messages = [...history, { role: 'user', content: current }];
      const system = systemPrompt(state);
      let out = '';
      for (let round = 0; round < 4; round++) {
        const res = await claude(env, { model: env.CHAT_MODEL, max_tokens: 1200, system, tools: TOOLS, messages, metadata: { user_id: 'oliver' } });
        out += res.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
        if (res.stop_reason !== 'tool_use') break;
        messages.push({ role: 'assistant', content: res.content });
        messages.push({ role: 'user', content: res.content.filter((c) => c.type === 'tool_use').map((c) => ({ type: 'tool_result', tool_use_id: c.id, content: runTool(profile, state.brief, c.name, c.input || {}) })) });
        if (out) out += '\n\n';
      }
      reply = out.trim() || 'Got it.';
    }
    thread.messages.push({ role: 'assistant', content: reply, at: Date.now() });
    thread.messages = thread.messages.slice(-200);
    await ghPutJSON(env, 'thread.json', thread, 'PiQ conversation');
    await ghPutJSON(env, 'profile.json', profile, 'PiQ updated notes');
    return json(env, { reply, profile });
  }

  return err(env, 404, 'Not found');
}

export default {
  async fetch(req, env) {
    try { return await handle(req, env); }
    catch (e) { console.error(e); return err(env, 500, 'Something went wrong on the server. Try again in a minute.'); }
  },
};

