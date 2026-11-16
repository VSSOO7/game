'use strict';

const app = document.querySelector('#app');
const notice = document.querySelector('#notice');
const shareButton = document.querySelector('#share-invite');
const inviteDialog = document.querySelector('#invite');
const inviteInput = document.querySelector('#invite-url');
const homeButton = document.querySelector('#room-home');
const newGameButton = document.querySelector('#start-new-game');
const newGameDialog = document.querySelector('#new-game');
const themeButton = document.querySelector('#theme-toggle');
const musicButton = document.querySelector('#music-toggle');
const soundtrack = document.querySelector('#soundtrack');
const arrow = '<span class="arrow" aria-hidden="true">→</span>';
const primary = (label, attributes = '') => `<button class="button primary block" ${attributes}>${label} ${arrow}</button>`;
const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => entities[character]);
const nameText = (name) => `<bdi>${escapeHtml(name)}</bdi>`;
const words = (value) => value.trim().split(/\s+/u).filter((part) => /[\p{L}\p{N}]/u.test(part)).length;
const buttonAction = (action) => `type="button" data-action="${action}"`;
const storageKey = 'kaun-sus-private-room';

function remember(credentials) {
  try { sessionStorage.setItem(storageKey, JSON.stringify(credentials)); } catch {}
}

function getCredentials() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const host = fragment.get('host');
  const invite = fragment.get('join');
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem(storageKey)); } catch {}
  if (host) return { key: host };
  if (invite) return saved?.invite === invite ? saved : { key: invite, invite };
  return saved;
}

let credentials = getCredentials();
if (credentials) remember(credentials);
let room = null;
let clockOffset = 0;
let clockMeasuredAt = 0;
let active = false;
let networkErrors = 0;
let currentNotice = '';
let rendered = '';
let previousScreen = '';
let privateTurn = '';
let selectedVote = '';
let answerDraft = '';
let guestDraft = '';
let explanationDraft = '';
let seatKey = '';
const localNames = [];
let reservedSeats = 0;
let genres = null;
let resetTarget = null;
let capture = null;
let voiceDraft = null;
const voicePlaybacks = new Map();
let voiceStatus = '';
let nudgeTimer;
let floatTimer;
let sendNudgeTimer;
let nudgeSending = false;
const pendingNudges = [];
let nudgeAudio;
let emojiLane = 0;
const floatingNudges = [];
const seenNudges = new Set();
try { for (const id of JSON.parse(sessionStorage.getItem('kaun-sus-nudges') ?? '[]')) seenNudges.add(id); } catch {}
let chatDraft = '';
let chatPending = null;
let chatError = '';
let musicAllowed = false;
let musicEnabled = true;
try { musicEnabled = localStorage.getItem('kaun-sus-music') !== 'off'; } catch {}
const voiceSeconds = 20;

function syncMusic() {
  const voicePlaying = Array.from(app.querySelectorAll('audio')).some((voice) => !voice.paused && !voice.ended);
  soundtrack.volume = room?.phase === 'countdown' ? .48 : .32;
  if (!musicEnabled || !musicAllowed || !room || capture || voicePlaying || document.hidden) soundtrack.pause();
  else if (soundtrack.paused) soundtrack.play().catch(() => {});
}

function updateMusicButton() {
  musicButton.setAttribute('aria-pressed', String(musicAllowed && musicEnabled));
  musicButton.title = musicAllowed && musicEnabled ? 'Mute game audio' : 'Turn on game audio';
}

function unlockNudgeAudio() {
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!musicEnabled || !Context) return;
  nudgeAudio ??= new Context();
  if (nudgeAudio.state !== 'running') nudgeAudio.resume().catch(() => {});
}

musicButton.addEventListener('click', () => {
  musicEnabled = !(musicAllowed && musicEnabled);
  musicAllowed = true;
  try { localStorage.setItem('kaun-sus-music', musicEnabled ? 'on' : 'off'); } catch {}
  updateMusicButton();
  unlockNudgeAudio();
  syncMusic();
});
document.addEventListener('click', (event) => {
  if (!event.isTrusted || musicAllowed || musicButton.contains(event.target) || !room) return;
  musicAllowed = true;
  updateMusicButton();
  unlockNudgeAudio();
  syncMusic();
});
for (const event of ['play', 'pause', 'ended']) app.addEventListener(event, syncMusic, true);
document.addEventListener('visibilitychange', () => {
  syncMusic();
  deliverNudges();
});

const prefersDark = matchMedia('(prefers-color-scheme: dark)');
let themeChoice;
try { themeChoice = localStorage.getItem('kaun-sus-theme'); } catch {}
function updateTheme() {
  const dark = themeChoice ? themeChoice === 'dark' : prefersDark.matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]').content = dark ? '#10131d' : '#e9e7e0';
  themeButton.setAttribute('aria-pressed', String(dark));
  themeButton.querySelector('span').textContent = dark ? '☀' : '☾';
}
themeButton.addEventListener('click', () => {
  themeChoice = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('kaun-sus-theme', themeChoice); } catch {}
  updateTheme();
});
prefersDark.addEventListener('change', updateTheme);
updateTheme();

function inHomepage() {
  return new URLSearchParams(location.search).has('home');
}

function setHomepage(open, replace = false) {
  const url = new URL(location.href);
  if (open) url.searchParams.set('home', '1');
  else url.searchParams.delete('home');
  if (url.href !== location.href) history[replace ? 'replaceState' : 'pushState'](null, '', url);
}

function showNotice(message, kind = 'action') {
  currentNotice = message ? kind : '';
  notice.hidden = !message;
  notice.textContent = message;
}

async function api(body) {
  const sentAt = Date.now();
  const response = await fetch('/api/room', {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: 'Bearer ' + credentials.key,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000),
    cache: 'no-store'
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status });
  if (sentAt >= clockMeasuredAt) {
    clockOffset = data.serverNow - (sentAt + Date.now()) / 2;
    clockMeasuredAt = sentAt;
  }
  return data;
}

