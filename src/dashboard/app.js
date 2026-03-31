// ── Mission Control Dashboard ─────────────────────────────────────────────────
// Plain JavaScript — no build step, no framework.
// All dynamic content is escaped via escapeHtml/escapeAttr before DOM insertion.

(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────────

  var state = {
    agents: [],
    missions: [],
    events: [],
    connected: false,
    selectedAgentId: null,
    activePanel: 0,       // 0=agents, 1=missions, 2=timeline
    focusedRow: [0, 0, 0], // per-panel focused row index
  };

  var ws = null;
  var reconnectTimer = null;
  var RECONNECT_DELAY = 2000;
  var eventCount = 0;

  // Agent color palette (assigned by order of appearance)
  var AGENT_COLORS = [
    '#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff',
    '#79c0ff', '#56d364', '#e3b341', '#ff7b72', '#d2a8ff',
  ];
  var agentColorMap = {};
  var nextColorIndex = 0;

  function getAgentColor(agentId) {
    if (!agentColorMap[agentId]) {
      agentColorMap[agentId] = AGENT_COLORS[nextColorIndex % AGENT_COLORS.length];
      nextColorIndex++;
    }
    return agentColorMap[agentId];
  }

  // ── DOM references ────────────────────────────────────────────────────────

  var $agentCount = document.getElementById('agent-count');
  var $missionCount = document.getElementById('mission-count');
  var $eventCount = document.getElementById('event-count');
  var $connectionStatus = document.getElementById('connection-status');
  var $agentsList = document.getElementById('agents-list');
  var $agentsBadge = document.getElementById('agents-badge');
  var $missionsList = document.getElementById('missions-list');
  var $missionsBadge = document.getElementById('missions-badge');
  var $timelineList = document.getElementById('timeline-list');
  var $timelineBadge = document.getElementById('timeline-badge');
  var $missionModal = document.getElementById('mission-modal');
  var $missionForm = document.getElementById('mission-form');
  var $missionTitle = document.getElementById('mission-title');
  var $missionDesc = document.getElementById('mission-desc');
  var $cancelMission = document.getElementById('cancel-mission');
  var $newMissionBtn = document.getElementById('new-mission-btn');
  var $commandBar = document.getElementById('command-bar');
  var $commandInput = document.getElementById('command-input');
  var $commandTarget = document.getElementById('command-target');

  var panels = [
    document.getElementById('agents-panel'),
    document.getElementById('missions-panel'),
    document.getElementById('timeline-panel'),
  ];

  // ── Utilities ─────────────────────────────────────────────────────────────

  function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatTime(ts) {
    if (!ts) return '--:--';
    var d = new Date(ts);
    var h = String(d.getHours()).padStart(2, '0');
    var m = String(d.getMinutes()).padStart(2, '0');
    var s = String(d.getSeconds()).padStart(2, '0');
    return h + ':' + m + ':' + s;
  }

  function timeAgo(ts) {
    if (!ts) return '';
    var diff = Date.now() - new Date(ts).getTime();
    if (diff < 0) diff = 0;
    var seconds = Math.floor(diff / 1000);
    if (seconds < 60) return seconds + 's ago';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    var hours = Math.floor(minutes / 60);
    return hours + 'h ago';
  }

  // ── Safe DOM helpers ──────────────────────────────────────────────────────
  // These build DOM nodes directly instead of using innerHTML with strings.

  function createEl(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (key === 'className') {
          el.className = attrs[key];
        } else if (key === 'textContent') {
          el.textContent = attrs[key];
        } else if (key.indexOf('data-') === 0) {
          el.setAttribute(key, attrs[key]);
        } else if (key === 'style') {
          el.setAttribute('style', attrs[key]);
        } else {
          el[key] = attrs[key];
        }
      });
    }
    if (children) {
      children.forEach(function (child) {
        if (child) el.appendChild(child);
      });
    }
    return el;
  }

  function clearElement(el) {
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────

  function connectWebSocket() {
    var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var url = protocol + '//' + location.host;

    ws = new WebSocket(url);

    ws.onopen = function () {
      state.connected = true;
      renderConnectionStatus();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    ws.onclose = function () {
      state.connected = false;
      renderConnectionStatus();
      scheduleReconnect();
    };

    ws.onerror = function () {
      // onclose will fire after this
    };

    ws.onmessage = function (evt) {
      var msg;
      try {
        msg = JSON.parse(evt.data);
      } catch (e) {
        return;
      }
      handleMessage(msg);
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connectWebSocket();
    }, RECONNECT_DELAY);
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'agents':
        state.agents = msg.data || [];
        renderAgents();
        break;
      case 'events':
        // Bulk load (initial)
        state.events = msg.data || [];
        eventCount = state.events.length;
        renderTimeline();
        break;
      case 'event':
        // Single new event
        state.events.push(msg.data);
        eventCount++;
        renderTimelineAppend(msg.data);
        break;
      case 'agent_update':
        upsertAgent(msg.data);
        renderAgents();
        break;
      case 'mission_update':
        upsertMission(msg.data);
        renderMissions();
        break;
      case 'missions':
        state.missions = msg.data || [];
        renderMissions();
        break;
      default:
        break;
    }
    updateHeaderStats();
  }

  function upsertAgent(agent) {
    var idx = state.agents.findIndex(function (a) { return a.id === agent.id; });
    if (idx >= 0) {
      state.agents[idx] = agent;
    } else {
      state.agents.push(agent);
    }
  }

  function upsertMission(mission) {
    var idx = state.missions.findIndex(function (m) { return m.id === mission.id; });
    if (idx >= 0) {
      state.missions[idx] = mission;
    } else {
      state.missions.push(mission);
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function renderConnectionStatus() {
    if (state.connected) {
      $connectionStatus.className = 'status-indicator connected';
      $connectionStatus.querySelector('.status-text').textContent = 'CONNECTED';
    } else {
      $connectionStatus.className = 'status-indicator disconnected';
      $connectionStatus.querySelector('.status-text').textContent = 'DISCONNECTED';
    }
  }

  function updateHeaderStats() {
    $agentCount.textContent = state.agents.length;
    $missionCount.textContent = state.missions.length;
    $eventCount.textContent = eventCount;
  }

  function renderAgents() {
    $agentsBadge.textContent = state.agents.length;
    clearElement($agentsList);

    if (state.agents.length === 0) {
      $agentsList.appendChild(
        createEl('div', { className: 'empty-state', textContent: 'No agents connected' })
      );
      return;
    }

    state.agents.forEach(function (agent, i) {
      var statusClass = agent.status || 'active';
      var timeSince = timeAgo(agent.last_seen_at);
      var focused = (state.activePanel === 0 && state.focusedRow[0] === i);
      var selected = (state.selectedAgentId === agent.id);
      var name = agent.name || agent.agent_id || agent.id;

      var rowClass = 'list-row' + (focused ? ' focused' : '') + (selected ? ' selected' : '');

      var dot = createEl('span', { className: 'agent-status-dot ' + statusClass });
      var nameEl = createEl('span', { className: 'agent-name', textContent: name });
      var metaEl = createEl('span', { className: 'agent-meta', textContent: timeSince });
      var agentRow = createEl('div', { className: 'agent-row' }, [dot, nameEl, metaEl]);

      var children = [agentRow];
      if (agent.current_tool) {
        children.push(
          createEl('div', { className: 'agent-activity', textContent: agent.current_tool })
        );
      }

      var row = createEl('div', { className: rowClass, 'data-agent-id': agent.id }, children);
      $agentsList.appendChild(row);
    });
  }

  function renderMissions() {
    $missionsBadge.textContent = state.missions.length;
    clearElement($missionsList);

    if (state.missions.length === 0) {
      $missionsList.appendChild(
        createEl('div', { className: 'empty-state', textContent: 'No missions' })
      );
      return;
    }

    state.missions.forEach(function (mission, i) {
      var status = mission.status || 'queued';
      var focused = (state.activePanel === 1 && state.focusedRow[1] === i);
      var rowClass = 'list-row' + (focused ? ' focused' : '');

      var titleEl = createEl('span', { className: 'mission-title', textContent: mission.title });
      var tag = createEl('span', { className: 'status-tag ' + status, textContent: status.toUpperCase() });

      var metaChildren = [tag];
      if (mission.assigned_agent_id) {
        metaChildren.push(
          createEl('span', { style: 'font-size:10px;color:#8b949e', textContent: mission.assigned_agent_id })
        );
      }
      var metaEl = createEl('div', { className: 'mission-meta' }, metaChildren);

      var row = createEl('div', { className: rowClass, 'data-mission-id': mission.id }, [titleEl, metaEl]);
      $missionsList.appendChild(row);
    });
  }

  function buildTimelineRowEl(evt) {
    var time = formatTime(evt.timestamp);
    var agentLabel = evt.agent_id || 'unknown';
    var color = getAgentColor(agentLabel);
    var toolName = evt.tool_name || '';
    var eventType = evt.event_type || '';

    var timeEl = createEl('span', { className: 'timeline-time', textContent: time });
    var agentEl = createEl('span', { className: 'timeline-agent', style: 'color:' + color, textContent: agentLabel });

    var eventEl = createEl('span', { className: 'timeline-event' });
    eventEl.appendChild(document.createTextNode(eventType + ' '));
    if (toolName) {
      eventEl.appendChild(createEl('span', { className: 'timeline-tool', textContent: toolName }));
    }

    return createEl('div', { className: 'timeline-row' }, [timeEl, agentEl, eventEl]);
  }

  function renderTimeline() {
    $timelineBadge.textContent = eventCount;
    clearElement($timelineList);

    if (state.events.length === 0) {
      $timelineList.appendChild(
        createEl('div', { className: 'empty-state', textContent: 'Waiting for events...' })
      );
      return;
    }

    state.events.forEach(function (evt) {
      $timelineList.appendChild(buildTimelineRowEl(evt));
    });
    scrollTimelineToBottom();
  }

  function renderTimelineAppend(evt) {
    $timelineBadge.textContent = eventCount;

    // Remove empty state if present
    var empty = $timelineList.querySelector('.empty-state');
    if (empty) {
      empty.remove();
    }

    $timelineList.appendChild(buildTimelineRowEl(evt));
    scrollTimelineToBottom();
  }

  function scrollTimelineToBottom() {
    $timelineList.scrollTop = $timelineList.scrollHeight;
  }

  // ── Panel focus ───────────────────────────────────────────────────────────

  function setActivePanel(index) {
    state.activePanel = index;
    panels.forEach(function (p, i) {
      if (i === index) {
        p.classList.add('active-panel');
      } else {
        p.classList.remove('active-panel');
      }
    });
    renderAgents();
    renderMissions();
  }

  function cyclePanels(direction) {
    var next = (state.activePanel + direction + panels.length) % panels.length;
    setActivePanel(next);
  }

  function navigateRows(direction) {
    var panelIdx = state.activePanel;
    var listLength = 0;
    if (panelIdx === 0) listLength = state.agents.length;
    else if (panelIdx === 1) listLength = state.missions.length;
    else return; // timeline doesn't support row focus

    if (listLength === 0) return;

    var current = state.focusedRow[panelIdx];
    var next = Math.max(0, Math.min(listLength - 1, current + direction));
    state.focusedRow[panelIdx] = next;

    if (panelIdx === 0) renderAgents();
    else renderMissions();
  }

  function selectFocusedRow() {
    if (state.activePanel === 0 && state.agents.length > 0) {
      var agent = state.agents[state.focusedRow[0]];
      state.selectedAgentId = agent.id;
      $commandTarget.textContent = agent.name || agent.agent_id || agent.id;
      renderAgents();
    }
  }

  // ── Mission creation ──────────────────────────────────────────────────────

  function showMissionModal() {
    $missionModal.classList.remove('hidden');
    $missionTitle.value = '';
    $missionDesc.value = '';
    $missionTitle.focus();
  }

  function hideMissionModal() {
    $missionModal.classList.add('hidden');
  }

  function submitMission(e) {
    e.preventDefault();
    var title = $missionTitle.value.trim();
    var description = $missionDesc.value.trim();
    if (!title) return;

    fetch('/api/missions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title, description: description }),
    })
      .then(function (res) { return res.json(); })
      .then(function (mission) {
        upsertMission(mission);
        renderMissions();
        updateHeaderStats();
      })
      .catch(function (err) {
        console.error('Failed to create mission:', err);
      });

    hideMissionModal();
  }

  // ── Instruction sending ───────────────────────────────────────────────────

  function showCommandBar() {
    $commandBar.classList.remove('hidden');
    $commandInput.focus();
  }

  function hideCommandBar() {
    $commandBar.classList.add('hidden');
    $commandInput.value = '';
  }

  function sendInstruction() {
    var message = $commandInput.value.trim();
    if (!message || !state.selectedAgentId) return;

    fetch('/api/instructions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target_agent_id: state.selectedAgentId,
        message: message,
      }),
    })
      .then(function () {
        $commandInput.value = '';
      })
      .catch(function (err) {
        console.error('Failed to send instruction:', err);
      });
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  document.addEventListener('keydown', function (e) {
    // Ignore when typing in inputs
    var tag = (e.target && e.target.tagName) ? e.target.tagName : '';
    var isInput = tag === 'INPUT' || tag === 'TEXTAREA';

    if (isInput) {
      if (e.key === 'Escape') {
        e.target.blur();
        hideMissionModal();
        hideCommandBar();
      }
      if (e.key === 'Enter' && e.target === $commandInput) {
        e.preventDefault();
        sendInstruction();
      }
      return;
    }

    switch (e.key) {
      case 'Tab':
        e.preventDefault();
        cyclePanels(e.shiftKey ? -1 : 1);
        break;
      case 'j':
        navigateRows(1);
        break;
      case 'k':
        navigateRows(-1);
        break;
      case 'Enter':
        selectFocusedRow();
        break;
      case 'n':
        e.preventDefault();
        showMissionModal();
        break;
      case 'i':
        e.preventDefault();
        if (state.selectedAgentId) {
          showCommandBar();
        }
        break;
      case 'Escape':
        hideMissionModal();
        hideCommandBar();
        break;
    }
  });

  // ── Click handlers ────────────────────────────────────────────────────────

  $agentsList.addEventListener('click', function (e) {
    var row = e.target.closest('[data-agent-id]');
    if (!row) return;
    var agentId = row.getAttribute('data-agent-id');
    state.selectedAgentId = agentId;
    var agent = state.agents.find(function (a) { return a.id === agentId; });
    if (agent) {
      $commandTarget.textContent = agent.name || agent.agent_id || agent.id;
    }
    renderAgents();
  });

  $newMissionBtn.addEventListener('click', function () {
    showMissionModal();
  });

  $cancelMission.addEventListener('click', function () {
    hideMissionModal();
  });

  $missionForm.addEventListener('submit', submitMission);

  $missionModal.addEventListener('click', function (e) {
    if (e.target === $missionModal) {
      hideMissionModal();
    }
  });

  // ── Initialize ────────────────────────────────────────────────────────────

  renderConnectionStatus();
  updateHeaderStats();
  setActivePanel(0);
  connectWebSocket();

  // Refresh agent time-ago displays every 10s
  setInterval(function () {
    renderAgents();
  }, 10000);

})();
