import { createServer } from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { deserialize } from 'node:v8';

const load = (filename) => readFile(new URL(filename, import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
const [offline, page, client, roomStyles, qrClient, commandDeck, soundtrack] = await Promise.all([
  load('./index.html'), load('./online.html'), load('./online.js'), load('./online.css'),
  readFile(require.resolve('qrcode-generator'), 'utf8'),
  readFile(new URL('./assets/command-deck.webp', import.meta.url)),
  readFile(new URL('./assets/ship-signal.m4a', import.meta.url))
]);
const packs = JSON.parse(offline.match(/<script type="application\/json" id="question-packs">([\s\S]*?)<\/script>/)[1]);
const theme = offline.match(/<style>([\s\S]*?)<\/style>/)[1];
const assets = new Map([
  ['/', ['text/html', page]],
  ['/theme.css', ['text/css', theme + roomStyles]],
  ['/online.js', ['text/javascript', client]],
  ['/qr.js', ['text/javascript', qrClient]],
  ['/assets/command-deck.webp', ['image/webp', commandDeck]],
  ['/assets/ship-signal.m4a', ['audio/mp4', soundtrack]]
]);
const token = () => randomBytes(24).toString('base64url');
const hostKey = process.env.KAUN_SUS_HOST_KEY || token();
const guestKey = process.env.KAUN_SUS_INVITE_KEY || token();
const sessions = new Map();
const maxPlayers = 12;
const room = {
  version: 0,
  game: 1,
  phase: 'lobby',
  players: [],
  localDraft: null,
  genres: packs.map((_, index) => index),
  pairQueues: new Map(),
  lastPairs: new Map(),
  genreQueue: [],
  lastGenre: null,
  roundNumber: 0,
  round: null
};

const label = (player) => player.name || 'Online seat ' + player.seat;
const nameKey = (name) => name.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
const words = (answer) => answer.trim().split(/\s+/u).filter((part) => /[\p{L}\p{N}]/u.test(part)).length;
const touch = () => { room.version++; };

if (process.env.KAUN_SUS_HANDOFF) {
  const saved = deserialize(await readFile(process.env.KAUN_SUS_HANDOFF));
  Object.assign(room, saved.room);
  for (const [key, player] of saved.sessions) sessions.set(key, player);
  if (process.env.KAUN_SUS_REJOIN === '1') {
    for (const player of room.players) {
      if (player.remote && player.name) player.needsRejoin = true;
    }
  }
  for (const [genre, pair] of room.lastPairs) {
    const original = packs[genre].pairs.find(([group, alternate]) => group === pair[0] && alternate === pair[1]);
    if (original) room.lastPairs.set(genre, original);
  }
  if (room.round?.nudges) room.round.nudgeRate ??= new Map();
  touch();
} else if (process.env.KAUN_SUS_SCOREBOARD) {
  const saved = JSON.parse(await readFile(process.env.KAUN_SUS_SCOREBOARD, 'utf8'));
  room.version = (saved.version ?? 0) + 1;
  room.game = saved.game ?? 1;
  room.phase = saved.phase === 'lobby' ? 'lobby' : 'scoreboard';
  room.roundNumber = saved.round;
  room.localDraft = saved.localDraft ?? null;
  room.genres = saved.genres ?? room.genres;
  room.players = saved.players.map((player) => ({
    ...player,
    score: saved.result?.scores.find(({ id }) => id === player.id)?.score ?? 0,
    needsRejoin: player.remote
  }));
  if (room.phase === 'scoreboard') {
    room.round = {
      players: (saved.roundPlayers ?? room.players).filter(({ id }) => saved.result.scores.some((score) => score.id === id)),
      result: saved.result,
      archive: saved.history,
      defences: new Map((saved.voiceNotes ?? []).map(({ id, type, bytes }) => [id, { voice: { id, type, bytes: Buffer.from(bytes, 'base64') } }]))
    };
  }
}

class GameError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

function requireState(condition, message, status) {
  if (!condition) throw new GameError(message, status);
}

function shuffled(values) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = randomInt(index + 1);
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

function chooseGenre() {
  if (!room.genreQueue.length) {
    room.genreQueue = shuffled(room.genres);
    if (room.genreQueue.length > 1 && room.genreQueue[0] === room.lastGenre) {
      [room.genreQueue[0], room.genreQueue[1]] = [room.genreQueue[1], room.genreQueue[0]];
    }
  }
  room.lastGenre = room.genreQueue.shift();
  return room.lastGenre;
}

function drawPrompt(genre) {
  let queue = room.pairQueues.get(genre);
  if (!queue?.length) {
    queue = shuffled(packs[genre].pairs);
    if (queue[0] === room.lastPairs.get(genre)) [queue[0], queue[1]] = [queue[1], queue[0]];
    room.pairQueues.set(genre, queue);
  }
  const pair = queue.shift();
  room.lastPairs.set(genre, pair);
  return { genre, group: pair[0], alternate: pair[1], answers: new Map(), opened: new Set() };
}

function startRound() {
  requireState(room.players.length >= 3, 'You need at least 3 players to start.', 400);
  room.roundNumber++;
  room.round = {
    players: [...room.players],
    imposter: room.players[randomInt(room.players.length)].id,
    prompt: drawPrompt(chooseGenre()),
    ballotOpened: new Set(),
    votes: new Map(),
    hotSeat: null,
    defences: new Map(),
    timeline: [],
    nudges: [],
    nudgeRate: new Map(),
    discussionUntil: null,
    revealUntil: null,
    result: null
  };
  room.phase = 'answer';
}

function activeTurn(viewer, submissions) {
  const available = viewer.host ? room.round.players.filter((player) => !player.remote)
    : room.round.players.filter((player) => player === viewer.player);
  return available.find((player) => !submissions.has(player.id));
}

function resolveRound() {
  const round = room.round;
  const tally = new Map(round.players.map((player) => [player.id, 0]));
  for (const vote of round.votes.values()) tally.set(vote, tally.get(vote) + 1);
  const top = Math.max(...tally.values());
  const tied = [...tally.values()].filter((votes) => votes === top).length > 1;
  const caught = !tied && tally.get(round.imposter) === top;
  const scores = round.players.map((player) => {
    const gain = caught ? Number(player.id !== round.imposter) : player.id === round.imposter ? 2 : 0;
    player.score += gain;
    return { id: player.id, name: label(player), votes: tally.get(player.id), gain, score: player.score };
  });
  const { genre, group, alternate, answers } = round.prompt;
  round.result = {
    imposter: label(round.players.find((player) => player.id === round.imposter)),
    caught, tied,
    prompts: [{ genre: packs[genre].name, group, alternate, answer: answers.get(round.imposter) }],
    scores: scores.sort((first, second) => second.score - first.score)
  };
  room.phase = 'scoreboard';
  touch();
}

function updateClock() {
  if (room.phase === 'countdown' && Date.now() >= room.round.revealUntil) resolveRound();
}

const publicPlayer = (player) => ({
  id: player.id, name: label(player), remote: player.remote, reserved: !player.name || Boolean(player.needsRejoin)
});

function turnProgress(round, submissions, opened) {
  const nextLocal = round.players.find((player) => !player.remote && !submissions.has(player.id));
  return {
    submitted: submissions.size,
    playerProgress: Object.fromEntries(round.players.map((player) => {
      const { id } = player;
      let status = 'queued';
      if (submissions.has(id)) status = 'done';
      else if (opened.has(id)) status = 'active';
      else if (!player.name) status = 'joining';
      else if (player === nextLocal) status = 'next';
      else if (player.remote) status = 'ready';
      return [id, status];
    }))
  };
}

function discussionHistory(round) {
  const { prompt, players, timeline } = round;
  return {
    timeline,
    receipts: {
      genre: packs[prompt.genre].name,
      question: prompt.group,
      answers: players.map((player) => ({ id: player.id, name: label(player), answer: prompt.answers.get(player.id) }))
    }
  };
}

function snapshot(viewer) {
  updateClock();
  const now = Date.now();
  if (!viewer.host && !viewer.player) {
    return { phase: 'invite', version: room.version, serverNow: now };
  }
  const { round, phase } = room;
  const base = {
    phase, version: room.version, serverNow: now, game: room.game, round: room.roundNumber, host: viewer.host,
    self: viewer.player ? { id: viewer.player.id, name: viewer.player.name, participating: round?.players.includes(viewer.player) ?? false } : null,
    players: (round?.players ?? room.players).map(publicPlayer),
    ...(viewer.host ? { invite: guestKey } : {})
  };
  if (phase === 'lobby') {
    return {
      ...base,
      packs: packs.map(({ name, icon }) => ({ name, icon })),
      totalPairs: packs.reduce((total, pack) => total + pack.pairs.length, 0),
      ...(viewer.host ? { localDraft: room.localDraft, genres: room.genres } : {})
    };
  }
  if (viewer.player && round.nudges) {
    base.receivedNudges = round.nudges.filter(({ player, at }) => player === viewer.player.id && now - at < 12_000).slice(-48)
      .map(({ id, player, emoji, at }) => ({ id, player, emoji, at }));
  }
  if (phase === 'answer' || phase === 'answers-in') {
    const { prompt } = round;
    const player = activeTurn(viewer, prompt.answers);
    return {
      ...base, genre: packs[prompt.genre].name, ...turnProgress(round, prompt.answers, prompt.opened),
      turn: player ? {
        id: player.id, name: label(player),
        question: prompt.opened.has(player.id) ? (player.id === round.imposter ? prompt.alternate : prompt.group) : null
      } : null
    };
  }
  if (phase === 'discussion') {
    const defence = round.defences.get(round.hotSeat);
    return {
      ...base, discussionUntil: round.discussionUntil,
      hotSeat: round.hotSeat ? { player: round.hotSeat, explanation: defence?.text, voice: defence?.voice?.id } : null,
      ...discussionHistory(round)
    };
  }
  if (round.prompt && ['vote', 'votes-in', 'countdown', 'scoreboard'].includes(phase)) {
    Object.assign(base, discussionHistory(round));
    if (phase !== 'vote') base.voteHistory = Object.fromEntries(round.votes);
  }
  if (phase === 'vote' || phase === 'votes-in') {
    const player = activeTurn(viewer, round.votes);
    return {
      ...base, ...turnProgress(round, round.votes, round.ballotOpened),
      turn: player ? { id: player.id, name: label(player), opened: round.ballotOpened.has(player.id) } : null
    };
  }
  if (phase === 'countdown') return { ...base, revealUntil: round.revealUntil };
  if (phase === 'scoreboard') return { ...base, ...round.archive, result: round.result, roster: room.players.map(publicPlayer) };
  return base;
}

function validName(value) {
  return typeof value === 'string' && value.trim().length > 0 && Array.from(value.trim()).length <= 40;
}

function joinRoom(value) {
  updateClock();
  requireState(validName(value), 'Enter a name up to 40 characters.', 400);
  const name = value.trim();
  const match = room.players.find((player) => player.name && nameKey(player.name) === nameKey(name));
  requireState(!match || match.needsRejoin, 'That name is already taken. Choose another name.', 400);
  const reserved = room.round?.players.find((player) => !player.name && room.players.includes(player));
  requireState(match || reserved || room.players.length < maxPlayers, 'This room already has 12 players.');
  const player = match ?? reserved ?? { id: 'online-' + token(), remote: true, score: 0 };
  if (match?.needsRejoin) {
    for (const [key, member] of sessions) {
      if (member === match) sessions.delete(key);
    }
  }
  player.name = name;
  player.needsRejoin = false;
  if (!room.players.includes(player)) room.players.push(player);
  const session = token();
  sessions.set(session, player);
  touch();
  return { ...snapshot({ host: false, player }), session };
}

function startFromLobby(body) {
  requireState(room.phase === 'lobby', 'The game already started.');
  const online = room.players.length;
  requireState(Array.isArray(body.names) && body.names.length <= maxPlayers && body.names.every(validName),
    'Enter a name for each in-person player.', 400);
  const reserved = body.reserved ?? 0;
  requireState(Number.isInteger(reserved) && reserved >= 0 && body.names.length + online + reserved <= maxPlayers,
    'There are 12 seats in total. Reduce the number of reserved seats or in-person players.', 400);
  requireState(body.names.length + online + reserved >= 3, 'You need at least 3 players to start.', 400);
  const keys = [...body.names, ...room.players.map(label)].map(nameKey);
  requireState(new Set(keys).size === keys.length, 'Give every player a different name.', 400);
  requireState(Array.isArray(body.genres) && body.genres.length > 0
    && body.genres.every((genre) => Number.isInteger(genre) && genre >= 0 && genre < packs.length),
    'Choose at least one question pack.', 400);
  const locals = body.names.map((name, index) => ({ id: 'local-' + index, name: name.trim(), remote: false, score: 0 }));
  const seats = Array.from({ length: reserved }, (_, index) => ({
    id: 'online-' + token(), name: '', seat: index + 1, remote: true, score: 0
  }));
  room.players = [...locals, ...room.players, ...seats];
  const genres = [...new Set(body.genres)];
  if (genres.length !== room.genres.length || genres.some((genre) => !room.genres.includes(genre))) room.genreQueue = [];
  room.genres = genres;
  startRound();
}

function resetGame() {
  room.localDraft = room.players.filter((player) => !player.remote).map((player) => player.name);
  room.players = room.players.filter((player) => player.remote && player.name && !player.needsRejoin);
  for (const player of room.players) player.score = 0;
  room.game++;
  room.roundNumber = 0;
  room.round = null;
  room.phase = 'lobby';
}

function verifyTurn(player, body) {
  requireState(player && player.id === body.player, 'That turn has already moved on.');
  requireState(player.name, 'Enter your name to take your turn.');
}

function takeAnswerTurn(viewer, body) {
  requireState(room.phase === 'answer', 'That question has already moved on.');
  const { prompt, players } = room.round;
  const player = activeTurn(viewer, prompt.answers);
  verifyTurn(player, body);
  if (body.action === 'open-answer') {
    prompt.opened.add(player.id);
    return;
  }
  const answer = typeof body.value === 'string' ? body.value.trim() : '';
  requireState(prompt.opened.has(player.id), 'Open your question first.');
  const count = words(answer);
  requireState(answer.length <= 280 && count >= 1 && count <= 5, 'Enter an answer in 1–5 words.', 400);
  prompt.answers.set(player.id, answer);
  prompt.opened.delete(player.id);
  if (prompt.answers.size === players.length) room.phase = 'answers-in';
}

function takeVoteTurn(viewer, body) {
  requireState(room.phase === 'vote', 'Voting has moved on.');
  const round = room.round;
  const player = activeTurn(viewer, round.votes);
  verifyTurn(player, body);
  if (body.action === 'open-vote') {
    round.ballotOpened.add(player.id);
    return;
  }
  requireState(round.ballotOpened.has(player.id), 'Open your ballot first.');
  requireState(body.value !== player.id && round.players.some((candidate) => candidate.id === body.value), 'Vote for one other player.', 400);
  round.votes.set(player.id, body.value);
  round.ballotOpened.delete(player.id);
  if (round.votes.size === round.players.length) room.phase = 'votes-in';
}

function perform(viewer, body) {
  updateClock();
  requireState(body.game === room.game, 'This game has moved on. Refresh if you still see the previous screen.');
  if (body.action === 'new-game') {
    requireState(viewer.host, 'Only the host can start a new game.', 403);
    requireState(room.round && body.round === room.roundNumber, 'The round has already moved on.');
    resetGame();
  } else if (body.action === 'start') {
    requireState(viewer.host, 'Only the host can start.', 403);
    startFromLobby(body);
  } else if (body.action === 'remove-player') {
    requireState(viewer.host && ['lobby', 'scoreboard'].includes(room.phase), 'Players can be removed between rounds.', 403);
    const player = room.players.find((candidate) => candidate.remote && candidate.id === body.player);
    requireState(player, 'That player already left.');
    room.players = room.players.filter((candidate) => candidate !== player);
    for (const [session, member] of sessions) {
      if (member === player) sessions.delete(session);
    }
  } else {
    requireState(room.round && body.round === room.roundNumber, 'That round has already moved on.');
    const round = room.round;
    if (body.action === 'chat') {
      const player = viewer.player?.id ?? 'host';
      const author = viewer.player ? label(viewer.player) : 'The host';
      requireState(room.phase === 'vote' || room.phase === 'votes-in', 'Voting chat has closed.');
      requireState(typeof body.messageId === 'string' && /^[a-f0-9-]{36}$/i.test(body.messageId), 'Invalid message.', 400);
      const last = round.timeline.findLast((event) => event.type === 'chat' && event.player === player);
      if (last?.id === body.messageId) return;
      const text = typeof body.value === 'string' ? body.value.trim() : '';
      requireState(text && text.length <= 280, 'Enter a message up to 280 characters.', 400);
      const at = Date.now();
      requireState(!last || at - last.at >= 600, 'Give it a moment before sending another message.', 429);
      round.timeline.push({ type: 'chat', player, author, text, id: body.messageId, at });
      touch();
      return;
    }
    requireState(viewer.host || round.players.includes(viewer.player), 'You’ll play from the next round.', 403);
    switch (body.action) {
      case 'open-answer':
      case 'answer':
        takeAnswerTurn(viewer, body);
        break;
      case 'open-vote':
      case 'vote':
        takeVoteTurn(viewer, body);
        break;
      case 'hot-seat':
        requireState(room.phase === 'discussion', 'The discussion has ended.');
        requireState(round.prompt.answers.has(body.player), 'Choose a player’s answer.', 400);
        round.hotSeat = round.hotSeat === body.player ? null : body.player;
        break;
      case 'nudge': {
        const sender = viewer.player?.id ?? 'host';
        requireState(room.phase === 'discussion', 'Discussion has ended.');
        requireState(sender !== body.player && round.players.some((player) => player.id === body.player && player.remote),
          'Choose another player on their own device.', 400);
        const count = body.count ?? 1;
        requireState(Number.isInteger(count) && count >= 1 && count <= 12, 'Invalid nudge count.', 400);
        const at = Date.now();
        const previous = round.nudgeRate.get(sender);
        const available = previous ? Math.min(24, previous.available + (at - previous.at) * .016) : 24;
        requireState(available >= count, 'Give the crew a moment between bursts.', 429);
        round.nudgeRate.set(sender, { available: available - count, at });
        round.hotSeat = body.player;
        const emojis = ['👀', '🫣', '🤨', '💀', '🕵️', '😂'];
        round.nudges = round.nudges.filter((event) => at - event.at < 12_000);
        for (let index = 0; index < count; index++) {
          round.nudges.push({ id: token(), player: body.player, emoji: emojis[randomInt(emojis.length)], at });
        }
        break;
      }
      case 'explain': {
        requireState(!viewer.host && room.phase === 'discussion' && round.hotSeat === viewer.player.id,
          'Your answer is no longer in the Hot Seat.');
        const explanation = typeof body.value === 'string' ? body.value.trim() : '';
        requireState(explanation && explanation.length <= 280, 'Enter an explanation up to 280 characters.', 400);
        const defence = round.defences.get(viewer.player.id);
        requireState(!defence?.text, 'You already sent a text defence.');
        round.defences.set(viewer.player.id, { ...defence, text: explanation });
        round.timeline.push({ type: 'text', player: viewer.player.id, text: explanation });
        break;
      }
      default:
        requireState(viewer.host, 'Only the host can do that.', 403);
        switch (body.action) {
          case 'receipts':
            requireState(room.phase === 'answers-in', 'Answers are still coming in.');
            room.phase = 'discussion';
            break;
          case 'timer':
            requireState(room.phase === 'discussion', 'The discussion has ended.');
            round.discussionUntil = Date.now() + 45_000;
            break;
          case 'start-vote':
            requireState(room.phase === 'discussion', 'The discussion has ended.');
            room.phase = 'vote';
            break;
          case 'countdown':
            requireState(room.phase === 'votes-in', 'Votes are still coming in.');
            room.phase = 'countdown';
            round.revealUntil = Date.now() + 5_000;
            break;
          case 'again':
            requireState(room.phase === 'scoreboard', 'This round is still going.');
            requireState(!room.players.some((player) => player.needsRejoin),
              'Ask the returning player to rejoin with their previous name, or remove them from the next round.');
            startRound();
            break;
          default:
            throw new GameError('Unknown action.', 400);
        }
    }
  }
  touch();
}

async function readBody(request, limit) {
  requireState(Number(request.headers['content-length'] ?? 0) <= limit, 'Request is too large.', 413);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > limit) throw new GameError('Request is too large.', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request) {
  const body = await readBody(request, 8_192);
  let result;
  try { result = JSON.parse(body); } catch { throw new GameError('Invalid request.', 400); }
  requireState(result && typeof result === 'object' && !Array.isArray(result), 'Invalid request.', 400);
  return result;
}

const voiceFormats = new Map([
  ['audio/mp4', (bytes) => bytes.toString('ascii', 4, 8) === 'ftyp'],
  ['audio/webm', (bytes) => bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))],
  ['audio/ogg', (bytes) => bytes.toString('ascii', 0, 4) === 'OggS']
]);