function apply(data) {
  if (room && data.version < room.version) return;
  const joined = room?.phase === 'lobby' && data.phase === 'lobby'
    ? data.players.filter(({ id, reserved }) => !reserved && !room.players.some((player) => player.id === id && !player.reserved)) : [];
  if (data.game !== room?.game || data.round !== room?.round) {
    chatDraft = '';
    chatPending = null;
    chatError = '';
    resetNudgeEffects();
    pendingNudges.length = 0;
  }
  if (data.host && data.phase === 'lobby' && data.game !== room?.game) {
    localNames.splice(0, localNames.length, ...(data.localDraft ?? []));
    reservedSeats = 0;
    genres = new Set(data.genres);
  }
  room = data;
  if (data.phase !== 'discussion') pendingNudges.length = 0;
  document.body.dataset.phase = data.phase;
  if (data.host && data.phase === 'lobby') setHomepage(false, true);
  const turn = `${data.game}/${data.round}/${data.phase}/${data.turn?.id ?? ''}`;
  if (turn !== privateTurn) {
    privateTurn = turn;
    selectedVote = '';
    answerDraft = '';
  }
  const hotSeat = data.hotSeat ? `${data.game}/${data.round}/${data.hotSeat.player}` : '';
  if (hotSeat !== seatKey) {
    seatKey = hotSeat;
    explanationDraft = '';
    clearVoiceDraft();
  }
  render();
  for (const { id } of joined) app.querySelector(`[data-roster-player="${CSS.escape(id)}"]`)?.classList.add('crew-arrived');
  deliverNudges();
}

async function poll() {
  const requestingKey = credentials.key;
  try {
    const data = await api();
    if (requestingKey === credentials.key) apply(data);
    networkErrors = 0;
    if (currentNotice === 'network') showNotice('');
  } catch (error) {
    if (error.status === 401) {
      if (credentials.invite && credentials.key !== credentials.invite) {
        credentials = { key: credentials.invite, invite: credentials.invite };
        remember(credentials);
        room = null;
        setTimeout(poll, 0);
        return;
      }
      renderUnavailable(error.message);
      return;
    }
    if (++networkErrors >= 2 && currentNotice !== 'action') showNotice('Reconnecting to the room…', 'network');
  }
  setTimeout(poll, 800);
}

async function act(action, fields = {}) {
  if (active) return;
  active = true;
  app.setAttribute('aria-busy', 'true');
  showNotice('');
  try {
    const { session, ...data } = await api({ action, game: room.game, round: room.round, ...fields });
    if (session) {
      credentials = { ...credentials, key: session };
      remember(credentials);
    }
    apply(data);
  } catch (error) {
    showNotice(error.status ? error.message : 'Couldn’t confirm that action. Reconnecting…');
  } finally {
    active = false;
    app.removeAttribute('aria-busy');
  }
}

function frame(content, { narrow = false, step = '', playerProgress = false } = {}) {
  const onHomepage = room.host && inHomepage();
  return `<div class="game ${narrow ? 'narrow' : ''}">
    <div class="round-meta"><span class="pill">${room.round ? `Round ${room.round}` : 'Private room'}</span>
      <div class="round-actions">${step ? `<span>${step}</span>` : ''}
        ${!onHomepage && votingChatOpen() ? `<button class="button help" ${buttonAction('jump-chat')}>Chat</button>` : ''}</div>
    </div>
    ${roundPhases()}
    ${content}
    ${playerProgress ? `<section class="panel player-progress" aria-labelledby="player-progress-heading">
      <div class="section-top"><h2 id="player-progress-heading">${room.phase.startsWith('vote') ? 'Voting progress' : 'Answer progress'}</h2>
        <span class="pill" id="progress-count" role="status"></span></div>
      <ul class="player-status-list" id="player-status-list"></ul>
    </section>` : ''}
    ${onHomepage ? '' : voteHistory() + discussionTimeline()}
  </div>`;
}

function votingChatOpen() {
  return room.phase === 'vote' || room.phase === 'votes-in';
}

function roundPhases() {
  const stage = { answer: 0, 'answers-in': 0, discussion: 1, vote: 2, 'votes-in': 2, countdown: 3, scoreboard: 3 }[room.phase];
  if (stage === undefined || (room.host && inHomepage())) return '';
  return `<ol class="round-phases" aria-label="Round phases">
    ${['Answer', 'Discuss', 'Vote', 'Reveal'].map((name, index) => `<li class="${index < stage ? 'complete' : ''}" ${index === stage ? 'aria-current="step"' : ''}><span aria-hidden="true"></span>${name}</li>`).join('')}
  </ol>`;
}

function crewBot(id, expression = '') {
  const variants = ['amber', 'teal', 'lavender', 'red', 'lime', 'blue', 'rose', 'gold', 'slate', 'mint', 'plum', 'copper'];
  const index = room?.players?.findIndex((player) => player.id === id) ?? -1;
  const color = index >= 0 ? variants[index % variants.length] : { dock: 'red', guest: 'teal', 'watch-b': 'lavender' }[id] ?? 'amber';
  return `<span class="crew-bot ${color} ${expression}" aria-hidden="true">
    <span class="bot-antenna"></span><span class="bot-head"><span class="bot-face"><i></i><i></i></span></span><span class="bot-base"></span>
  </span>`;
}

function playerName(id) {
  return id === 'host' ? 'The host' : room.players.find((player) => player.id === id)?.name ?? 'Player';
}

function deliverNudges() {
  if (document.hidden || !room?.self || !['discussion', 'vote', 'votes-in'].includes(room.phase)) return;
  const unread = room.receivedNudges?.filter(({ id, player }) => player === room.self.id && !seenNudges.has(id)) ?? [];
  for (const { id } of unread) seenNudges.add(id);
  while (seenNudges.size > 96) seenNudges.delete(seenNudges.values().next().value);
  if (unread.length) {
    try { sessionStorage.setItem('kaun-sus-nudges', JSON.stringify([...seenNudges])); } catch {}
  }
  floatingNudges.push(...unread);
  if (floatingNudges.length > 48) floatingNudges.splice(0, floatingNudges.length - 48);
  if (!floatTimer && floatingNudges.length) floatNextNudge();
}

function floatNextNudge() {
  floatTimer = null;
  if (document.hidden) return;
  while (floatingNudges[0] && Date.now() + clockOffset - floatingNudges[0].at >= 12_000) floatingNudges.shift();
  const nudge = floatingNudges.shift();
  if (!nudge) return;
  const { player, emoji } = nudge;
  const toast = document.querySelector('#nudge-pop');
  const icon = document.createElement('span');
  icon.className = 'floating-emoji';
  icon.textContent = emoji;
  icon.style.setProperty('--drift', `${[-46, 32, -12, 49, 8][emojiLane++ % 5]}px`);
  document.querySelector('#nudge-stream').append(icon);
  setTimeout(() => icon.remove(), 1450);
  if (!toast.hasChildNodes()) {
    const message = room.phase === 'discussion' ? 'Private nudge. Your defence, please!' : 'You received a private nudge.';
    toast.innerHTML = `<p>${crewBot(player, 'alarmed')}${escapeHtml(message)}</p>`;
  }
  navigator.vibrate?.(45);
  playNudgePing();
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => toast.replaceChildren(), 3000);
  floatTimer = setTimeout(floatNextNudge, 105);
}

