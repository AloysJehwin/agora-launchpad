/* global AgoraRTC, AgoraRTM */
// Browser side of the voice companion.
// RTC carries the audio both ways; RTM carries transcripts, agent state, errors and latency metrics.

const $ = (id) => document.getElementById(id);
const el = {
  orb: $('orb'), state: $('state'), hint: $('hint'), toggle: $('toggle'), mute: $('mute'),
  notice: $('notice'), meters: $('meters'), levelYou: $('level-you'), levelAgent: $('level-agent'),
  lines: $('lines'), empty: $('empty'), footer: $('footer'), agentName: $('agent-name'),
};

const session = { rtc: null, rtm: null, mic: null, channel: null, uid: null, agentUid: null, live: false, busy: false };
const lines = new Map(); // "role:turn" -> <li>

const STATES = {
  idle: ['Ready when you are', 'Press start and say hello.'],
  connecting: ['Connecting', 'Joining the room and waking the companion.'],
  listening: ['Listening', 'Go ahead, I am listening.'],
  thinking: ['Thinking', ''],
  speaking: ['Speaking', 'Just start talking to interrupt.'],
  ended: ['Conversation ended', 'Press start to talk again.'],
};

const setState = (name, hint) => {
  const [label, defaultHint] = STATES[name] ?? STATES.idle;
  el.orb.dataset.state = name === 'ended' ? 'idle' : name;
  el.state.textContent = label;
  el.hint.textContent = hint ?? defaultHint;
};
const notify = (message) => {
  el.notice.hidden = !message;
  el.notice.textContent = message ?? '';
};
const post = async (path, body = {}) => {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${path} failed with ${res.status}`);
  return data;
};

// ------------------------------------------------------------ transcript ----

const upsertLine = (role, turn, text, { final, interrupted }) => {
  if (!text) return;
  const key = `${role}:${turn}`;
  let li = lines.get(key);
  if (!li) {
    li = document.createElement('li');
    li.dataset.role = role;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = role === 'agent' ? el.agentName.textContent : 'You';
    const body = document.createElement('span');
    body.className = 'text';
    li.append(who, body);
    el.lines.append(li);
    lines.set(key, li);
    el.empty.hidden = true;
  }
  li.querySelector('.text').textContent = text;
  li.dataset.final = String(Boolean(final));
  li.dataset.interrupted = String(Boolean(interrupted));
  li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
};

// Agent state as reported by Agora: idle | silent | listening | thinking | speaking
const applyAgentState = (state) => {
  if (!session.live || !state) return;
  const hint = session.mic ? undefined : 'Listening only: the microphone is off.';
  if (state === 'speaking') setState('speaking');
  else if (state === 'thinking') setState('thinking');
  else setState('listening', hint);
};

const SEGMENTS = {
  algorithm_processing: 'audio processing',
  asr_ttlw: 'speech recognition',
  llm_ttft: 'model first token',
  llm_ftfs: 'model first sentence',
  tts_ttfb: 'Murf first audio',
  transport: 'network',
};

// Events arrive without an `object` field: { event_type: 'state.speaking' | 'turn.finished' | ..., payload }
const onAgentEvent = (type, payload = {}) => {
  if (type.startsWith('state.')) {
    const name = type.slice('state.'.length);
    applyAgentState(payload.value === false ? 'listening' : name);
  } else if (type === 'turn.finished') {
    if (payload.end?.type === 'error') {
      notify(`That turn failed (${payload.end.metadata?.reason ?? 'error'}). ${payload.end.metadata?.details ?? ''}`.trim());
    }
    const segments = (payload.metrics?.segmented_latency_ms ?? []).map((s) => `${SEGMENTS[s.name] ?? s.name} ${Math.round(s.latency)} ms`);
    if (payload.metrics?.e2e_latency_ms != null) {
      el.footer.textContent = `Last turn: ${payload.metrics.e2e_latency_ms} ms to first audio${segments.length ? ` (${segments.join(' · ')})` : ''}`;
    }
  }
};

const onAgentMessage = (raw) => {
  let msg;
  try { msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch { return; }
  window.__voice.messages.push(msg);
  if (msg.event_type) return onAgentEvent(msg.event_type, msg.payload);
  switch (msg.object) {
    case 'assistant.transcription':
      // turn_status: 0 in progress, 1 finished, 2 interrupted
      upsertLine('agent', msg.turn_id, msg.text, { final: msg.turn_status !== 0, interrupted: msg.turn_status === 2 });
      break;
    case 'user.transcription':
      upsertLine('user', msg.turn_id, msg.text, { final: msg.final });
      break;
    case 'message.state':
      applyAgentState(msg.state);
      break;
    case 'message.error':
      notify(`The companion hit a problem in ${msg.module ?? 'the pipeline'}: ${msg.message ?? msg.code ?? 'unknown error'}`);
      break;
    default:
      // message.metrics arrives per module; the turn.finished event above carries the full breakdown.
      break;
  }
  return undefined;
};

// ----------------------------------------------------------------- start ----

const start = async () => {
  setState('connecting');
  notify(null);
  el.lines.replaceChildren();
  lines.clear();
  el.empty.hidden = false;

  const grant = await post('/api/token');
  Object.assign(session, { channel: grant.channel, uid: grant.uid, agentUid: grant.agentUid });

  // 1. Audio: join the channel, play whatever the agent publishes.
  const rtc = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
  session.rtc = rtc;
  rtc.on('user-published', async (user, mediaType) => {
    if (mediaType !== 'audio') return;
    await rtc.subscribe(user, mediaType);
    user.audioTrack?.play();
  });
  rtc.on('user-left', (user) => {
    if (session.live && user.uid === session.agentUid) stop('The companion left the conversation.');
  });
  rtc.enableAudioVolumeIndicator();
  rtc.on('volume-indicator', (volumes) => {
    let you = 0;
    let agent = 0;
    for (const v of volumes) {
      if (v.uid === session.uid) you = v.level;
      else if (v.uid === session.agentUid) agent = v.level;
    }
    el.levelYou.style.width = `${Math.min(100, you)}%`;
    el.levelAgent.style.width = `${Math.min(100, agent)}%`;
    el.orb.style.setProperty('--level', (Math.min(100, Math.max(you, agent)) / 100).toFixed(2));
  });
  await rtc.join(grant.appId, grant.channel, grant.rtcToken, grant.uid);

  // 2. Microphone. Without it the companion can still be heard, so carry on and say so.
  try {
    session.mic = await AgoraRTC.createMicrophoneAudioTrack({ AEC: true, ANS: true, AGC: true });
    await rtc.publish(session.mic);
    el.mute.hidden = false;
  } catch (err) {
    session.mic = null;
    notify(`Microphone unavailable (${err.code ?? err.name ?? 'blocked'}). You can hear the companion, but it cannot hear you. Allow the microphone for this page and start again.`);
  }

  // 3. Transcripts and agent state over RTM.
  try {
    const rtm = new AgoraRTM.RTM(grant.appId, String(grant.uid));
    session.rtm = rtm;
    rtm.addEventListener('message', (event) => onAgentMessage(event.message));
    rtm.addEventListener('presence', (event) => applyAgentState(event.stateChanged?.state));
    await rtm.login({ token: grant.rtmToken });
    await rtm.subscribe(grant.channel);
  } catch (err) {
    session.rtm = null;
    console.warn('RTM unavailable, transcripts are off:', err);
    el.empty.textContent = 'Live transcript is unavailable for this session. Audio still works.';
  }

  // 4. Bring the agent in.
  await post('/api/agent/start', { channel: grant.channel, lang: document.getElementById('call-lang')?.value || 'en' });

  session.live = true;
  el.meters.hidden = false;
  el.toggle.textContent = 'End conversation';
  el.toggle.dataset.active = 'true';
  setState('listening', session.mic ? undefined : 'Listening only: the microphone is off.');
};

// ------------------------------------------------------------------ stop ----

const stop = async (reason) => {
  const { channel, rtc, rtm, mic } = session;
  Object.assign(session, { rtc: null, rtm: null, mic: null, channel: null, live: false });
  if (channel) await post('/api/agent/stop', { channel }).catch((err) => console.warn(err));
  mic?.stop();
  mic?.close();
  await rtc?.leave().catch(() => {});
  await rtm?.logout().catch(() => {});
  el.mute.hidden = true;
  el.mute.setAttribute('aria-pressed', 'false');
  el.mute.textContent = 'Mute mic';
  el.meters.hidden = true;
  el.orb.style.setProperty('--level', '0');
  el.toggle.textContent = 'Start conversation';
  el.toggle.dataset.active = 'false';
  setState('ended', typeof reason === 'string' ? reason : undefined);
};

el.toggle.addEventListener('click', async () => {
  if (session.busy) return;
  session.busy = true;
  el.toggle.disabled = true;
  try {
    if (session.live) await stop();
    else await start();
  } catch (err) {
    console.error(err);
    await stop().catch(() => {});
    setState('idle');
    notify(`Could not start: ${err.message}`);
  } finally {
    session.busy = false;
    el.toggle.disabled = false;
  }
});

el.mute.addEventListener('click', async () => {
  if (!session.mic) return;
  const muted = el.mute.getAttribute('aria-pressed') !== 'true';
  await session.mic.setMuted(muted);
  el.mute.setAttribute('aria-pressed', String(muted));
  el.mute.textContent = muted ? 'Unmute mic' : 'Mute mic';
});

// Browsers block audio that starts without a gesture; Agora tells us when that happens.
AgoraRTC.onAutoplayFailed = () => notify('Your browser blocked the sound. Click anywhere on the page to hear the companion.');
document.addEventListener('click', () => {
  if (el.notice.textContent.startsWith('Your browser blocked')) notify(null);
});

// Closing the tab should not leave an agent running until its idle timeout.
window.addEventListener('pagehide', () => {
  if (session.channel) navigator.sendBeacon('/api/agent/stop', JSON.stringify({ channel: session.channel }));
});

// Handle for debugging from the console: window.__voice.session, window.__voice.messages
window.__voice = { session, messages: [] };

fetch('/api/health').then((r) => r.json()).then((health) => {
  el.agentName.textContent = health.agent?.name ?? 'Companion';
  if (!health.ok) {
    el.toggle.disabled = true;
    notify(`The server is missing ${health.missing.join(', ')}. Fill .env and restart.`);
    return;
  }
  el.footer.textContent = `Voice: Murf Falcon, ${health.agent.voice} · Model: ${health.agent.model} (${health.agent.llm})`;
}).catch(() => notify('Cannot reach the server. Is it running?'));