async function handleVoice(request, response, url, viewer, key) {
  requireState(viewer.host || viewer.player, 'Join the room first.', 401);
  if (request.method === 'GET') {
    const defences = room.round?.defences;
    const voice = defences && [...defences.values()].find((defence) => defence.voice?.id === url.searchParams.get('id'))?.voice;
    requireState(voice, 'Voice note not found.', 404);
    return send(response, 200, voice.type, voice.bytes);
  }
  const canRecord = () => viewer.player && sessions.get(key) === viewer.player && room.phase === 'discussion'
    && room.round.hotSeat === viewer.player.id && String(room.game) === url.searchParams.get('game')
    && String(room.roundNumber) === url.searchParams.get('round');
  requireState(canRecord(), 'You can send a voice note while you’re in the Hot Seat.', 403);
  const type = request.headers['content-type']?.split(';')[0].trim().toLowerCase();
  requireState(voiceFormats.has(type), 'This audio format is unsupported.', 415);
  const bytes = await readBody(request, 1024 * 1024);
  requireState(voiceFormats.get(type)(bytes), 'The recording couldn’t be read.', 400);
  requireState(canRecord(), 'Your Hot Seat has moved on.');
  const defence = room.round.defences.get(viewer.player.id);
  requireState(!defence?.voice, 'You already sent a voice defence.');
  const id = token();
  room.round.defences.set(viewer.player.id, { ...defence, voice: { id, type, bytes } });
  room.round.timeline.push({ type: 'voice', player: viewer.player.id, voice: id });
  touch();
  return json(response, 200, snapshot(viewer));
}