function playNudgePing() {
  if (!musicEnabled || capture || nudgeAudio?.state !== 'running') return;
  const at = nudgeAudio.currentTime;
  const oscillator = nudgeAudio.createOscillator();
  const envelope = nudgeAudio.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(360 + (emojiLane % 5) * 26, at);
  oscillator.frequency.exponentialRampToValueAtTime(710 + (emojiLane % 5) * 38, at + .05);
  envelope.gain.setValueAtTime(.001, at);
  envelope.gain.exponentialRampToValueAtTime(.085, at + .013);
  envelope.gain.exponentialRampToValueAtTime(.001, at + .13);
  oscillator.connect(envelope).connect(nudgeAudio.destination);
  oscillator.addEventListener('ended', () => { oscillator.disconnect(); envelope.disconnect(); }, { once: true });
  oscillator.start(at);
  oscillator.stop(at + .14);
}

function resetNudgeEffects() {
  clearTimeout(floatTimer);
  clearTimeout(nudgeTimer);
  floatTimer = null;
  floatingNudges.length = 0;
  document.querySelector('#nudge-pop').replaceChildren();
  document.querySelector('#nudge-stream').replaceChildren();
}

function canNudgePlayer(player) {
  return player !== room.self?.id && (room.host || room.self?.participating)
    && room.players.some(({ id, remote }) => id === player && remote);
}

function nudgeTargetIsCurrent({ game, round, player }) {
  return room?.game === game && room.round === round && room.phase === 'discussion' && canNudgePlayer(player);
}

function queueNudge(player) {
  if (room.phase !== 'discussion' || !canNudgePlayer(player)) return;
  const last = pendingNudges.at(-1);
  if (last?.player === player && last.count < 12) last.count++;
  else if (pendingNudges.length < 12) pendingNudges.push({ game: room.game, round: room.round, player, count: 1 });
  if (!sendNudgeTimer && !nudgeSending) sendNudgeTimer = setTimeout(flushNudges, 65);
}

async function flushNudges() {
  sendNudgeTimer = null;
  const batch = pendingNudges.shift();
  if (!batch || !nudgeTargetIsCurrent(batch)) return;
  nudgeSending = true;
  try {
    apply(await api({ action: 'nudge', ...batch }));
  } catch (error) {
    if (nudgeTargetIsCurrent(batch)) showNotice(error.status ? error.message : 'Couldn’t send the nudge. Tap again to retry.');
  } finally {
    nudgeSending = false;
    if (pendingNudges.length) sendNudgeTimer = setTimeout(flushNudges, 65);
  }
}

function voteHistory() {
  if (!room.voteHistory) return '';
  return `<section class="panel vote-history" aria-labelledby="vote-history-heading">
    <h2 id="vote-history-heading">Who voted for whom</h2>
    <ul class="player-status-list">${room.players.map(({ id, name }) => `<li>
      <bdi class="breakable">${escapeHtml(name)}${id === room.self?.id ? ' (you)' : ''}</bdi>
      <span class="vote-target breakable"><span aria-hidden="true">→ </span><span class="sr-only">voted for </span>${nameText(playerName(room.voteHistory[id]))}</span>
    </li>`).join('')}</ul>
  </section>`;
}

function discussionTimeline() {
  if (!room.receipts) return '';
  const chatOpen = votingChatOpen();
  if (room.phase === 'discussion' && !room.timeline?.length) return '';
  return `<details class="panel discussion-timeline" open>
    <summary>${chatOpen ? 'Voting chat & discussion' : 'Discussion timeline'} <span class="pill" id="timeline-count"></span></summary>
    <div class="timeline-scroll" tabindex="0" role="region" aria-label="Round messages">
      <p class="timeline-question">${escapeHtml(room.receipts.question)}</p>
      <ol class="timeline-list" aria-live="polite" aria-relevant="additions"></ol>
    </div>
    ${chatOpen ? `<form class="chat-form" id="chat-form" autocomplete="off">
      <label class="sr-only" for="chat-message">Message to the room</label>
      <input class="answer-input" id="chat-message" placeholder="Message the room" dir="auto" maxlength="280" required>
      <button class="button primary" type="submit">Send</button>
      <p id="chat-error" role="status"></p>
    </form>` : ''}
  </details>`;
}

function updateTimeline() {
  const list = app.querySelector('.timeline-list');
  if (!list) return;
  const { answers } = room.receipts;
  const entries = room.timeline ?? [];
  const count = app.querySelector('#timeline-count');
  const total = String(answers.length + entries.length);
  if (count.textContent !== total) count.textContent = total;
  const scroll = list.parentElement;
  const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 42;
  const ready = list.hasChildNodes();
  if (!ready) {
    list.innerHTML = answers.map(({ name, answer }) =>
      `<li><bdi class="breakable">${escapeHtml(name)}</bdi><p dir="auto" class="breakable">${escapeHtml(answer)}</p></li>`
    ).join('');
  }
  const unseen = entries.slice(list.childElementCount - answers.length);
  if (!unseen.length) return;
  list.insertAdjacentHTML('beforeend', unseen.map((event) => {
    const name = nameText(event.author ?? playerName(event.player));
    const arrival = ready ? ' class="message-arrived"' : '';
    if (event.type === 'chat') return `<li${arrival}><div class="crew-name">${crewBot(event.player)}<strong>${name}</strong></div><p dir="auto" class="breakable">${escapeHtml(event.text)}</p></li>`;
    if (event.type === 'text') return `<li${arrival}><strong>Defence · ${name}</strong><p dir="auto" class="breakable">${escapeHtml(event.text)}</p></li>`;
    if (event.type === 'voice') return `<li${arrival}><strong>Voice defence · ${name}</strong><div data-voice="${escapeHtml(event.voice)}" class="voice-player">Loading voice note…</div></li>`;
    return '';
  }).join(''));
  if ((!ready && room.phase === 'vote') || (ready && atBottom)) scroll.scrollTop = scroll.scrollHeight;
  mountVoicePlayback();
}

function updateChatComposer() {
  const form = app.querySelector('#chat-form');
  if (!form) return;
  const button = form.querySelector('button');
  const sending = Boolean(chatPending?.sending);
  button.disabled = sending;
  button.textContent = sending ? 'Sending…' : 'Send';
  form.querySelector('#chat-error').textContent = chatError;
}

