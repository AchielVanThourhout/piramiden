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
  now: Date.now(),
};

let ui = {
  sheetOpen: false,
  sheetTitle: "",
  sheetHtml: "",
};

const app = document.querySelector("#app");

function myName() {
  return (state.name ?? "").trim();
}

/* ---------- Overlay Sheet ---------- */
function openSheet(title, html) {
  ui.sheetOpen = true;
  ui.sheetTitle = title ?? "";
  ui.sheetHtml = html ?? "";
  render();
}
function closeSheet() {
  ui.sheetOpen = false;
  render();
}

/* ---------- Timers (no full re-render) ---------- */
setInterval(() => {
  state.now = Date.now();
  updateLiveTimers();
}, 250);

function updateLiveTimers() {
  const g = state.game;
  if (!g) return;

  const chip = document.querySelector("#timerChip");
  if (!chip) return;

  if (g.phase === "review") {
    const endsAt = g.review?.endsAt ?? 0;
    const secs = Math.max(0, Math.ceil((endsAt - state.now) / 1000));
    chip.textContent = `Start ${secs}s`;
  } else if (g.phase === "claim") {
    const endsAt = g.round?.passEndsAt ?? 0;
    const secs = Math.max(0, Math.ceil((endsAt - state.now) / 1000));
    chip.textContent = `Auto ${secs}s`;
  }
}

/* ---------- Shell ---------- */
function shell(title, rightHtml, mainHtml, bottomHtml = "") {
  const overlayHtml = `
    <div class="overlay ${ui.sheetOpen ? "open" : ""}" id="overlay">
      <div class="sheet" role="dialog" aria-modal="true">
        <div class="sheetHead">
          <div class="sheetTitle">${escapeHtml(ui.sheetTitle)}</div>
          <button class="iconBtn" id="closeSheet" aria-label="Sluit">✕</button>
        </div>
        <div class="sheetBody">${ui.sheetHtml}</div>
      </div>
    </div>
  `;

  app.innerHTML = `
    <div class="app">
      <header class="header">
        <div class="headerLeft">
          <div class="brandDot"></div>
          <div class="headerText">
            <div class="headerTitle">${escapeHtml(title)}</div>
            <div class="headerSub">${state.roomCode ? `Room ${escapeHtml(state.roomCode)}` : ""}</div>
          </div>
        </div>
        <div class="headerRight">${rightHtml ?? ""}</div>
      </header>

      <main class="main">
        ${mainHtml}
      </main>

      ${bottomHtml ? `<footer class="bottom">${bottomHtml}</footer>` : ""}
    </div>

    ${overlayHtml}
  `;

  const ov = document.querySelector("#overlay");
  if (ov) {
    ov.onclick = (e) => {
      if (e.target && e.target.id === "overlay") closeSheet();
    };
  }

  const cs = document.querySelector("#closeSheet");
  if (cs) cs.onclick = () => closeSheet();
}

/* ---------- Render Router ---------- */
function render() {
  if (state.screen === "home") return renderHome();
  if (state.screen === "lobby") return renderLobby();
  if (state.screen === "memory") return renderMemory();
  return renderGame();
}

