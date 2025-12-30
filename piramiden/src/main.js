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

// klokje voor countdowns (review + claim)
setInterval(() => {
  state.now = Date.now();
  if (state.screen === "game" && (state.game?.phase === "claim" || state.game?.phase === "review")) render();
}, 300);

const app = document.querySelector("#app");

function showMsg(text) {
  const el = document.querySelector("#msg");
  if (el) el.textContent = text;
}

function render() {
  if (state.screen === "home") {
    app.innerHTML = `
      <h1>Piramiden</h1>

      <div style="display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap;">
        <input id="name" placeholder="Jouw naam" value="${escapeHtml(state.name)}" />
        <button id="create">Create room</button>
      </div>

      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <input id="code" placeholder="Room code" />
        <button id="join">Join room</button>
      </div>

      <p id="msg" style="margin-top:10px; color:#b00;"></p>
    `;

    document.querySelector("#name").oninput = (e) => {
      state.name = e.target.value;
    };

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
    app.innerHTML = `
      <h1>Lobby</h1>
      <p><b>Room:</b> ${escapeHtml(state.roomCode)}</p>
      <p><b>Jij:</b> ${escapeHtml(state.name)}</p>

      <h3>Spelers</h3>
      <ul>
        ${state.lobby.players.map(p => `<li>${escapeHtml(p)}${p===state.lobby.host ? " (maker)" : ""}</li>`).join("")}
      </ul>

      <div style="display:flex; gap:8px; margin-top:12px; flex-wrap:wrap;">
        <button id="start" ${state.lobby.players.length < 2 ? "disabled" : ""}>
          ${state.lobby.youVoted ? "Ready ✅ (klik om uit te zetten)" : "Start spel (Ready)"}
        </button>
        <button id="back">Terug</button>
      </div>

      <p style="margin-top:10px; opacity:.7;">
        Ready: ${state.lobby.votes} / ${state.lobby.required}
      </p>

      <p id="msg" style="margin-top:10px; color:#b00;"></p>
    `;

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
    app.innerHTML = `<p>Wachten op game state...</p>`;
    return;
  }

  if (state.screen === "memory") return renderMemory();
  return renderGame();
}