async function sendChat() {
  const text = chatDraft.trim();
  if (!text || chatPending?.sending) return;
  if (chatPending?.text !== text) chatPending = { id: crypto.randomUUID(), text, sending: false };
  const message = chatPending;
  message.sending = true;
  chatError = '';
  updateChatComposer();
  try {
    const data = await api({ action: 'chat', game: room.game, round: room.round, value: text, messageId: message.id });
    if (chatPending === message) {
      if (chatDraft.trim() === text) {
        chatDraft = '';
        const input = app.querySelector('#chat-message');
        if (input) input.value = '';
      }
      chatPending = null;
    }
    apply(data);
  } catch (error) {
    if (chatPending === message) {
      chatError = error.status ? error.message : 'Message couldn’t be sent. Try again.';
      message.sending = false;
    }
  } finally {
    updateChatComposer();
  }
}

function waiting(title, subtitle, action = '', step = '', playerProgress = false) {
  return frame(`<section class="panel turn-panel" aria-labelledby="screen-title">
    <div class="bot-stage">${crewBot(room.turn?.id ?? room.self?.id, action ? 'alert' : 'idle')}</div>
    <h1 id="screen-title" tabindex="-1">${title}</h1>
    <p class="muted">${subtitle}</p>
    ${action}
  </section>`, { narrow: true, step, playerProgress });
}

function updatePlayerProgress() {
  const list = app.querySelector('#player-status-list');
  if (!list || !room.playerProgress) return;
  const voting = room.phase.startsWith('vote');
  const labels = {
    done: voting ? 'Voted' : 'Answered',
    active: voting ? 'Voting' : 'Answering',
    next: 'Up next',
    ready: voting ? 'Ballot not opened' : 'Question not opened',
    queued: 'In queue',
    joining: 'Waiting to join'
  };
  const count = app.querySelector('#progress-count');
  const total = `${room.submitted} of ${room.players.length} ${voting ? 'voted' : 'answered'}`;
  if (count.textContent !== total) count.textContent = total;
  if (!list.hasChildNodes()) {
    list.innerHTML = room.players.map(({ id }) => `<li><span class="crew-name">${crewBot(id)}<bdi></bdi></span><span class="turn-status"></span></li>`).join('');
  }
  room.players.forEach(({ id, name }, index) => {
    const status = room.playerProgress[id];
    const row = list.children[index];
    const label = row.querySelector('bdi');
    if (label.textContent !== name) label.textContent = name;
    if (row.dataset.status === status) return;
    row.dataset.status = status;
    const badge = row.querySelector('.turn-status');
    badge.dataset.status = status;
    badge.textContent = labels[status];
  });
}

function packChoice(name, icon, action, selected, index = '') {
  return `<button class="pack ${action === 'all-genres' ? 'chaos' : ''}" type="button"
    data-action="${action}" data-index="${index}" aria-pressed="${selected}">
    <span aria-hidden="true">${icon}</span><span>${name}</span><span class="pack-check" aria-hidden="true">${selected ? '✓' : ''}</span>
  </button>`;
}

function onlineRoster(players) {
  return players.filter((player) => player.remote).map(({ id, name, reserved }) => `
    <div class="remote-seat" data-roster-player="${id}">
      <span class="crew-name">${crewBot(id, reserved ? '' : 'idle')}<span>${nameText(name)}<small class="muted">${reserved ? 'Needs to rejoin' : 'Connected'}</small></span></span>
      <button class="button help" type="button" data-action="remove-player" data-player="${id}"
        aria-label="Remove ${escapeHtml(name)}">Remove</button>
    </div>`).join('');
}

function hostLobby() {
  const total = localNames.length + room.players.length + reservedSeats;
  const maxReserved = Math.max(0, 12 - localNames.length - room.players.length);
  return `<section class="launch-deck" aria-labelledby="screen-title">
    <div class="deck-hero">
      <div class="deck-title">
        <p class="kicker"><span class="signal-light" aria-hidden="true"></span> Private room</p>
        <h1 id="screen-title" tabindex="-1">Kaun Sus <em>Hai?</em></h1>
        <p>One crew. One imposter. Who’s faking it?</p>
      </div>
    </div>
    <form class="launch-grid" id="lobby-form" autocomplete="off">
      <div class="panel crew-panel">
        <section class="setup-section" aria-labelledby="players-label">
          <div class="section-top"><h2 id="players-label">Shared device <small>(optional)</small></h2><span class="pill" id="seat-count">${total} / 12 total</span></div>
          <div class="names">${localNames.map((name, index) => `
            <div class="name-field has-remove">
              <label class="sr-only" for="local-${index}">Player ${index + 1} name</label>
              <span class="name-index" aria-hidden="true">${index + 1}</span>
              <input id="local-${index}" data-name="${index}" value="${escapeHtml(name)}" placeholder="Player ${index + 1}" autocomplete="off" maxlength="40" dir="auto" required>
              <button class="remove" type="button" data-action="remove" data-index="${index}" aria-label="Remove player ${index + 1}">×</button>
            </div>`).join('')}
            <button class="add" type="button" data-action="add" ${total >= 12 ? 'disabled' : ''}>＋ Add player here</button>
          </div>
        </section>
        <section class="setup-section" aria-labelledby="online-players-label">
          <div class="section-top"><h2 id="online-players-label">Players on their own devices</h2><span class="pill">${room.players.length} joined</span></div>
          ${onlineRoster(room.players) || `<div class="empty-dock">${crewBot('dock', 'idle')}<p>No one has joined yet. Share an invite to bring your crew aboard.</p></div>`}
          <button class="button invite-shortcut" type="button" ${buttonAction('invite')}>＋ Invite Player</button>
          <details class="reserve-seats" ${reservedSeats ? 'open' : ''}>
            <summary>Reserve seats for late arrivals</summary>
            <p class="online-pack-note">Reserved players can join after you start. The round waits for their answers and votes.</p>
            <label for="reserved-seats">Seats to reserve</label>
            <input id="reserved-seats" type="number" min="0" max="${maxReserved}" step="1" value="${reservedSeats}" required>
          </details>
        </section>
      </div>
      <section class="panel pack-panel" aria-labelledby="packs-label">
          <div class="section-top"><h2 id="packs-label">Question packs</h2></div>
          <p class="online-pack-note">${genres.size ? 'One question per round from a randomly selected pack.' : 'Choose at least one pack.'}</p>
          <div class="packs">
            ${packChoice('Full Chaos', '⚡', 'all-genres', genres.size === room.packs.length)}
            ${room.packs.map((pack, index) => packChoice(pack.name, pack.icon, 'genre', genres.has(index), index)).join('')}
          </div>
          ${primary('Start Round', `type="submit" ${genres.size ? '' : 'disabled'}`)}
      </section>
    </form>
  </section>`;
}