/* ---------- HOME ---------- */
function renderHome() {
  shell(
    "Piramiden",
    `<span class="chip">online</span>`,
    `
      <section class="panel">
        <div class="titleBig">Piramiden</div>

        <div class="stack">
          <input class="input" id="name" placeholder="Jouw naam" value="${escapeAttr(state.name)}" />

          <div class="grid2">
            <button class="btn btnPrimary" id="create">Create</button>
            <input class="input" id="code" placeholder="Room code" />
          </div>

          <button class="btn" id="join">Join</button>
          <div id="msg" class="msg"></div>
        </div>
      </section>
    `
  );

  const nameInp = document.querySelector("#name");
  if (nameInp) nameInp.oninput = (e) => (state.name = e.target.value);

  // ✅ FIX: Create = NIET dubbel joinen
  const createBtn = document.querySelector("#create");
  if (createBtn) {
    createBtn.onclick = () => {
      const name = myName();
      if (!name) return showMsg("Vul je naam in.");

      socket.emit("room:create", { name }, (resCreate) => {
        if (!resCreate?.ok) return showMsg(resCreate?.error ?? "Create mislukt.");

        const code = String(resCreate.code || "").toUpperCase();
        if (!code) return showMsg("Create gaf geen room code terug.");

        // Normaal: server zet maker al in room + geeft status mee
        if (resCreate.status) {
          state.roomCode = code;
          applyLobbyStatus(resCreate.status);
          state.screen = "lobby";
          render();
          return;
        }

        // Fallback: enkel joinen als er geen status meegegeven is
        socket.emit("room:join", { code, name }, (resJoin) => {
          if (!resJoin?.ok) return showMsg(resJoin?.error ?? "Join na create mislukt.");

          state.roomCode = resJoin.code ?? code;
          applyLobbyStatus(resJoin.status);
          state.screen = "lobby";
          render();
        });
      });
    };
  }

  const joinBtn = document.querySelector("#join");
  if (joinBtn) {
    joinBtn.onclick = () => {
      const code = document.querySelector("#code").value.trim().toUpperCase();
      const name = myName();
      if (!name) return showMsg("Vul je naam in.");
      if (!code) return showMsg("Geef een room code in.");

      socket.emit("room:join", { code, name }, (res) => {
        if (!res?.ok) return showMsg(res?.error ?? "Join mislukt.");
        state.roomCode = res.code;
        applyLobbyStatus(res.status);
        state.screen = "lobby";
        render();
      });
    };
  }
}

/* ---------- LOBBY ---------- */
function renderLobby() {
  const players = state.lobby.players ?? [];
  const readyTxt = `${state.lobby.votes} / ${state.lobby.required}`;

  shell(
    "Lobby",
    `
      <button class="iconBtn" id="playersBtn" aria-label="Spelers">👥</button>
      <span class="chip">Ready ${escapeHtml(readyTxt)}</span>
    `,
    `
      <section class="panel">
        <div class="rowBetween">
          <div class="titleBig">Lobby</div>
          <div class="smallMuted">${escapeHtml(myName())}</div>
        </div>

        <div class="miniGrid">
          <div class="miniCard">
            <div class="miniLabel">Spelers</div>
            <div class="miniValue">${players.length}</div>
          </div>
          <div class="miniCard">
            <div class="miniLabel">Ready</div>
            <div class="miniValue">${escapeHtml(readyTxt)}</div>
          </div>
        </div>

        <div id="msg" class="msg"></div>
      </section>
    `,
    `
      <button class="btn btnPrimary" id="readyBtn" ${players.length < 2 ? "disabled" : ""}>
        ${state.lobby.youVoted ? "Ready ✅" : "Ready"}
      </button>
      <button class="btn" id="backBtn">Terug</button>
    `
  );

  const readyBtn = document.querySelector("#readyBtn");
  if (readyBtn) readyBtn.onclick = () => socket.emit("start:vote");

  const backBtn = document.querySelector("#backBtn");
  if (backBtn)
    backBtn.onclick = () => {
      state.screen = "home";
      state.roomCode = "";
      state.lobby = { host: "", players: [], votes: 0, required: 0, youVoted: false };
      state.game = null;
      state.memoryGuesses = ["", "", "", ""];
      render();
    };

  const playersBtn = document.querySelector("#playersBtn");
  if (playersBtn)
    playersBtn.onclick = () => {
      openSheet(
        "Spelers",
        `
          <ul class="list">
            ${players
              .map(
                (p) => `
              <li class="listItem">
                <span>${escapeHtml(p)}</span>
                ${p === state.lobby.host ? `<span class="chip">maker</span>` : ``}
              </li>
            `
              )
              .join("")}
          </ul>
        `
      );
    };
}