function send(response, status, type, content) {
  response.writeHead(status, {
    'Content-Type': typeof content === 'string' ? type + '; charset=utf-8' : type,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'X-Robots-Tag': 'noindex, nofollow'
  });
  response.end(content);
}

function json(response, status, body) {
  send(response, status, 'application/json', JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname;
    if (assets.has(path) && request.method === 'GET') {
      const [type, content] = assets.get(path);
      return send(response, 200, type, content);
    }
    if (['/api/room', '/api/voice'].includes(path) && ['GET', 'POST'].includes(request.method)) {
      const key = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
      const viewer = { host: key === hostKey, player: sessions.get(key) };
      const invited = key === guestKey;
      requireState(viewer.host || viewer.player || invited, 'Open the private link your host shared.', 401);
      if (path === '/api/voice') return await handleVoice(request, response, url, viewer, key);
      if (request.method === 'POST') {
        const body = await readJson(request);
        if (invited) {
          requireState(body.action === 'join', 'Join the room to play.', 403);
          return json(response, 200, joinRoom(body.value));
        }
        requireState(viewer.host || sessions.get(key) === viewer.player, 'Your seat was removed.', 401);
        perform(viewer, body);
      }
      return json(response, 200, snapshot(viewer));
    }
    if (path === '/healthz' && request.method === 'GET') return json(response, 200, { ready: true });
    return json(response, 404, { error: 'Page not found.' });
  } catch (error) {
    if (!(error instanceof GameError)) console.error(error);
    if (!response.headersSent) json(response, error.status ?? 500, { error: error.status ? error.message : 'The room hit an error. Try again.' });
  }
});

const port = Number(process.env.KAUN_SUS_PORT ?? 43186);
server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ port: server.address().port, host: hostKey, guest: guestKey }));
});
