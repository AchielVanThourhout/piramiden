import "./style.css";
import { io } from "socket.io-client";

const socket = io(import.meta.env.VITE_SERVER_URL || "http://localhost:3000");

let state = {
  screen: "home", // home | lobby | game | memory
  roomCode: "",
  name: "",
  lobby: { host: "", players: [], votes: 0, required: 0, youVoted: false },
  game: null,
  memoryGuesses: ["", "", "", ""],
  now: Date.now()
};

setInterval(() => {
  state.now = Date.now();
  if (state.screen === "game" && (state.game?.phase === "claim" || state.game?.phase === "review")) render();
}, 300);

const app = document.querySelector("#app");

function showMsg(text) {
  const el = document.querySelector("#msg");
  if (el) el.textContent = text;
}

function shell(title, rightHtml, innerHtml) {
  app.innerHTML = `
    <div class="container">
      <div class="topbar">
        <div class="brand">
          <div style="width:12px;height:12px;border-radius:4px;background:var(--accent); box-shadow:0 0 0 4px rgba(124,92,255,.15);"></div>
          <div>${escapeHtml(title)}</div>
        </div>
        <div>${rightHtml ?? ""}</div>
      </div>

      ${innerHtml}
    </div>
  `;
}

function render() {
  if (state.screen === "home") {
    shell("Piramiden", `<span class="badge">online</span>`, `
      <div class="card">
        <div class="h1">Piramiden</div>
        <div class="small">Maak een room of join met een code.</div>

        <div class="spacer"></div>

        <div class="stack">
          <input class="input" id="name" placeholder="Jouw naam" value="${escapeAttr(state.name)}" />

          <div class="grid2">
            <button class="btn btn-primary" id="create">Create room</button>
            <div class="row" style="width:100%;">
              <input class="input" id="code" placeholder="Room code" />
            </div>
          </div>

          <button class="btn" id="join">Join room</button>

          <div id="msg" class="msg"></div>
        </div>
      </div>
    `);

    document.querySelector("#name").oninput = (e) => { state.name = e.target.value; };

    document.querySelector("#create").onclick = () => {
      const name = state.name.trim();
      if (!name) return showMsg("Vul eerst je naam in.");

      socket.emit("room:create", { name }, (res) => {
        if (!res?.ok) return showMsg(res?.error ?? "Create mislukt.");
        state.roomCode = res.code;
        applyLobbyStatus(res.status);
        state.screen = "lobby";
        render();
      });
    };

    document.querySelector("#join").onclick = () => {
      const code = document.querySelector("#code").value.trim().toUpperCase();
      const name = state.name.trim();
      if (!name) return showMsg("Vul eerst je naam in.");
      if (!code) return showMsg("Geef een room code in.");

      socket.emit("room:join", { code, name }, (res) => {
        if (!res?.ok) return showMsg(res?.error ?? "Join mislukt.");
        state.roomCode = res.code;
        applyLobbyStatus(res.status);
        state.screen = "lobby";
        render();
      });
    };

    return;
  }

  if (state.screen === "lobby") {
    shell("Lobby", `<span class="badge">Room ${escapeHtml(state.roomCode)}</span>`, `
      <div class="card">
        <div class="row" style="justify-content:space-between;">
          <div>
            <div class="h1" style="margin-bottom:6px;">Lobby</div>
            <div class="small"><b>Jij:</b> ${escapeHtml(state.name)}</div>
          </div>
          <div class="pill">Ready <b>${state.lobby.votes}</b> / ${state.lobby.required}</div>
        </div>

        <div class="h2">Spelers</div>
        <ul class="list">
          ${state.lobby.players.map(p => `
            <li>
              <span>${escapeHtml(p)}${p===state.lobby.host ? ` <span class="badge">maker</span>` : ""}</span>
            </li>
          `).join("")}
        </ul>

        <div class="notice">
          Iedereen klikt <b>Ready</b>. Zodra genoeg mensen klaar zijn start het spel.
        </div>

        <div id="msg" class="msg"></div>
      </div>

      <div class="stickybar">
        <div class="inner">
          <button class="btn btn-primary" id="start" ${state.lobby.players.length < 2 ? "disabled" : ""}>
            ${state.lobby.youVoted ? "Ready ✅ (toggle)" : "Ready"}
          </button>
          <button class="btn" id="back">Terug</button>
        </div>
      </div>
    `);

    document.querySelector("#start").onclick = () => socket.emit("start:vote");

    document.querySelector("#back").onclick = () => {
      state.screen = "home";
      state.roomCode = "";
      state.lobby = { host: "", players: [], votes: 0, required: 0, youVoted: false };
      state.game = null;
      state.memoryGuesses = ["", "", "", ""];
      render();
    };

    return;
  }

  if (!state.game) {
    shell("Piramiden", "", `<div class="card"><div class="small">Wachten op game state...</div></div>`);
    return;
  }

  if (state.screen === "memory") return renderMemory();
  return renderGame();
}