function guestNameView() {
  return frame(`<section class="panel boarding-panel" aria-labelledby="screen-title">
    <div class="bot-stage">${crewBot('guest', 'idle')}</div>
    <div class="phase-head">
      <p class="kicker">Your remote seat</p>
      <h1 id="screen-title" class="phase-title" tabindex="-1">You’re invited.</h1>
      <p class="muted">Enter the name your friends will see.</p>
    </div>
    <form class="answer-form" id="guest-form" autocomplete="off">
      <label class="sr-only" for="guest-name">Your name</label>
      <input class="answer-input" id="guest-name" placeholder="Your name" value="${escapeHtml(guestDraft)}" dir="auto" maxlength="40" required>
      ${primary('Join the Room', 'type="submit"')}
    </form>
  </section>`, { narrow: true });
}

function turnView(voting) {
  const { turn, host } = room;
  const step = voting ? 'Secret vote' : escapeHtml(room.genre);
  if (!turn) {
    if (!host && !room.self.participating) return waiting('You’re in.', 'This round is in progress. You’ll play from the next round.', '', step, true);
    return waiting(host ? 'Waiting for online players.' : voting ? 'Vote locked.' : 'Answer locked.',
      'The round will continue once everyone is done.', '', step, true);
  }
  if (!(voting ? turn.opened : turn.question)) {
    return waiting(
      host ? `Pass to ${nameText(turn.name)}` : `Your turn, ${nameText(turn.name)}`,
      host ? 'Tap when the phone is in your hands.' : 'Open when you’re ready.',
      primary(voting ? 'Show My Ballot' : 'Show My Question', buttonAction(voting ? 'open-vote' : 'open-answer')),
      step, true
    );
  }
  const options = { narrow: true, step, playerProgress: true };
  if (voting) {
    return frame(`<section class="panel" aria-labelledby="screen-title">
      <div class="phase-head"><p class="kicker"><span>${nameText(turn.name)}, your secret vote</span></p>
        <h1 class="phase-title" id="screen-title" tabindex="-1">Kaun sus hai?</h1>
        <p class="muted">Pick one other player. Votes become visible once everyone locks in.</p>
      </div>
      <form class="vote-form" id="vote-form">
        <div class="vote-grid" role="group" aria-label="Vote for a player">
          ${room.players.filter(({ id }) => id !== turn.id).map(({ id, name }) => `
            <button class="candidate" id="vote-${id}" type="button" data-action="candidate" data-player="${id}" aria-pressed="false">
              ${crewBot(id)}<bdi class="breakable">${escapeHtml(name)}</bdi>
            </button>`).join('')}
        </div>
        ${primary('Lock In Vote', 'type="submit" disabled')}
      </form>
    </section>`, options);
  }
  return frame(`<section class="panel answer-station" aria-labelledby="screen-title">
    <div class="crew-name">${crewBot(turn.id)}<p class="kicker"><span>${nameText(turn.name)}, your question</span></p></div>
    <h1 id="screen-title" class="question-bubble" tabindex="-1">${escapeHtml(turn.question)}</h1>
    <form class="answer-form" id="answer-form" autocomplete="off">
      <div class="section-top">
        <label for="answer">Your answer · 1–5 words</label>
        <span class="word-count" id="word-count" aria-hidden="true">0 / 5</span>
      </div>
      <input class="answer-input" id="answer" placeholder="Type your answer" dir="auto"
        autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="done" maxlength="280" required>
      ${primary('Lock In Answer', 'type="submit"')}
    </form>
  </section>`, options);
}

function hotSeatView() {
  const { player, explanation, voice } = room.hotSeat;
  const name = room.players.find(({ id }) => id === player).name;
  const canExplain = player === room.self?.id;
  return `<div class="hot-seat">
    <div class="crew-name">${crewBot(player, 'alarmed')}<strong>Hot Seat · ${nameText(name)}</strong></div>
    <p>Explain yourself, respectfully.</p>
    ${explanation ? `<p dir="auto" class="breakable">${escapeHtml(explanation)}</p>` : ''}
    ${canExplain && !explanation ? `<form class="answer-form" id="explain-form">
      <label for="explanation" class="sr-only">Your defence</label>
      <input class="answer-input" id="explanation" maxlength="280" dir="auto" required
        placeholder="Type your defence">
      <button class="button" type="submit">Send Defence</button>
    </form>` : ''}
    ${voice ? `<button class="button" type="button" data-action="jump-voice" data-voice-id="${escapeHtml(voice)}">Find voice defence</button>` : ''}
    ${canExplain && !voice ? voiceComposer() : ''}
  </div>`;
}

function voiceComposer() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    return '<p>Voice recording is unavailable in this browser. You can type your defence.</p>';
  }
  const button = (label, action, disabled = false) => `<button class="button" type="button" data-action="${action}" ${disabled ? 'disabled' : ''}>${label}</button>`;
  return `<div class="voice-composer">
    ${voiceDraft ? `<audio controls src="${voiceDraft.url}" aria-label="Preview your voice note"></audio>
      <div class="voice-actions">${button(voiceDraft.sending ? 'Sending…' : 'Send voice note', 'send-voice', voiceDraft.sending)}
      ${button('Discard', 'discard-voice', voiceDraft.sending)}</div>`
      : capture?.recorder ? button('Stop recording', 'stop-voice')
      : button(capture ? 'Waiting for microphone…' : 'Record voice note', 'record-voice', Boolean(capture))}
    <p role="status">${escapeHtml(voiceStatus || (capture?.recorder ? `Recording · up to ${voiceSeconds} seconds` : ''))}</p>
  </div>`;
}

function stopMicrophone(recording) {
  clearTimeout(recording.timer);
  if (recording.recorder?.state === 'recording') recording.recorder.stop();
  recording.stream?.getTracks().forEach((track) => track.stop());
}

function clearVoiceDraft() {
  const recording = capture;
  capture = null;
  if (recording) stopMicrophone(recording);
  if (voiceDraft) URL.revokeObjectURL(voiceDraft.url);
  voiceDraft = null;
  voiceStatus = '';
}

async function recordVoice() {
  if (capture || voiceDraft) return;
  const recording = { seat: seatKey };
  capture = recording;
  voiceStatus = '';
  render();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recording.stream = stream;
    if (capture !== recording || seatKey !== recording.seat) {
      stopMicrophone(recording);
      return;
    }
    const mimeType = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/ogg;codecs=opus']
      .find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 48000 });
    const parts = [];
    recording.recorder = recorder;
    recorder.addEventListener('dataavailable', ({ data }) => { if (data.size) parts.push(data); });
    recorder.addEventListener('error', () => {
      if (capture !== recording) return;
      clearVoiceDraft();
      voiceStatus = 'Recording failed. You can retry or type your defence.';
      render();
    }, { once: true });
    recorder.addEventListener('stop', () => {
      stopMicrophone(recording);
      if (capture !== recording) return;
      capture = null;
      const blob = new Blob(parts, { type: parts[0]?.type || recorder.mimeType });
      if (blob.size) voiceDraft = { blob, url: URL.createObjectURL(blob), sending: false };
      else voiceStatus = 'No audio was recorded. Try again.';
      render();
    }, { once: true });
    recorder.start();
    recording.timer = setTimeout(() => stopMicrophone(recording), voiceSeconds * 1000);
    render();
  } catch {
    if (capture !== recording) return;
    clearVoiceDraft();
    voiceStatus = 'Couldn’t access the microphone. Check your browser permissions or type your defence.';
    render();
  }
}