/* ---------- GAME ---------- */
function renderGame() {
  const g = state.game;
  if (!g) {
    shell("Spel", "", `<section class="panel"><div class="smallMuted">Wachten op game state…</div></section>`);
    return;
  }

  const phase = g.phase ?? "";
  const phaseLabel =
    phase === "review"
      ? "Review"
      : phase === "claim"
      ? "Claim"
      : phase === "resolve"
      ? "Resolve"
      : phase === "drink"
      ? "Drink"
      : phase === "memory"
      ? "Memory"
      : phase;

  let timerChip = "";
  if (phase === "review") timerChip = `<span class="chip" id="timerChip">Start</span>`;
  if (phase === "claim") timerChip = `<span class="chip" id="timerChip">Auto</span>`;

  const cardValue = g.current?.value ? escapeHtml(g.current.value) : "—";
  const row = g.current?.row ?? "";
  const prog = `${Math.max(0, (g.revealedIndex ?? -1) + 1)} / ${g.pyramidTotal ?? "?"}`;

  const handLocked = Boolean(g.handLocked);
  const yourHand = g.yourHand ?? [];
  const handHtml = yourHand
    .map((c, i) => {
      const shown = phase === "review" || !handLocked ? escapeHtml(c?.v ?? "") : "🂠";
      return `<button class="cardBtn" disabled>${shown}<small>${i + 1}</small></button>`;
    })
    .join("");

  const actionsHtml = buildMustDoActions(g);
  const bottomHtml = buildBottomBar(g);

  // ✅ Piramide "los" en lager (tussen content en bottom bar)
  const pyramidHtml = `<div class="pyramidMini">${buildPyramidMini(g)}</div>`;

  shell(
    "Spel",
    `
      <button class="iconBtn" id="detailsBtn" aria-label="Details">⋯</button>
      <span class="chip">${escapeHtml(phaseLabel)}</span>
      ${timerChip}
    `,
    `
  <div class="gameLayout">
    <section class="panel tight">
      <div class="bigRow">
        <div class="bigCard">
          <div class="bigLabel">Kaart</div>
          <div class="bigValue">${cardValue}</div>
        </div>

        <div class="bigCard">
          <div class="bigLabel">Rij</div>
          <div class="bigValue">${escapeHtml(row)}</div>
        </div>

        <div class="bigCard">
          <div class="bigLabel">Progress</div>
          <div class="bigValue" style="font-size:18px;">${escapeHtml(prog)}</div>
        </div>
      </div>

      <div class="handWrap">${handHtml}</div>
    </section>

    <div class="pyramidMini">
      ${buildPyramidMini(g)}
    </div>

    ${actionsHtml}
  </div>
`
,
    bottomHtml
  );

  const detailsBtn = document.querySelector("#detailsBtn");
  if (detailsBtn) detailsBtn.onclick = () => openSheet("Details", buildDetailsSheet(g));

  wireMustDoActions(g);
  wireBottomActions(g);
}

