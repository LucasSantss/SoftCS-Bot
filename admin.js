async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ─── Abas ───────────────────────────────────────────────────────────────────
const navItems = document.querySelectorAll(".nav-item");
const tabPanels = document.querySelectorAll(".tab-panel");
const topbarTitle = document.getElementById("topbarTitle");
const topbarSub = document.getElementById("topbarSub");

const TAB_META = {
  agents: { title: "Agentes", sub: "Mapeamento entre usuário SoftCS e @username no Telegram" },
  chats: { title: "Chats do Telegram", sub: "Grupos e canais que recebem a notificação de cada ticket" },
};

navItems.forEach((item) => {
  item.addEventListener("click", () => {
    const tab = item.dataset.tab;
    navItems.forEach((el) => el.classList.toggle("active", el === item));
    tabPanels.forEach((panel) => panel.classList.toggle("active", panel.id === `tab-${tab}`));
    topbarTitle.textContent = TAB_META[tab].title;
    topbarSub.textContent = TAB_META[tab].sub;
  });
});

function setStatus(el, message, isError) {
  el.textContent = message;
  el.className = "status-line " + (isError ? "error" : "ok");
}

// ─── Agentes ────────────────────────────────────────────────────────────────
const agentForm = document.getElementById("agentForm");
const agentStatus = document.getElementById("agentStatus");
const agentList = document.getElementById("agentList");
const agentEmpty = document.getElementById("agentEmpty");

let knownAgentIds = new Set();

async function loadAgents() {
  try {
    const agents = await api("/api/agents");
    knownAgentIds = new Set(agents.map((a) => a.softcs_user_id));
    agentList.innerHTML = "";
    agentEmpty.style.display = agents.length ? "none" : "block";
    for (const agent of agents) renderAgentRow(agent);
  } catch (err) {
    setStatus(agentStatus, err.message, true);
  }
}

function renderAgentRow(agent) {
  const row = document.createElement("div");
  row.className = "list-item";
  row.innerHTML = `
    <div class="list-item-main">
      <span class="list-item-title"></span>
      <span class="list-item-sub"></span>
    </div>
    <div class="list-item-actions">
      <button class="icon-btn danger-hover" title="Remover">🗑</button>
    </div>
  `;
  row.querySelector(".list-item-title").textContent = `${agent.display_name || "(sem nome)"} · @${agent.telegram_username}`;
  row.querySelector(".list-item-sub").textContent = agent.softcs_user_id;
  row.querySelector("button").addEventListener("click", async () => {
    if (!confirm(`Remover "${agent.display_name || agent.softcs_user_id}"?`)) return;
    try {
      await api(`/api/agents?softcs_user_id=${encodeURIComponent(agent.softcs_user_id)}`, { method: "DELETE" });
      await loadAgents();
      setStatus(agentStatus, "Removido.", false);
    } catch (err) {
      setStatus(agentStatus, err.message, true);
    }
  });
  agentList.appendChild(row);
}

agentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(agentForm));
  try {
    await api("/api/agents", { method: "POST", body: JSON.stringify(data) });
    agentForm.reset();
    setStatus(agentStatus, "Adicionado.", false);
    await loadAgents();
  } catch (err) {
    setStatus(agentStatus, err.message, true);
  }
});

// ─── Buscar da SoftCS ───────────────────────────────────────────────────────
const connectionForm = document.getElementById("connectBox");
const saveConnectionBtn = document.getElementById("saveConnectionBtn");
const connectBtn = document.getElementById("connectBtn");
const connectionStatus = document.getElementById("connectionStatus");
const discoverBtn = document.getElementById("discoverBtn");
const discoverStatus = document.getElementById("discoverStatus");
const discoverList = document.getElementById("discoverList");

function connectionField(name) {
  return connectionForm.querySelector(`[name="${name}"]`);
}

async function loadConnection() {
  try {
    const data = await api("/api/settings");
    connectionField("softcs_client_id").value = data.softcs_client_id;
    connectionField("softcs_client_secret").value = data.softcs_client_secret;
    connectionField("softcs_redirect_uri").value = data.softcs_redirect_uri;
    connectionStatus.textContent = data.oauth_connected ? "conectado" : "não conectado";
    connectionStatus.className = "badge " + (data.oauth_connected ? "on" : "off");
  } catch (err) {
    setStatus(discoverStatus, err.message, true);
  }
}

saveConnectionBtn.addEventListener("click", async () => {
  const data = {
    softcs_client_id: connectionField("softcs_client_id").value.trim(),
    softcs_client_secret: connectionField("softcs_client_secret").value.trim(),
    softcs_redirect_uri: connectionField("softcs_redirect_uri").value.trim(),
  };
  try {
    await api("/api/settings", { method: "POST", body: JSON.stringify(data) });
    setStatus(discoverStatus, "Configurações salvas.", false);
  } catch (err) {
    setStatus(discoverStatus, err.message, true);
  }
});

connectBtn.addEventListener("click", () => {
  window.location.href = "/api/oauth-start";
});