async function sendVoice() {
  const draft = voiceDraft;
  if (!draft || draft.sending) return;
  draft.sending = true;
  voiceStatus = '';
  render();
  const params = new URLSearchParams({ game: room.game, round: room.round });
  try {
    const response = await fetch(`/api/voice?${params}`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + credentials.key },
      body: draft.blob, signal: AbortSignal.timeout(15000)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    if (voiceDraft === draft) clearVoiceDraft();
    apply(data);
  } catch (error) {
    if (voiceDraft !== draft) return;
    draft.sending = false;
    voiceStatus = error instanceof TypeError ? 'Couldn’t send the voice note. Try again.' : error.message;
    render();
  }
}

function releaseVoicePlayback(id) {
  for (const [key, playback] of voicePlaybacks) {
    if (id && key !== id) continue;
    playback.controller.abort();
    playback.audio?.pause();
    if (playback.url) URL.revokeObjectURL(playback.url);
    voicePlaybacks.delete(key);
  }
}

function mountVoicePlayback() {
  const slots = new Map(Array.from(app.querySelectorAll('[data-voice]'), (slot) => [slot.dataset.voice, slot]));
  for (const id of voicePlaybacks.keys()) {
    if (!slots.has(id)) releaseVoicePlayback(id);
  }
  for (const [id, slot] of slots) {
    const existing = voicePlaybacks.get(id);
    if (existing) {
      existing.slot = slot;
      if (existing.audio && !slot.contains(existing.audio)) slot.replaceChildren(existing.audio);
      continue;
    }
    const playback = { slot, controller: new AbortController() };
    voicePlaybacks.set(id, playback);
    fetch(`/api/voice?id=${encodeURIComponent(id)}`, {
      headers: { Authorization: 'Bearer ' + credentials.key },
      signal: playback.controller.signal
    }).then(async (response) => {
      if (!response.ok) throw new Error('Audio unavailable');
      const blob = await response.blob();
      if (voicePlaybacks.get(id) !== playback) return;
      playback.url = URL.createObjectURL(blob);
      playback.audio = document.createElement('audio');
      playback.audio.controls = true;
      playback.audio.src = playback.url;
      playback.audio.setAttribute('aria-label', 'Play voice defence');
      playback.slot.replaceChildren(playback.audio);
    }).catch(() => {
      if (voicePlaybacks.get(id) !== playback) return;
      voicePlaybacks.delete(id);
      playback.slot.innerHTML = '<button class="button" type="button" data-action="retry-voice">Retry voice note</button>';
    });
  }
}

function discussion() {
  const { genre, question, answers } = room.receipts;
  const canChoose = room.host || room.self?.participating;
  return frame(`
    <div class="phase-head"><h1 class="phase-title" id="screen-title" tabindex="-1">The receipts</h1>
      <p class="muted">${canChoose ? 'Tap a name to nudge, or tap an answer for the Hot Seat.' : 'You’re watching this round. You’ll play in the next one.'}</p>
    </div>
    <section class="panel" aria-label="${escapeHtml(genre)} answers">
      <p class="kicker">${escapeHtml(genre)}</p>
      <h2 class="question-bubble">${escapeHtml(question)}</h2>
      <div class="receipt-grid">${answers.map(({ id, name, answer }, order) => {
        const selected = room.hotSeat?.player === id;
        const identity = `${crewBot(id, selected ? 'alarmed' : '')}<b dir="auto">${escapeHtml(name)}</b>`;
        return `<div class="receipt ${previousScreen === 'discussion' ? '' : 'flip'}" data-selected="${selected}" style="--order:${order}">
          ${canNudgePlayer(id)
            ? `<button class="crew-name receipt-name" type="button" id="nudge-${id}" data-action="nudge" data-player="${id}" aria-label="Nudge ${escapeHtml(name)}">${identity}</button>`
            : `<span class="crew-name">${identity}</span>`}
          <button class="receipt-answer" id="receipt-${id}" type="button" data-action="hot-seat" data-player="${id}"
            ${canChoose ? '' : 'disabled'} aria-pressed="${selected}" dir="auto">${escapeHtml(answer)}</button>
        </div>`;
      }).join('')}</div>
      ${room.hotSeat ? hotSeatView() : ''}
    </section>
    <div class="panel discussion-tools">
      <div class="discussion-controls">
        ${room.host ? `<button class="button timer" id="discussion-timer" type="button" data-action="timer">Start 45s timer</button>
          ${primary('Vote Now', buttonAction('start-vote'))}`
          : room.discussionUntil ? '<span class="pill timer" id="discussion-timer"></span>' : '<p class="muted">The host will open voting when you’re ready.</p>'}
      </div>
    </div>`);
}

function countdown() {
  return frame(`<section class="countdown-stage" aria-labelledby="screen-title">
    <div class="countdown-crew" aria-hidden="true">${crewBot('watch-a', 'alert')}${crewBot('watch-b', 'alarmed')}</div>
    <div>
      <h1 id="screen-title" tabindex="-1">The group chat is typing…</h1>
      <div class="countdown-value" id="countdown" aria-live="polite"></div>
      <p class="kicker">Imposter reveal</p>
    </div>
  </section>`, { narrow: true });
}