/* --- Must-do block --- */
function buildMustDoActions(g) {
  const phase = g.phase;
  const round = g.round ?? {};
  const me = myName();

  if (phase === "review") return "";

  if (phase === "drink") {
    const tasks = round.yourDrinkTasks ?? [];
    const youAck = Boolean(round.yourDrinkAck);

    if (tasks.length === 0) {
      return `<section class="panel tight"><div class="smallMuted">Wachten…</div></section>`;
    }

    return `
      <section class="panel tight">
        <div class="rowBetween">
          <div class="titleMid">Drink</div>
          <span class="chip">${tasks.length}</span>
        </div>
        <div class="smallMuted">${tasks.map((t) => escapeHtml(t)).join(" · ")}</div>
        <div class="spacer8"></div>
        <button class="btn btnGreen" id="drinkAckBtn" ${youAck ? "disabled" : ""}>Gedronken ✅</button>
      </section>
    `;
  }

  if (phase === "resolve") {
    const claims = round.claims ?? [];
    let htmlParts = [];

    claims.forEach((c, idx) => {
      if (c.status === "pending_belief" && c.target === me) {
        htmlParts.push(`
          <section class="panel tight">
            <div class="titleMid">Geloof?</div>
            <div class="smallMuted">${escapeHtml(c.claimer)} → x${escapeHtml(c.mult)} op jou</div>
            <div class="btnRow">
              <button class="btn btnGreen" data-act="believe" data-idx="${idx}">Geloof</button>
              <button class="btn btnDanger" data-act="doubt" data-idx="${idx}">Niet</button>
            </div>
          </section>
        `);
      }

      if (c.status === "awaiting_proof" && c.claimer === me) {
        const picks = new Set(c.proofPicks ?? []);
        const pickBtns = [0, 1, 2, 3]
          .map((i) => {
            const mark = picks.has(i) ? "✅" : "🂠";
            return `<button class="cardBtn" data-act="pick" data-idx="${idx}" data-card="${i}">${mark}<small>${i + 1}</small></button>`;
          })
          .join("");

        htmlParts.push(`
          <section class="panel tight">
            <div class="titleMid">Toon kaart(en)</div>
            <div class="smallMuted">Kies ${escapeHtml(c.mult)} slot(s)</div>
            <div class="handWrap">${pickBtns}</div>
          </section>
        `);
      }
    });

    return htmlParts.join("");
  }

  return "";
}

function wireMustDoActions(g) {
  const phase = g.phase;

  if (phase === "drink") {
    const btn = document.querySelector("#drinkAckBtn");
    if (btn) btn.onclick = () => socket.emit("drink:ack");
  }

  app.querySelectorAll("[data-act]").forEach((el) => {
    el.onclick = () => {
      const act = el.dataset.act;
      const idx = parseInt(el.dataset.idx, 10);

      if (act === "believe") socket.emit("game:believe", { claimIndex: idx, believe: true });
      if (act === "doubt") socket.emit("game:believe", { claimIndex: idx, believe: false });

      if (act === "pick") {
        const cardIndex = parseInt(el.dataset.card, 10);
        socket.emit("game:proofPick", { claimIndex: idx, cardIndex });
      }
    };
  });
}

/* --- Bottom bar --- */
function buildBottomBar(g) {
  const phase = g.phase;
  const round = g.round ?? {};
  const me = myName();

  if (phase === "review") {
    const yourReady = Boolean(g.review?.yourReady);
    return `
      <button class="btn btnGreen" id="reviewReadyBtn" ${yourReady ? "disabled" : ""}>Klaar ✅</button>
      <button class="btn" id="detailsBottomBtn">Details</button>
    `;
  }

  if (phase === "claim") {
    const players = (g.players ?? []).filter((p) => p !== me);
    const decision = round.yourDecision ?? null;
    const disabled = decision !== null || !g.current || players.length === 0;

    const targetOptions = players.map((p) => `<option value="${escapeAttr(p)}">${escapeHtml(p)}</option>`).join("");

    return `
      <select class="selectSmall" id="mult" ${disabled ? "disabled" : ""}>
        <option value="1">x1</option>
        <option value="2">x2</option>
        <option value="3">x3</option>
        <option value="4">x4</option>
      </select>

      <select class="selectSmall" id="target" ${disabled ? "disabled" : ""}>
        ${targetOptions}
      </select>

      <button class="btn btnPrimary" id="claimBtn" ${disabled ? "disabled" : ""}>Ik heb ’m</button>
      <button class="btn" id="passBtn" ${decision !== null ? "disabled" : ""}>Niet</button>
    `;
  }

  if (phase === "resolve") {
    return `
      <button class="btn" id="detailsBottomBtn">Details</button>
      <button class="btn" id="noopBtn" disabled>Bezig…</button>
    `;
  }

  if (phase === "drink") {
    return `
      <button class="btn" id="detailsBottomBtn">Details</button>
      <button class="btn" id="noopBtn" disabled>Wachten…</button>
    `;
  }

  return `<button class="btn" id="detailsBottomBtn">Details</button>`;
}

