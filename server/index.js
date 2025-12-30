import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// roomCode -> room
const rooms = new Map();

/* ------------------ room helpers ------------------ */
function makeCode() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}
function requiredVotes(n) {
  return Math.ceil(n * 0.75);
}
function getRoomStatus(room) {
  return {
    host: room.host,
    players: room.players,
    votes: room.startVotes.size,
    required: requiredVotes(room.players.length),
    voters: Array.from(room.startVotes)
  };
}
function emitRoomStatus(code) {
  const room = rooms.get(code);
  if (!room) return;
  io.to(code).emit("room:status", getRoomStatus(room));
}

/* ------------------ cards/game helpers ------------------ */
function buildDeck() {
  const values = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
  const suits = ["S","H","D","C"];
  const deck = [];
  for (const v of values) for (const s of suits) deck.push({ v, s });
  return deck;
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function maxRows(n) {
  let r = 1;
  while ((r + 1) * (r + 2) / 2 <= n) r++;
  return r;
}
function rowOfIndex(pyramidRows, idx) {
  let row = 1;
  let consumed = 0;
  for (let bottom = pyramidRows; bottom >= 1; bottom--) {
    const len = bottom;
    if (idx < consumed + len) return row;
    consumed += len;
    row++;
  }
  return row;
}
function currentInfo(state) {
  if (!state || state.revealedIndex < 0) return null;
  const card = state.pyramid[state.revealedIndex];
  const row = rowOfIndex(state.pyramidRows, state.revealedIndex);
  const isTop = row === state.pyramidRows;
  const baseText = isTop ? "FUNDI" : `${row} slok(ken)`;
  return { value: card.v, row, isTop, baseText };
}

function clearRoundTimer(room) {
  if (room.roundTimer) {
    clearTimeout(room.roundTimer);
    room.roundTimer = null;
  }
}
function clearReviewTimer(room) {
  if (room.reviewTimer) {
    clearTimeout(room.reviewTimer);
    room.reviewTimer = null;
  }
}

/**
 * SECURITY/FAIR SNAPSHOT:
 * - je ziet enkel je eigen hand (waardes)
 * - je ziet NIET de volledige piramide, enkel huidige kaart + progress
 */
function makeSnapshot(room, viewer) {
  const s = room.state;
  const info = currentInfo(s);

  const yourDecision = s.round ? (s.round.decisions[viewer] ?? null) : null;

  const claims = (s.round?.claims ?? []).map(c => ({
    claimer: c.claimer,
    target: c.target,
    mult: c.mult,
    status: c.status,
    proofPicks: (viewer === c.claimer ? (c.proofPicks ?? []) : [])
  }));

  const drinkTasks = s.round?.drinks?.[viewer] ?? [];
  const mustAckDrink = drinkTasks.length > 0;
  const yourDrinkAck = mustAckDrink ? Boolean(s.round.drinkAck[viewer]) : true;

  const memorySubmitted = s.memory?.submitted ?? {};
  const submittedCount = Object.values(memorySubmitted).filter(Boolean).length;

  const reviewReady = s.review?.ready ?? {};
  const readyCount = Object.values(reviewReady).filter(Boolean).length;

  return {
    phase: s.phase, // review | claim | resolve | drink | memory
    players: room.players,

    pyramidRows: s.pyramidRows,
    pyramidTotal: s.pyramidTotal,
    revealedIndex: s.revealedIndex,
    current: info ? { value: info.value, row: info.row, isTop: info.isTop, base: info.baseText } : null,

    handLocked: s.handLocked,
    yourHand: s.hands[viewer] ?? [],

    review: s.review ? {
      endsAt: s.review.endsAt,
      yourReady: Boolean(reviewReady[viewer]),
      readyCount,
      totalPlayers: room.players.length
    } : null,

    round: s.round ? {
      passEndsAt: s.round.passEndsAt,
      yourDecision,
      claims,
      yourDrinkTasks: drinkTasks,
      yourDrinkAck
    } : null,

    log: (s.log ?? []).slice(-20),

    memory: {
      yourSubmitted: Boolean(memorySubmitted[viewer]),
      submittedCount,
      totalPlayers: room.players.length
    }
  };
}

async function broadcastGame(code) {
  const room = rooms.get(code);
  if (!room?.state) return;

  const sockets = await io.in(code).fetchSockets();
  for (const sock of sockets) {
    const name = sock.data.name;
    if (!name) continue;
    sock.emit("game:state", makeSnapshot(room, name));
  }
}

/* ------------------ round engine (no-host) ------------------ */
function newRoundState(players) {
  return {
    decisions: Object.fromEntries(players.map(p => [p, null])), // null | "passed" | "claimed"
    passEndsAt: Date.now() + 30_000,
    claims: [],
    drinks: Object.fromEntries(players.map(p => [p, []])),
    drinkAck: Object.fromEntries(players.map(p => [p, false]))
  };
}
function allDecided(room) {
  return room.players.every(p => room.state.round.decisions[p] !== null);
}
function allClaimsResolved(room) {
  return room.state.round.claims.every(c => c.status === "resolved");
}
function requiredDrinkers(room) {
  return room.players.filter(p => (room.state.round.drinks[p] ?? []).length > 0);
}
function allDrinkAcked(room) {
  const req = requiredDrinkers(room);
  return req.every(p => room.state.round.drinkAck[p] === true);
}
function addDrink(room, player, text) {
  room.state.round.drinks[player].push(text);
}
function resolveToDrinkText(info, kind, mult) {
  if (!info) return "";
  const multTxt = mult > 1 ? ` x${mult}` : "";
  if (info.isTop) {
    return (kind === "double" ? `DUBBELE FUNDI${multTxt}` : `FUNDI${multTxt}`);
  }
  const base = info.row;
  const amount = (kind === "double") ? (base * 2) : base;
  return `${amount} slok(ken)${multTxt}`;
}

async function advanceIfPossible(code) {
  const room = rooms.get(code);
  if (!room?.state) return;

  const s = room.state;

  if (s.phase === "claim" && allDecided(room)) {
    clearRoundTimer(room);
    s.phase = "resolve";

    if (s.round.claims.length === 0) {
      s.phase = "drink";
      if (requiredDrinkers(room).length === 0) {
        await advanceToNextCard(code);
        return;
      }
    }

    await broadcastGame(code);
    return;
  }

  if (s.phase === "resolve" && allClaimsResolved(room)) {
    s.phase = "drink";
    if (requiredDrinkers(room).length === 0) {
      await advanceToNextCard(code);
      return;
    }
    await broadcastGame(code);
    return;
  }

  if (s.phase === "drink" && allDrinkAcked(room)) {
    await advanceToNextCard(code);
    return;
  }
}

async function advanceToNextCard(code) {
  const room = rooms.get(code);
  if (!room?.state) return;

  const s = room.state;

  if (s.revealedIndex >= s.pyramidTotal - 1) {
    s.phase = "memory";
    await broadcastGame(code);
    return;
  }

  // volgende kaart
  s.revealedIndex++;
  if (s.revealedIndex === 0) s.handLocked = true;

  // nieuwe round
  s.review = null;
  s.round = newRoundState(room.players);
  s.phase = "claim";
  s.roundId = (s.roundId ?? 0) + 1;
  const thisRoundId = s.roundId;

  clearRoundTimer(room);
  room.roundTimer = setTimeout(async () => {
    const r = rooms.get(code);
    if (!r?.state) return;
    if (r.state.roundId !== thisRoundId) return;

    for (const p of r.players) {
      if (r.state.round.decisions[p] === null) r.state.round.decisions[p] = "passed";
    }
    await broadcastGame(code);
    await advanceIfPossible(code);
  }, 30_000);

  await broadcastGame(code);
}

function startGameForRoom(code) {
  const room = rooms.get(code);
  if (!room) return;

  const players = room.players;
  if (players.length < 2) return;

  const deck = shuffle(buildDeck());

  const hands = {};
  for (const p of players) hands[p] = deck.splice(0, 4);

  const r = maxRows(deck.length);
  const need = (r * (r + 1)) / 2;
  const pyramid = deck.splice(0, need);

  room.state = {
    hands,
    pyramid,
    pyramidRows: r,
    pyramidTotal: pyramid.length,
    revealedIndex: -1,
    handLocked: false,

    // nieuwe flow
    phase: "review", // start hier!
    reviewId: 0,
    review: null,

    roundId: 0,
    round: null,

    log: [],
    memory: { submitted: Object.fromEntries(players.map(p => [p, false])) }
  };
}

async function startReviewPhase(code) {
  const room = rooms.get(code);
  if (!room?.state) return;
  const s = room.state;

  clearReviewTimer(room);

  s.phase = "review";
  s.reviewId = (s.reviewId ?? 0) + 1;
  const thisReviewId = s.reviewId;

  s.review = {
    endsAt: Date.now() + 90_000,
    ready: Object.fromEntries(room.players.map(p => [p, false]))
  };

  room.reviewTimer = setTimeout(async () => {
    const r = rooms.get(code);
    if (!r?.state) return;
    if (r.state.reviewId !== thisReviewId) return;
    if (r.state.phase !== "review") return;

    // na 90s: force start
    await advanceToNextCard(code);
  }, 90_000);

  await broadcastGame(code);
}

function allReviewReady(room) {
  const ready = room.state.review?.ready ?? {};
  return room.players.every(p => ready[p] === true);
}

/* ------------------ sockets ------------------ */
io.on("connection", (socket) => {
  socket.on("room:create", ({ name }, cb) => {
    name = (name ?? "").trim();
    if (!name) return cb?.({ ok: false, error: "Vul een naam in." });

    let code = makeCode();
    while (rooms.has(code)) code = makeCode();

    const room = {
      host: name,
      players: [name],
      started: false,
      startVotes: new Set(),
      state: null,
      roundTimer: null,
      reviewTimer: null
    };
    rooms.set(code, room);

    socket.join(code);
    socket.data.code = code;
    socket.data.name = name;

    const status = getRoomStatus(room);
    io.to(code).emit("room:status", status);
    cb?.({ ok: true, code, status });
  });

  socket.on("room:join", ({ code, name }, cb) => {
    code = code?.toUpperCase();
    name = (name ?? "").trim();

    if (!code || !name) return cb?.({ ok: false, error: "Ongeldige code/naam." });
    if (!rooms.has(code)) return cb?.({ ok: false, error: "Room bestaat niet." });

    const room = rooms.get(code);
    if (room.started) return cb?.({ ok: false, error: "Spel is al gestart." });

    if (room.players.includes(name)) {
      return cb?.({ ok: false, error: "Die naam is al in gebruik in deze room." });
    }

    room.players.push(name);

    socket.join(code);
    socket.data.code = code;
    socket.data.name = name;

    room.startVotes.delete(name);
    const status = getRoomStatus(room);
    io.to(code).emit("room:status", status);
    cb?.({ ok: true, code, status });
  });

  socket.on("start:vote", async () => {
    const code = socket.data.code;
    const name = socket.data.name;
    if (!code || !rooms.has(code) || !name) return;

    const room = rooms.get(code);
    if (room.started) return;

    if (room.startVotes.has(name)) room.startVotes.delete(name);
    else room.startVotes.add(name);

    emitRoomStatus(code);

    const req = requiredVotes(room.players.length);
    if (room.startVotes.size >= req) {
      room.started = true;
      room.startVotes.clear();

      startGameForRoom(code);
      await startReviewPhase(code); // <-- eerst review, dan pas eerste kaart
    }
  });

  // REVIEW READY
  socket.on("review:ready", async () => {
    const code = socket.data.code;
    const name = socket.data.name;
    if (!code || !rooms.has(code) || !name) return;

    const room = rooms.get(code);
    const s = room.state;
    if (!s || s.phase !== "review" || !s.review) return;

    s.review.ready[name] = true;

    await broadcastGame(code);

    if (allReviewReady(room)) {
      clearReviewTimer(room);
      await advanceToNextCard(code); // eerste kaart omdraaien
    }
  });

  // CLAIM: ik heb 'm
  socket.on("game:claim", async ({ mult, target }) => {
    const code = socket.data.code;
    const name = socket.data.name;
    if (!code || !rooms.has(code) || !name) return;

    const room = rooms.get(code);
    const s = room.state;
    if (!s || s.phase !== "claim") return;

    const t = String(target ?? "").trim();
    mult = Number(mult);

    if (![1,2,3,4].includes(mult)) return;
    if (!room.players.includes(t)) return;
    if (t === name) return;

    if (s.round.decisions[name] !== null) return;

    s.round.decisions[name] = "claimed";
    s.round.claims.push({
      claimer: name,
      target: t,
      mult,
      status: "pending_belief",
      proofPicks: []
    });

    await broadcastGame(code);
    await advanceIfPossible(code);
  });

  // PASS: ik heb 'm niet
  socket.on("game:pass", async () => {
    const code = socket.data.code;
    const name = socket.data.name;
    if (!code || !rooms.has(code) || !name) return;

    const room = rooms.get(code);
    const s = room.state;
    if (!s || s.phase !== "claim") return;

    if (s.round.decisions[name] !== null) return;
    s.round.decisions[name] = "passed";

    await broadcastGame(code);
    await advanceIfPossible(code);
  });

  // TARGET: geloof / niet geloof
  socket.on("game:believe", async ({ claimIndex, believe }) => {
    const code = socket.data.code;
    const name = socket.data.name;
    if (!code || !rooms.has(code) || !name) return;

    const room = rooms.get(code);
    const s = room.state;
    if (!s || s.phase !== "resolve") return;

    const i = Number(claimIndex);
    const claim = s.round.claims?.[i];
    if (!claim) return;

    if (claim.target !== name) return;
    if (claim.status !== "pending_belief") return;

    const info = currentInfo(s);
    if (!info) return;

    if (Boolean(believe)) {
      const text = resolveToDrinkText(info, "base", claim.mult);
      addDrink(room, claim.target, text);
      s.log.push(`${claim.target} moet drinken: ${text} (geloofde ${claim.claimer})`);
      claim.status = "resolved";
    } else {
      claim.status = "awaiting_proof";
      claim.proofPicks = [];
    }

    await broadcastGame(code);
    await advanceIfPossible(code);
  });

  // CLAIMER: bewijs tonen (slots)
  socket.on("game:proofPick", async ({ claimIndex, cardIndex }) => {
    const code = socket.data.code;
    const name = socket.data.name;
    if (!code || !rooms.has(code) || !name) return;

    const room = rooms.get(code);
    const s = room.state;
    if (!s || s.phase !== "resolve") return;

    const i = Number(claimIndex);
    const claim = s.round.claims?.[i];
    if (!claim) return;

    if (claim.claimer !== name) return;
    if (claim.status !== "awaiting_proof") return;

    const ci = Number(cardIndex);
    if (![0,1,2,3].includes(ci)) return;
    if (claim.proofPicks.includes(ci)) return;

    claim.proofPicks.push(ci);

    if (claim.proofPicks.length >= claim.mult) {
      const info = currentInfo(s);
      if (!info) return;

      const hand = s.hands[claim.claimer] ?? [];
      const picks = claim.proofPicks.map(idx => hand[idx]);
      const ok = picks.length === claim.mult && picks.every(c => c?.v === info.value);

      const text = resolveToDrinkText(info, "double", claim.mult);

      if (ok) {
        addDrink(room, claim.target, text);
        s.log.push(`${claim.target} moet dubbel drinken: ${text} (bewijs klopt van ${claim.claimer})`);
      } else {
        addDrink(room, claim.claimer, text);
        s.log.push(`${claim.claimer} moet dubbel drinken: ${text} (bewijs faalt tegen ${claim.target})`);
      }

      claim.status = "resolved";
    }

    await broadcastGame(code);
    await advanceIfPossible(code);
  });

  // DRINK ACK
  socket.on("drink:ack", async () => {
    const code = socket.data.code;
    const name = socket.data.name;
    if (!code || !rooms.has(code) || !name) return;

    const room = rooms.get(code);
    const s = room.state;
    if (!s || s.phase !== "drink") return;

    const tasks = s.round.drinks[name] ?? [];
    if (tasks.length === 0) return;

    s.round.drinkAck[name] = true;
    s.log.push(`${name} heeft bevestigd: gedronken ✅`);

    await broadcastGame(code);
    await advanceIfPossible(code);
  });

  // MEMORY submit
  socket.on("memory:submit", async ({ guesses }) => {
    const code = socket.data.code;
    const name = socket.data.name;
    if (!code || !rooms.has(code) || !name) return;

    const room = rooms.get(code);
    const s = room.state;
    if (!s || s.phase !== "memory") return;

    if (s.memory.submitted[name]) return;
    if (!Array.isArray(guesses) || guesses.length !== 4) return;

    const norm = (x) => String(x ?? "").trim().toUpperCase();
    const g = guesses.map(norm);
    const actual = (s.hands[name] ?? []).map(c => String(c?.v ?? "").toUpperCase());

    const ok = g.every((x, idx) => x === actual[idx]);
    if (ok) s.log.push(`${name}: eindtest OK ✅`);
    else s.log.push(`${name}: fout ❌ → FUNDI`);

    s.memory.submitted[name] = true;

    await broadcastGame(code);
  });

  socket.on("disconnect", () => {
    const code = socket.data.code;
    const name = socket.data.name;
    if (!code || !rooms.has(code) || !name) return;

    const room = rooms.get(code);

    room.players = room.players.filter(p => p !== name);
    room.startVotes.delete(name);

    if (room.players.length === 0) {
      clearRoundTimer(room);
      clearReviewTimer(room);
      rooms.delete(code);
      return;
    }

    emitRoomStatus(code);
    if (room.state) broadcastGame(code);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