function scoreboard() {
  const { imposter, caught, tied, scores, prompts } = room.result;
  const outcome = caught ? 'The group caught the imposter.' : tied
    ? 'A tie for first. The imposter escaped.' : 'The group guessed wrong. The imposter escaped.';
  return frame(`
    <section class="reveal-hero ${caught ? '' : 'escape'}" aria-labelledby="screen-title">
      <div>
        <p class="kicker">The imposter was</p>
        <h1 class="phase-title" id="screen-title" tabindex="-1">${nameText(imposter)}</h1>
        <p>${outcome}</p>
      </div>
      <div class="reveal-bot">${crewBot(scores.find(({ name }) => name === imposter)?.id, caught ? 'alarmed' : 'alert')}</div>
    </section>
    <section class="panel scoreboard" aria-labelledby="scores-heading">
      <h2 id="scores-heading">Scoreboard</h2>
      <table class="score-table">
        <thead><tr><th scope="col">Player</th><th scope="col">Votes</th><th scope="col">This round</th><th scope="col">Total</th></tr></thead>
        <tbody>${scores.map(({ name, votes, gain, score }) => `
          <tr><th scope="row" class="breakable">${nameText(name)}</th><td>${votes}</td>
            <td>${gain ? `<span class="gain">+${gain}</span>` : '0'}</td><td><strong>${score}</strong></td></tr>`).join('')}</tbody>
      </table>
    </section>
    ${prompts.map(({ genre, group, alternate, answer }) => `
      <section class="comparison-set">
        <h2 class="kicker">${escapeHtml(genre)}</h2>
        <div class="question-compare">
          ${[['Group question', group], ['Imposter question', alternate]].map(([label, question]) => `
            <section class="compare-card">
              <p class="kicker">${label}</p><h3>${escapeHtml(question)}</h3>
              <strong class="compare-answer breakable" dir="auto">“${escapeHtml(answer)}”</strong>
            </section>`).join('')}
        </div>
      </section>`).join('')}
    ${room.host ? `<div class="panel next-roster">
      <div class="section-top"><h2>Next round</h2><span class="pill">${room.roster.length} players</span></div>
      ${onlineRoster(room.roster)}
      ${primary('Play Again', buttonAction('again'))}
    </div>` : '<p class="online-turn-meta">The host can start the next round.</p>'}
  `);
}

function view() {
  if (room.host && room.phase !== 'lobby' && inHomepage()) {
    return ['homepage', frame(`<section class="panel turn-panel home-panel" aria-labelledby="screen-title">
      <div class="bot-stage">${crewBot('host', 'idle')}</div>
      <h1 id="screen-title" tabindex="-1">Kaun Sus Hai?</h1>
      ${primary('Resume Game', buttonAction('resume'))}
      <button class="button block" type="button" data-action="confirm-reset">Start New Game</button>
    </section>`, { narrow: true })];
  }
  switch (room.phase) {
    case 'invite':
      return ['guest-name', guestNameView()];
    case 'lobby':
      return ['lobby', room.host ? hostLobby() : waiting('You’re in.', 'The host will start the round when everyone’s ready.')];
    case 'answer':
      return [privateTurn + Boolean(room.turn?.question), turnView(false)];
    case 'answers-in':
      return [room.phase, waiting('Answers are in.', room.host ? 'Put the phone where everyone can see.' : 'Waiting for the host to open the receipts.',
        room.host ? primary('Show the Receipts', buttonAction('receipts')) : '', '', true)];
    case 'discussion':
      return [room.phase, discussion()];
    case 'vote':
      return [privateTurn + Boolean(room.turn?.opened), turnView(true)];
    case 'votes-in':
      return [room.phase, waiting('Votes are in.', room.host ? 'Get everyone ready for the reveal.' : 'The host will start the countdown.',
        room.host ? primary('Start the Reveal', buttonAction('countdown')) : '', '', true)];
    case 'countdown':
      return [room.phase, countdown()];
    case 'scoreboard':
      return [room.phase, scoreboard()];
  }
}

function render() {
  syncMusic();
  shareButton.hidden = !room.host;
  newGameButton.hidden = !room.host || room.phase === 'lobby' || inHomepage();
  homeButton.disabled = newGameButton.hidden;
  const [screen, markup] = view();
  if (markup === rendered) {
    updatePlayerProgress();
    updateTimeline();
    return;
  }
  const sameScreen = screen === previousScreen;
  const focused = app.contains(document.activeElement) ? document.activeElement : null;
  const selection = typeof focused?.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd] : null;
  const reserveWasOpen = app.querySelector('.reserve-seats')?.open;
  const timelineWasOpen = app.querySelector('.discussion-timeline')?.open;
  const timelineScroll = app.querySelector('.timeline-scroll')?.scrollTop;
  app.innerHTML = markup;
  rendered = markup;
  previousScreen = screen;
  const answer = app.querySelector('#answer');
  if (answer) {
    answer.value = answerDraft;
    updateWordCount();
  }
  const explanation = app.querySelector('#explanation');
  if (explanation) explanation.value = explanationDraft;
  const chatInput = app.querySelector('#chat-message');
  if (chatInput) chatInput.value = chatDraft;
  updateChatComposer();
  updateTimeline();
  const timeline = app.querySelector('.discussion-timeline');
  if (sameScreen && timeline && timelineWasOpen !== undefined) {
    timeline.open = timelineWasOpen;
    timeline.querySelector('.timeline-scroll').scrollTop = timelineScroll;
  }
  updateVoteSelection();
  updatePlayerProgress();
  mountVoicePlayback();
  syncMusic();
  if (reserveWasOpen && sameScreen) app.querySelector('.reserve-seats').open = true;
  updateTimers();
  if (!sameScreen) {
    window.scrollTo(0, 0);
    document.querySelector('#screen-title').focus({ preventScroll: true });
  } else if (focused?.id) {
    const replacement = document.getElementById(focused.id);
    replacement?.focus({ preventScroll: true });
    if (selection) replacement?.setSelectionRange(...selection);
  }
}

function renderUnavailable(message) {
  clearVoiceDraft();
  releaseVoicePlayback();
  room = null;
  syncMusic();
  shareButton.hidden = true;
  newGameButton.hidden = true;
  homeButton.disabled = true;
  showNotice('');
  app.innerHTML = `<section class="game narrow panel turn-panel">
    <div class="bot-stage">${crewBot('locked', 'alert')}</div>
    <h1>Private room</h1>
    <p class="muted">${escapeHtml(message)}</p>
  </section>`;
}

function updateTimers() {
  if (!room) return;
  const now = Date.now() + clockOffset;
  const reveal = document.querySelector('#countdown');
  if (reveal) {
    const seconds = Math.max(0, Math.min(5, Math.ceil((room.revealUntil - now) / 1000)));
    const digit = seconds ? String(seconds) : '…';
    if (digit !== reveal.textContent) {
      reveal.closest('.countdown-stage').dataset.urgency = seconds <= 2 ? 'high' : 'normal';
      const span = document.createElement('span');
      span.textContent = digit;
      reveal.replaceChildren(span);
    }
  }
  const timer = document.querySelector('#discussion-timer');
  if (!timer || !room.discussionUntil) return;
  const seconds = Math.max(0, Math.min(45, Math.ceil((room.discussionUntil - now) / 1000)));
  const time = seconds ? `0:${String(seconds).padStart(2, '0')}` : room.host ? 'Time’s up · Restart' : 'Time’s up';
  if (timer.textContent !== time) timer.textContent = time;
  if (room.host) timer.disabled = seconds > 0;
}