function renderGame() {
  const g = state.game;

  const handHtml = (g.yourHand ?? []).map((c, i) => {
    const shown = (g.phase === "review" || !g.handLocked) ? escapeHtml(c?.v ?? "") : "🂠";
    return `<button class="cardbtn" disabled>${shown}<small>${i+1}</small></button>`;
  }).join("");

  // REVIEW
  if (g.phase === "review") {
    const endsAt = g.review?.endsAt ?? 0;
    const secsLeft = Math.max(0, Math.ceil((endsAt - state.now) / 1000));
    const yourReady = Boolean(g.review?.yourReady);
    const readyCount = g.review?.readyCount ?? 0;
    const total = g.review?.totalPlayers ?? g.players.length;

    shell("Spel", `<span class="badge">Room ${escapeHtml(state.roomCode)}</span>`, `
      <div class="card">
        <div class="row" style="justify-content:space-between;">
          <div>
            <div class="h1" style="margin-bottom:6px;">Bekijk je kaarten</div>
            <div class="small"><b>Jij:</b> ${escapeHtml(state.name)}</div>
          </div>
          <div class="pill">Start in <b>${secsLeft}s</b></div>
        </div>

        <div class="h2">Hand</div>
        <div class="hand">${handHtml}</div>

        <div class="notice">
          Klaar: <b>${readyCount}</b> / ${total}. Iedereen moet bevestigen of de timer start automatisch.
        </div>
      </div>

      <div class="stickybar">
        <div class="inner">
          <button class="btn btn-green" id="ready" ${yourReady ? "disabled" : ""}>
            Ik heb mijn kaarten bekeken ✅
          </button>
          <button class="btn" id="noop" disabled>${yourReady ? "Klaar ✅" : "Nog niet klaar"}</button>
        </div>
      </div>
    `);

    document.querySelector("#ready").onclick = () => socket.emit("review:ready");
    return;
  }

  // CLAIM/RESOLVE/DRINK
  const targets = (g.players ?? []).filter(p => p !== state.name);
  const targetOptions = targets.map(p => `<option value="${escapeAttr(p)}">${escapeHtml(p)}</option>`).join("");

  const passEndsAt = g.round?.passEndsAt ?? 0;
  const secsLeft = Math.max(0, Math.ceil((passEndsAt - state.now) / 1000));

  const phase = g.phase;
  const decision = g.round?.yourDecision ?? null;

  const claimDisabled = phase !== "claim" || decision !== null || !g.current || targets.length === 0;

  const claimsHtml = (g.round?.claims ?? []).length === 0
    ? `<div class="small">Nog geen claims.</div>`
    : g.round.claims.map((c, idx) => {
        let actions = "";

        if (phase === "resolve" && c.status === "pending_belief" && c.target === state.name) {
          actions = `
            <div class="row" style="margin-top:10px;">
              <button class="btn btn-green" data-act="believe" data-i="${idx}">Geloof</button>
              <button class="btn btn-danger" data-act="doubt" data-i="${idx}">Niet geloven</button>
            </div>
          `;
        }

        if (phase === "resolve" && c.status === "awaiting_proof" && c.claimer === state.name) {
          const picks = new Set(c.proofPicks ?? []);
          const pickBtns = [0,1,2,3].map(i => {
            const mark = picks.has(i) ? "✅" : "🂠";
            return `<button class="cardbtn" data-act="pick" data-i="${idx}" data-card="${i}">${mark}<small>${i+1}</small></button>`;
          }).join("");

          actions = `
            <div class="notice"><b>Toon ${c.mult} kaart(en)</b>: klik slots hieronder.</div>
            <div class="hand">${pickBtns}</div>
          `;
        }

        const statusTxt =
          c.status === "pending_belief" ? "wacht op geloof/niet geloof" :
          c.status === "awaiting_proof" ? "bewijs nodig" :
          "afgehandeld";

        return `
          <div class="card" style="margin:10px 0; padding:12px;">
            <div><b>${escapeHtml(c.claimer)}</b> zegt “ik heb ’m” (x${c.mult}) → <b>${escapeHtml(c.target)}</b></div>
            <div class="small" style="margin-top:6px;">Status: ${statusTxt}</div>
            ${actions}
          </div>
        `;
      }).join("");

  const drinkTasks = g.round?.yourDrinkTasks ?? [];
  const mustAck = drinkTasks.length > 0;
  const yourAck = Boolean(g.round?.yourDrinkAck);

  const drinkHtml = (phase !== "drink")
    ? `<div class="small">Drinken komt na de afhandeling.</div>`
    : (
        mustAck
          ? `
            <ul class="list">
              ${drinkTasks.map(t => `<li><span><b>${escapeHtml(t)}</b></span></li>`).join("")}
            </ul>
            <button class="btn btn-green" id="drinkAck" ${yourAck ? "disabled" : ""}>Gedronken ✅</button>
            <div class="small" style="margin-top:8px;">Bevestig om verder te gaan.</div>
          `
          : `<div class="small"><b>Geen drank voor jou.</b> Wachten op anderen…</div>`
      );

  shell("Spel", `<span class="badge">Room ${escapeHtml(state.roomCode)}</span>`, `
    <div class="card">
      <div class="row" style="justify-content:space-between;">
        <div>
          <div class="h1" style="margin-bottom:6px;">Ronde</div>
          <div class="small"><b>Jij:</b> ${escapeHtml(state.name)}</div>
        </div>
        <div class="pill">${g.current ? `Kaart <b>${escapeHtml(g.current.value)}</b>` : "Nog geen kaart"}</div>
      </div>

      <div class="h2">Hand</div>
      <div class="hand">${handHtml}</div>
      <div class="small">${g.handLocked ? "Hand is omgedraaid (geheugen!)." : "Hand is nog zichtbaar."}</div>

      <div class="h2">Piramide</div>
      <div class="notice">
        ${g.current
          ? `<b>Rij:</b> ${g.current.row} — <b>Basis:</b> ${escapeHtml(g.current.base)}`
          : `Nog geen kaart omgedraaid.`}
        <div class="small" style="margin-top:6px;">Omgedraaid: ${Math.max(0, g.revealedIndex + 1)} / ${g.pyramidTotal}</div>
      </div>

      <div class="h2">Claims</div>
      ${claimsHtml}

      <div class="h2">Drinken</div>
      ${drinkHtml}
    </div>

    <div class="stickybar">
      <div class="inner">
        <button class="btn btn-primary" id="claimBtn" ${claimDisabled ? "disabled" : ""}>
          Ik heb ’m
        </button>
        <button class="btn" id="passBtn" ${phase !== "claim" || decision !== null ? "disabled" : ""}>
          Ik heb ’m niet
        </button>
      </div>
      <div class="container" style="padding: 10px 14px 0;">
        <div class="row">
          <select id="mult" ${claimDisabled ? "disabled" : ""}>
            <option value="1">x1</option>
            <option value="2">x2</option>
            <option value="3">x3</option>
            <option value="4">x4</option>
          </select>
          <select id="target" ${claimDisabled ? "disabled" : ""}>
            ${targetOptions}
          </select>
          <div class="pill">${phase === "claim" ? `Auto-pass in <b>${secsLeft}s</b>` : `Fase: <b>${escapeHtml(phase)}</b>`}</div>
        </div>
        <div class="small" style="margin-top:8px;">
          Jouw keuze: ${decision ? `<b>${escapeHtml(decision)}</b>` : `<i>nog niet gekozen</i>`}
        </div>
      </div>
    </div>
  `);

  const claimBtn = document.querySelector("#claimBtn");
  if (claimBtn) {
    claimBtn.onclick = () => {
      const mult = parseInt(document.querySelector("#mult").value, 10);
      const target = document.querySelector("#target").value;
      socket.emit("game:claim", { mult, target });
    };
  }

  const passBtn = document.querySelector("#passBtn");
  if (passBtn) passBtn.onclick = () => socket.emit("game:pass");

  app.querySelectorAll("button[data-act]").forEach(btn => {
    btn.onclick = () => {
      const act = btn.dataset.act;
      const i = parseInt(btn.dataset.i, 10);

      if (act === "believe") socket.emit("game:believe", { claimIndex: i, believe: true });
      if (act === "doubt") socket.emit("game:believe", { claimIndex: i, believe: false });
      if (act === "pick") {
        const cardIdx = parseInt(btn.dataset.card, 10);
        socket.emit("game:proofPick", { claimIndex: i, cardIndex: cardIdx });
      }
    };
  });

  const drinkAck = document.querySelector("#drinkAck");
  if (drinkAck) drinkAck.onclick = () => socket.emit("drink:ack");
}