function wireBottomActions(g) {
  const phase = g.phase;

  const detailsBottom = document.querySelector("#detailsBottomBtn");
  if (detailsBottom) detailsBottom.onclick = () => openSheet("Details", buildDetailsSheet(g));

  if (phase === "review") {
    const btn = document.querySelector("#reviewReadyBtn");
    if (btn) btn.onclick = () => socket.emit("review:ready");
  }

  if (phase === "claim") {
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
  }
}

/* --- Details Sheet --- */
function buildDetailsSheet(g) {
  const round = g.round ?? {};
  const me = myName();

  const players = g.players ?? [];
  const claims = round.claims ?? [];

  const playersHtml = `
    <div class="sheetSection">
      <div class="sheetSectionTitle">Spelers</div>
      <ul class="list">
        ${players
          .map(
            (p) => `
          <li class="listItem">
            <span>${escapeHtml(p)}${p === me ? " (jij)" : ""}</span>
          </li>
        `
          )
          .join("")}
      </ul>
    </div>
  `;

  const claimsHtml = `
    <div class="sheetSection">
      <div class="sheetSectionTitle">Claims</div>
      ${
        claims.length === 0
          ? `<div class="smallMuted">Geen.</div>`
          : `
        <ul class="list">
          ${claims
            .map((c) => {
              const status =
                c.status === "pending_belief" ? "geloof?" : c.status === "awaiting_proof" ? "bewijs" : "ok";

              return `
                <li class="listItem">
                  <span>${escapeHtml(c.claimer)} → ${escapeHtml(c.target)} (x${escapeHtml(c.mult)})</span>
                  <span class="chip">${escapeHtml(status)}</span>
                </li>
              `;
            })
            .join("")}
        </ul>
      `
      }
    </div>
  `;

  const infoHtml = `
    <div class="sheetSection">
      <div class="sheetSectionTitle">Piramide</div>
      <div class="smallMuted">
        Omgedraaid: <b>${escapeHtml(String(Math.max(0, (g.revealedIndex ?? -1) + 1)))}</b> / ${escapeHtml(
    String(g.pyramidTotal ?? "?")
  )}
        ${g.current?.row ? ` · Rij <b>${escapeHtml(String(g.current.row))}</b>` : ""}
      </div>
    </div>
  `;

  return `${playersHtml}${claimsHtml}${infoHtml}`;
}

/* ---------- Piramide Mini (correcte richting + groen) ---------- */
function getPyramidValueAt(g, i) {
  // We proberen een paar mogelijke velden die je server kan meesturen.
  const pools = [
    g.pyramidValues,
    g.revealedValues,
    g.revealedCards,
    g.pyramidCards,
    g.pyramid,
    g.revealed,
  ];

  for (const arr of pools) {
    if (!Array.isArray(arr)) continue;
    const item = arr[i];
    if (item == null) continue;

    if (typeof item === "string" || typeof item === "number") return String(item);

    if (typeof item === "object") {
      const v =
        item.value ??
        item.v ??
        item.card?.value ??
        item.card?.v ??
        item.val ??
        item.number;
      if (v != null) return String(v);
    }
  }

  return "";
}