function refreshSetup(index) {
  showNotice('');
  render();
  (document.getElementById('local-' + index) ?? app.querySelector('[data-action="add"]'))?.focus();
}

function updateWordCount() {
  const count = words(answerDraft);
  const indicator = app.querySelector('#word-count');
  indicator.textContent = `${count} / 5`;
  indicator.classList.toggle('over', count > 5);
}

function updateVoteSelection() {
  const form = app.querySelector('#vote-form');
  if (!form) return;
  for (const candidate of form.querySelectorAll('.candidate')) {
    candidate.setAttribute('aria-pressed', String(candidate.dataset.player === selectedVote));
  }
  form.querySelector('[type="submit"]').disabled = !selectedVote;
}

app.addEventListener('input', ({ target }) => {
  if (target.matches('[data-name]')) localNames[Number(target.dataset.name)] = target.value;
  if (target.id === 'reserved-seats') {
    reservedSeats = Number(target.value);
    const total = localNames.length + room.players.length + reservedSeats;
    document.querySelector('#seat-count').textContent = `${total} / 12 total`;
    app.querySelector('[data-action="add"]').disabled = total >= 12;
  }
  if (target.id === 'guest-name') guestDraft = target.value;
  if (target.id === 'explanation') explanationDraft = target.value;
  if (target.id === 'chat-message') {
    chatDraft = target.value;
    if (chatError) {
      chatError = '';
      updateChatComposer();
    }
  }
  if (target.id === 'answer') {
    answerDraft = target.value;
    updateWordCount();
  }
  if (currentNotice === 'action') showNotice('');
});

app.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  switch (form.id) {
    case 'lobby-form': act('start', { names: localNames, genres: [...genres], reserved: reservedSeats }); break;
    case 'guest-form': act('join', { value: guestDraft }); break;
    case 'answer-form': {
      const count = words(answerDraft);
      if (count < 1 || count > 5) {
        showNotice('Enter an answer in 1–5 words.');
        document.querySelector('#answer').focus();
      } else {
        act('answer', { value: answerDraft, player: room.turn.id });
      }
      break;
    }
    case 'vote-form':
      if (selectedVote) act('vote', { value: selectedVote, player: room.turn.id });
      break;
    case 'explain-form': act('explain', { value: explanationDraft }); break;
    case 'chat-form': sendChat(); break;
  }
});

app.addEventListener('click', ({ target }) => {
  const button = target.closest('button[data-action]');
  if (!button) return;
  const { action, player } = button.dataset;
  if (action === 'nudge') {
    queueNudge(player);
    return;
  }
  if (active) return;
  const index = Number(button.dataset.index);
  switch (action) {
    case 'invite': shareButton.click(); break;
    case 'record-voice': recordVoice(); break;
    case 'stop-voice': if (capture) stopMicrophone(capture); break;
    case 'send-voice': sendVoice(); break;
    case 'discard-voice': clearVoiceDraft(); render(); break;
    case 'retry-voice': mountVoicePlayback(); break;
    case 'jump-chat': {
      const input = app.querySelector('#chat-message');
      if (input) {
        input.closest('details').open = true;
        input.focus();
      }
      break;
    }
    case 'jump-voice': {
      const slot = app.querySelector(`[data-voice="${CSS.escape(button.dataset.voiceId)}"]`);
      if (slot) {
        slot.closest('details').open = true;
        slot.scrollIntoView({ block: 'center' });
        slot.querySelector('audio, button')?.focus({ preventScroll: true });
      }
      break;
    }
    case 'resume':
      setHomepage(false);
      render();
      break;
    case 'confirm-reset':
      confirmReset();
      break;
    case 'add':
      localNames.push('');
      refreshSetup(localNames.length - 1);
      break;
    case 'remove':
      localNames.splice(index, 1);
      refreshSetup(Math.min(index, localNames.length - 1));
      break;
    case 'all-genres':
      genres = new Set(room.packs.map((_, pack) => pack));
      render();
      app.querySelector('[data-action="all-genres"]').focus({ preventScroll: true });
      break;
    case 'genre':
      if (genres.has(index)) genres.delete(index);
      else genres.add(index);
      render();
      app.querySelector(`[data-action="genre"][data-index="${index}"]`).focus({ preventScroll: true });
      break;
    case 'open-answer':
    case 'open-vote':
      act(action, { player: room.turn.id });
      break;
    case 'candidate':
      selectedVote = player;
      updateVoteSelection();
      break;
    case 'hot-seat':
    case 'remove-player':
      act(action, { player });
      break;
    default:
      act(action);
  }
});

function confirmReset() {
  if (!room?.host || room.phase === 'lobby') return;
  resetTarget = { game: room.game, round: room.round };
  newGameDialog.showModal();
}

homeButton.addEventListener('click', () => {
  setHomepage(true);
  render();
});
window.addEventListener('popstate', () => { if (room) render(); });
newGameButton.addEventListener('click', confirmReset);
document.querySelector('#confirm-new-game').addEventListener('click', () => {
  newGameDialog.close();
  if (resetTarget && room) act('new-game', resetTarget);
});

shareButton.addEventListener('click', () => {
  const url = new URL(location.pathname, location.origin);
  url.hash = 'join=' + room.invite;
  inviteInput.value = url.href;
  const code = window.qrcode(0, 'M');
  code.addData(url.href);
  code.make();
  const canvas = document.querySelector('#invite-qr');
  const modules = code.getModuleCount();
  const pixel = 5;
  const quiet = 4;
  canvas.width = canvas.height = (modules + 2 * quiet) * pixel;
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#101815';
  for (let row = 0; row < modules; row++) {
    for (let column = 0; column < modules; column++) {
      if (code.isDark(row, column)) context.fillRect((column + quiet) * pixel, (row + quiet) * pixel, pixel, pixel);
    }
  }
  document.querySelector('#copy-status').textContent = '';
  inviteDialog.showModal();
});
window.addEventListener('pagehide', () => {
  clearVoiceDraft();
  releaseVoicePlayback();
  soundtrack.pause();
  rendered = '';
});
document.querySelector('#copy-invite').addEventListener('click', async () => {
  const status = document.querySelector('#copy-status');
  try {
    await navigator.clipboard.writeText(inviteInput.value);
    status.textContent = 'Invite copied.';
  } catch {
    inviteInput.select();
    status.textContent = 'Copy the selected link.';
  }
});
document.querySelector('#show-help').addEventListener('click', () => document.querySelector('#help').showModal());
for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => button.closest('dialog').close());
}

if (credentials) {
  poll();
  setInterval(updateTimers, 100);
} else {
  renderUnavailable('Open the private link your host shared.');
}