function renderGame() {
  const g = state.game;

  const handHtml = (g.yourHand ?? []).map((c, i) => {
    // in review altijd zichtbaar, daarna zoals vroeger
    const shown = (g.phase === "review" || !g.handLocked) ? escapeHtml(c?.v ?? "") : "🂠";
    return `<button disabled style="width:54px;height:54px;">${shown}<br/><small>${i+1}</small></button>`;
  }).join(" ");

  // REVIEW UI
  if (g.phase === "review") {
    const endsAt = g.review?.endsAt ?? 0;
    const secsLeft = Math.max(0, Math.ceil((endsAt - state.now) / 1000));
    const yourReady = Boolean(g.review?.yourReady);
    const readyCount = g.review?.readyCount ?? 0;
    const total = g.review?.totalPlayers ?? g.players.length;

    app.innerHTML = `
      <h1>Spel</h1>
      <p><b>Room:</b> ${escapeHtml(state.roomCode)} — <b>Spelers:</b> ${g.players.length}</p>
      <p><b>Jij:</b> ${escapeHtml(state.name)}</p>

      <h3>Bekijk je kaarten</h3>
      <div style="display:flex; gap:8px; margin-bottom:10px;">${handHtml}</div>

      <p style="opacity:.7;">
        Iedereen moet bevestigen. Start automatisch over <b>${secsLeft}s</b>.
      </p>

      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
        <button id="ready" ${yourReady ? "disabled" : ""}>Ik heb mijn kaarten bekeken ✅</button>
        <span style="opacity:.7;">Klaar: ${readyCount} / ${total}</span>
      </div>

      <h3>Log</h3>
      <ul>
        ${(g.log ?? []).slice(-10).map(x => `<li>${escapeHtml(x)}</li>`).join("")}
      </ul>
    `;

    document.querySelector("#ready").onclick = () => socket.emit("review:ready");
    return;
  }

  // ------ vanaf hier: claim/resolve/drink (zoals ervoor) ------
  const targets = (g.players ?? []).filter(p => p !== state.name);
  const targetOptions = targets.map(p => `<option value="${escapeAttr(p)}">${escapeHtml(p)}</option>`).join("");

  const passEndsAt = g.round?.passEndsAt ?? 0;
  const secsLeft = Math.max(0, Math.ceil((passEndsAt - state.now) / 1000));

  const phase = g.phase; // claim | resolve | drink
  const decision = g.round?.yourDecision ?? null;

  const claimDisabled = phase !== "claim" || decision !== null || !g.current || targets.length === 0;

  const claimsHtml = (g.round?.claims ?? []).length === 0
    ? `<p style="opacity:.7;">Nog geen claims.</p>`
    : g.round.claims.map((c, idx) => {
        let actions = "";

        if (phase === "resolve" && c.status === "pending_belief" && c.target === state.name) {
          actions = `
            <div style="display:flex; gap:8px; margin-top:6px;">
              <button data-act="believe" data-i="${idx}">Geloof</button>
              <button data-act="doubt" data-i="${idx}">Niet geloven</button>
            </div>
          `;
        }

        if (phase === "resolve" && c.status === "awaiting_proof" && c.claimer === state.name) {
          const picks = new Set(c.proofPicks ?? []);
          const pickBtns = [0,1,2,3].map(i => {
            const mark = picks.has(i) ? "✅" : "🂠";
            return `<button data-act="pick" data-i="${idx}" data-card="${i}" style="width:54px;height:54px;">${mark}<br/><small>${i+1}</small></button>`;
          }).join(" ");

          actions = `
            <p style="margin:6px 0 4px 0;"><b>Toon ${c.mult} kaart(en)</b> (klik slots):</p>
            <div style="display:flex; gap:8px;">${pickBtns}</div>
          `;
        }

        const statusTxt =
          c.status === "pending_belief" ? "wacht op geloof/niet geloof" :
          c.status === "awaiting_proof" ? "bewijs nodig" :
          "afgehandeld";

        return `
          <div style="border:1px solid #ddd; border-radius:8px; padding:10px; margin:8px 0;">
            <div><b>${escapeHtml(c.claimer)}</b> zegt “ik heb ’m” (x${c.mult}) → nomineert <b>${escapeHtml(c.target)}</b></div>
            <div style="opacity:.7; margin-top:4px;">Status: ${statusTxt}</div>
            ${actions}
          </div>
        `;
      }).join("");

  const drinkTasks = g.round?.yourDrinkTasks ?? [];
  const mustAck = drinkTasks.length > 0;
  const yourAck = Boolean(g.round?.yourDrinkAck);

  const drinkHtml = (phase !== "drink")
    ? `<p style="opacity:.7;">Drinken komt pas na de afhandeling.</p>`
    : (
        mustAck
          ? `
            <ul>${drinkTasks.map(t => `<li><b>${escapeHtml(t)}</b></li>`).join("")}</ul>
            <button id="drinkAck" ${yourAck ? "disabled" : ""}>Gedronken ✅</button>
            <p style="opacity:.7; margin-top:6px;">Je moet bevestigen voor we verder gaan.</p>
          `
          : `<p><b>Geen drank voor jou deze ronde.</b> Wachten op anderen…</p>`
      );

  app.innerHTML = `
    <h1>Spel</h1>
    <p><b>Room:</b> ${escapeHtml(state.roomCode)} — <b>Spelers:</b> ${g.players.length}</p>
    <p><b>Jij:</b> ${escapeHtml(state.name)}</p>

    <h3>Hand</h3>
    <div style="display:flex; gap:8px; margin-bottom:6px;">${handHtml}</div>
    <p style="opacity:.7; margin-top:0;">
      ${g.handLocked ? "Hand ligt omgedraaid (geheugen!)" : "Nog zichtbaar, na eerste kaart gaat dit toe."}
    </p>

    <h3>Piramidekaart</h3>
    <p>
      ${
        g.current
          ? `<b>Kaart:</b> ${escapeHtml(g.current.value)} — <b>Rij:</b> ${g.current.row} — <b>Basis:</b> ${escapeHtml(g.current.base)}`
          : "Nog geen kaart omgedraaid."
      }
    </p>
    <p style="opacity:.7;">Omgedraaid: ${Math.max(0, g.revealedIndex + 1)} / ${g.pyramidTotal}</p>

    <hr/>

    <h3>Fase: ${escapeHtml(phase.toUpperCase())}</h3>

    <div style="border:1px solid #eee; padding:10px; border-radius:10px;">
      <h3>Claim</h3>

      ${
        phase === "claim"
          ? `<p style="opacity:.7;">Kies: “ik heb ’m” of “ik heb ’m niet”. Auto-pass over <b>${secsLeft}s</b>.</p>`
          : `<p style="opacity:.7;">Claimfase is voorbij.</p>`
      }

      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
        <button id="claimBtn" ${claimDisabled ? "disabled" : ""}>Ik heb ’m</button>
        <button id="passBtn" ${phase !== "claim" || decision !== null ? "disabled" : ""}>Ik heb ’m niet</button>

        <label>Multiplier:</label>
        <select id="mult" ${claimDisabled ? "disabled" : ""}>
          <option value="1">x1</option>
          <option value="2">x2</option>
          <option value="3">x3</option>
          <option value="4">x4</option>
        </select>

        <label>Nomineer:</label>
        <select id="target" ${claimDisabled ? "disabled" : ""}>
          ${targetOptions}
        </select>
      </div>

      <p style="margin-top:8px;">
        <b>Jouw keuze:</b> ${decision ? escapeHtml(decision) : "<i>nog niet gekozen</i>"}
      </p>
    </div>

    <h3>Claims</h3>
    ${claimsHtml}

    <h3>Drinken</h3>
    ${drinkHtml}

    <h3>Log</h3>
    <ul>
      ${(g.log ?? []).slice(-10).map(x => `<li>${escapeHtml(x)}</li>`).join("")}
    </ul>
  `;

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

  const submittedText = g.memory?.yourSubmitted ? "Ingediend." : "";
  const progress = `${g.memory?.submittedCount ?? 0} / ${g.memory?.totalPlayers ?? 0} ingediend`;

  const inputs = state.memoryGuesses.map((val, i) => `
    <div style="display:flex; gap:8px; align-items:center; margin:6px 0;">
      <b style="width:60px;">Slot ${i+1}</b>
      <input data-gi="${i}" value="${escapeAttr(val)}" placeholder="bv. 7 / K / A / 10" ${g.memory?.yourSubmitted ? "disabled" : ""} />
    </div>
  `).join("");

  app.innerHTML = `
    <h1>Eindtest</h1>
    <p><b>Room:</b> ${escapeHtml(state.roomCode)} — <b>Jij:</b> ${escapeHtml(state.name)}</p>

    <h3>Raad de waardes per slot</h3>
    ${inputs}

    <div style="display:flex; gap:8px; margin-top:10px;">
      <button id="submit" ${g.memory?.yourSubmitted ? "disabled" : ""}>Indienen</button>
      <span style="opacity:.7;">${submittedText}</span>
    </div>

    <p style="margin-top:10px; opacity:.7;">Voortgang: ${progress}</p>

    <h3>Log</h3>
    <ul>
      ${(g.log ?? []).slice(-12).map(x => `<li>${escapeHtml(x)}</li>`).join("")}
    </ul>
  `;

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

/* ---------------- socket events ---------------- */
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

/* ---------------- utils ---------------- */
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