function renderTicketRow(ticket) {
  const creator = ticket.createdBy;
  const row = document.createElement("div");
  row.className = "list-item";
  row.innerHTML = `
    <div class="list-item-main">
      <span class="list-item-title"></span>
      <span class="list-item-sub"></span>
    </div>
    <div class="list-item-actions"></div>
  `;
  row.querySelector(".list-item-title").textContent = ticket.title;
  row.querySelector(".list-item-sub").textContent = [
    ticket.clientName,
    ticket.priority,
    creator ? `criado por ${creator.name || creator.id}` : "criador desconhecido",
  ]
    .filter(Boolean)
    .join(" · ");

  const actions = row.querySelector(".list-item-actions");

  if (creator && knownAgentIds.has(creator.id)) {
    const badge = document.createElement("span");
    badge.className = "badge on";
    badge.textContent = "já mapeado";
    actions.appendChild(badge);
  } else if (creator) {
    const usernameInput = document.createElement("input");
    usernameInput.type = "text";
    usernameInput.placeholder = "@username";
    usernameInput.style.width = "140px";

    const saveBtn = document.createElement("button");
    saveBtn.className = "btn btn-primary";
    saveBtn.textContent = "Salvar";
    saveBtn.addEventListener("click", async () => {
      const telegram_username = usernameInput.value.trim();
      if (!telegram_username) {
        usernameInput.focus();
        return;
      }
      try {
        await api("/api/agents", {
          method: "POST",
          body: JSON.stringify({ softcs_user_id: creator.id, telegram_username, display_name: creator.name }),
        });
        await loadAgents();
        setStatus(discoverStatus, `${creator.name || creator.id} adicionado.`, false);
        renderTickets(lastTickets);
      } catch (err) {
        setStatus(discoverStatus, err.message, true);
      }
    });

    actions.append(usernameInput, saveBtn);
  }

  discoverList.appendChild(row);
}

let lastTickets = [];

function renderTickets(tickets) {
  discoverList.innerHTML = "";
  for (const ticket of tickets) renderTicketRow(ticket);
}

discoverBtn.addEventListener("click", async () => {
  discoverList.innerHTML = "";
  setStatus(discoverStatus, "Buscando tickets na SoftCS…", false);
  try {
    const data = await api("/api/discover-tickets");
    lastTickets = data.tickets;

    if (data.tickets.length === 0) {
      setStatus(discoverStatus, `Nenhum ticket encontrado (${data.clientsScanned} clientes verificados).`, true);
      return;
    }
    if (!data.hasNames) {
      setStatus(
        discoverStatus,
        `${data.tickets.length} ticket(s) encontrado(s), mas a API não retornou nome/e-mail do criador — só o ID.`,
        true
      );
    } else {
      setStatus(discoverStatus, `${data.tickets.length} ticket(s) encontrado(s).`, false);
    }
    renderTickets(data.tickets);
  } catch (err) {
    setStatus(discoverStatus, err.message, true);
  }
});

// ─── Chats ──────────────────────────────────────────────────────────────────
const chatForm = document.getElementById("chatForm");
const chatStatus = document.getElementById("chatStatus");
const chatList = document.getElementById("chatList");
const chatEmpty = document.getElementById("chatEmpty");

async function loadChats() {
  try {
    const chats = await api("/api/chats");
    chatList.innerHTML = "";
    chatEmpty.style.display = chats.length ? "none" : "block";
    for (const chat of chats) renderChatRow(chat);
  } catch (err) {
    setStatus(chatStatus, err.message, true);
  }
}

function renderChatRow(chat) {
  const row = document.createElement("div");
  row.className = "list-item";
  row.innerHTML = `
    <div class="list-item-main">
      <span class="list-item-title"></span>
      <span class="list-item-sub"></span>
    </div>
    <div class="list-item-actions">
      <label class="switch">
        <input type="checkbox" />
        <span class="switch-track"></span>
      </label>
      <button class="icon-btn" title="Remover">🗑</button>
    </div>
  `;
  row.querySelector(".list-item-title").textContent = chat.label || "(sem rótulo)";
  row.querySelector(".list-item-sub").textContent = chat.chat_id;

  const toggle = row.querySelector('input[type="checkbox"]');
  toggle.checked = chat.active;
  toggle.addEventListener("change", async () => {
    try {
      await api("/api/chats", {
        method: "PATCH",
        body: JSON.stringify({ chat_id: chat.chat_id, active: toggle.checked }),
      });
      setStatus(chatStatus, "Atualizado.", false);
    } catch (err) {
      setStatus(chatStatus, err.message, true);
      toggle.checked = !toggle.checked;
    }
  });

  row.querySelector(".icon-btn").addEventListener("click", async () => {
    if (!confirm(`Remover "${chat.label || chat.chat_id}"?`)) return;
    try {
      await api(`/api/chats?chat_id=${encodeURIComponent(chat.chat_id)}`, { method: "DELETE" });
      await loadChats();
      setStatus(chatStatus, "Removido.", false);
    } catch (err) {
      setStatus(chatStatus, err.message, true);
    }
  });

  chatList.appendChild(row);
}

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(chatForm));
  try {
    await api("/api/chats", { method: "POST", body: JSON.stringify(data) });
    chatForm.reset();
    setStatus(chatStatus, "Adicionado.", false);
    await loadChats();
  } catch (err) {
    setStatus(chatStatus, err.message, true);
  }
});

function boot() {
  loadAgents();
  loadChats();
  loadConnection();
}

boot();