function renderMemory() {
  const g = state.game;

  shell("Eindtest", `<span class="badge">Room ${escapeHtml(state.roomCode)}</span>`, `
    <div class="card">
      <div class="h1">Eindtest</div>
      <div class="small"><b>Jij:</b> ${escapeHtml(state.name)}</div>

      <div class="h2">Raad je 4 kaarten (per slot)</div>

      <div class="stack">
        ${state.memoryGuesses.map((val, i) => `
          <div class="row">
            <div class="pill" style="min-width:92px;">Slot <b>${i+1}</b></div>
            <input class="input" data-gi="${i}" value="${escapeAttr(val)}" placeholder="bv. 7 / K / A / 10" ${g.memory?.yourSubmitted ? "disabled" : ""} />
          </div>
        `).join("")}

        <button class="btn btn-primary" id="submit" ${g.memory?.yourSubmitted ? "disabled" : ""}>Indienen</button>

        <div class="notice">
          Voortgang: <b>${g.memory?.submittedCount ?? 0}</b> / ${g.memory?.totalPlayers ?? 0} ingediend
        </div>
      </div>
    </div>
  `);

  app.querySelectorAll("input[data-gi]").forEach(inp => {
    inp.oninput = () => {
      const i = parseInt(inp.dataset.gi, 10);
      state.memoryGuesses[i] = inp.value;
    };
  });

  document.querySelector("#submit").onclick = () => {
    socket.emit("memory:submit", { guesses: state.memoryGuesses });
  };
}

/* socket events */
function applyLobbyStatus(status) {
  state.lobby.host = status.host;
  state.lobby.players = status.players;
  state.lobby.votes = status.votes;
  state.lobby.required = status.required;
  state.lobby.youVoted = (status.voters ?? []).includes(state.name.trim());
}

socket.on("room:status", (status) => {
  applyLobbyStatus(status);
  if (state.screen === "lobby") render();
});

socket.on("game:state", (gameState) => {
  state.game = gameState;

  if (gameState.phase === "memory" && state.screen !== "memory") {
    state.memoryGuesses = ["", "", "", ""];
  }

  state.screen = (gameState.phase === "memory") ? "memory" : "game";
  render();
});

/* utils */
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function escapeAttr(s) {
  return escapeHtml(s).replaceAll("\n", " ");
}

render();