function buildPyramidMini(g) {
  const total = Number(g.pyramidTotal ?? 0);
  if (!total) return `<div class="pyramidWrap"></div>`;

  // aantal rijen bepalen (driehoeksgetal)
  let rows = Math.floor((Math.sqrt(8 * total + 1) - 1) / 2);
  if ((rows * (rows + 1)) / 2 !== total) {
    rows = 1;
    let sum = 0;
    while (sum + (rows + 1) <= total) {
      rows++;
      sum = (rows * (rows + 1)) / 2;
    }
  }

  // mapping: index 0 = links onderaan, dan links->rechts, rij per rij naar boven
  // we renderen VISUEEL top->bottom (punt omhoog), maar indices blijven bottom-up correct.
  const blocks = {};
  let run = 0;
  for (let len = rows; len >= 1; len--) {
    blocks[len] = { start: run, end: run + len - 1 };
    run += len;
  }

  const currentIndex = Number(g.revealedIndex ?? -1);
  const currentValRaw = g.current?.value ?? "";
  const currentVal = currentValRaw !== "" ? escapeHtml(String(currentValRaw)) : "";

  let html = `<div class="pyramidWrap">`;

  for (let r = 1; r <= rows; r++) {
    const b = blocks[r];
    html += `<div class="pRow">`;

    for (let idx = b.start; idx <= b.end && idx < total; idx++) {
      const isRevealed = idx < currentIndex;
      const isCurrent = idx === currentIndex;

      let val = "";
      if (isCurrent) {
        val = currentVal;
      } else if (isRevealed) {
        const found = getPyramidValueAt(g, idx);
        val = found ? escapeHtml(found) : "";
      }

      const cls = `pCell${isRevealed ? " revealed" : ""}${isCurrent ? " current" : ""}`;

      // Onomgedraaid = leeg, Omgedraaid = waarde (als beschikbaar)
      const content = val ? val : "&nbsp;";

      html += `<div class="${cls}" aria-label="piramide ${idx + 1}">${content}</div>`;
    }

    html += `</div>`;
  }

  html += `</div>`;
  return html;
}


/* ---------- MEMORY ---------- */
function renderMemory() {
  const g = state.game ?? {};
  const yourSubmitted = Boolean(g.memory?.yourSubmitted);
  const submittedCount = g.memory?.submittedCount ?? 0;
  const total = g.memory?.totalPlayers ?? 0;

  shell(
    "Eindtest",
    `<span class="chip">${escapeHtml(String(submittedCount))}/${escapeHtml(String(total))}</span>`,
    `
      <section class="panel">
        <div class="titleBig">Eindtest</div>

        <div class="grid2">
          ${state.memoryGuesses
            .map(
              (val, i) => `
            <input class="input" data-gi="${i}" value="${escapeAttr(val)}" placeholder="Slot ${i + 1}" ${
                yourSubmitted ? "disabled" : ""
              } />
          `
            )
            .join("")}
        </div>

        <div class="spacer8"></div>
        <button class="btn btnPrimary" id="submitMem" ${yourSubmitted ? "disabled" : ""}>Indienen</button>
      </section>
    `,
    `<button class="btn" id="detailsBottomBtn">Details</button>`
  );

  app.querySelectorAll("input[data-gi]").forEach((inp) => {
    inp.oninput = () => {
      const i = parseInt(inp.dataset.gi, 10);
      state.memoryGuesses[i] = inp.value;
    };
  });

  const submit = document.querySelector("#submitMem");
  if (submit) submit.onclick = () => socket.emit("memory:submit", { guesses: state.memoryGuesses });

  const det = document.querySelector("#detailsBottomBtn");
  if (det) det.onclick = () => openSheet("Info", `<div class="smallMuted">Wachten op de rest…</div>`);
}

/* ---------- Socket events ---------- */
function applyLobbyStatus(status) {
  if (!status) return;
  state.lobby.host = status.host;
  state.lobby.players = status.players;
  state.lobby.votes = status.votes;
  state.lobby.required = status.required;
  state.lobby.youVoted = (status.voters ?? []).includes(myName());
}

// ✅ lobby realtime update + host ziet joiners
socket.on("room:status", (status) => {
  applyLobbyStatus(status);
  if (state.screen === "lobby") render();
});

socket.on("game:state", (gameState) => {
  state.game = gameState;

  if (gameState.phase === "memory" && state.screen !== "memory") {
    state.memoryGuesses = ["", "", "", ""];
  }

  state.screen = gameState.phase === "memory" ? "memory" : "game";
  render();
});

/* ---------- Utils ---------- */
function showMsg(text) {
  const el = document.querySelector("#msg");
  if (el) el.textContent = text;
}

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
