// ── Mission Control Dashboard ─────────────────────────────────────────────────
// Palantir Gotham-style command center. Plain JS — no build step, no framework.
// Direct DOM manipulation for sub-100ms renders.

(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────────

  var state = {
    agents: [],
    missions: [],
    events: [],
    connected: false,
    selectedAgentId: null,
    activePanel: 0,        // 0=agents, 1=missions, 2=timeline
    focusedRow: [0, 0, 0], // per-panel focused row index
    timelineFilter: null,  // agent id to filter by, or null for all
    securityEvents: [],    // security event log
    layerStatus: {},       // layer# -> 'ok'|'warn'|'critical'
  };

  var ws = null;
  var reconnectTimer = null;
  var RECONNECT_DELAY = 2000;
  var eventCount = 0;
  var startTime = Date.now();

  // ── Deterministic agent color (hash-based, same agent = same color) ──────

  var AGENT_COLORS = [
    '#58a6ff', '#3fb950', '#d29922', '#f85149', '#bc8cff',
    '#79c0ff', '#56d364', '#e3b341', '#ff7b72', '#d2a8ff',
  ];

  function hashString(str) {
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  function getAgentColor(agentId) {
    return AGENT_COLORS[hashString(agentId) % AGENT_COLORS.length];
  }

  // ── Stuck/loop detection ─────────────────────────────────────────────────

  var STUCK_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
  var agentLastSeen = {};    // agentId -> timestamp
  var agentRecentTools = {}; // agentId -> [{ tool, input }, ...]

  function trackAgentActivity(evt) {
    var aid = evt.agent_id || 'unknown';
    agentLastSeen[aid] = Date.now();

    if (evt.tool_name) {
      if (!agentRecentTools[aid]) agentRecentTools[aid] = [];
      var inputKey = '';
      try {
        var inp = typeof evt.tool_input === 'string' ? JSON.parse(evt.tool_input) : evt.tool_input;
        inputKey = JSON.stringify(inp);
      } catch (e) {
        inputKey = String(evt.tool_input);
      }
      agentRecentTools[aid].push({ tool: evt.tool_name, input: inputKey });
      // Keep last 10
      if (agentRecentTools[aid].length > 10) {
        agentRecentTools[aid] = agentRecentTools[aid].slice(-10);
      }
    }
  }

  function isAgentStuck(agentId) {
    var lastSeen = agentLastSeen[agentId];
    if (!lastSeen) return false;
    return (Date.now() - lastSeen) > STUCK_THRESHOLD_MS;
  }

  // Read-only tools don't count as loops — re-reading is normal behavior.
  var LOOP_IGNORE_TOOLS = { 'Read': true, 'Grep': true, 'Glob': true };

  function isAgentLooping(agentId) {
    var recent = agentRecentTools[agentId];
    if (!recent || recent.length < 3) return false;
    var last = recent[recent.length - 1];
    // Skip read-only tools — repeated reads are normal
    if (LOOP_IGNORE_TOOLS[last.tool]) return false;
    var count = 0;
    for (var i = recent.length - 1; i >= 0; i--) {
      if (recent[i].tool === last.tool && recent[i].input === last.input) {
        count++;
      } else {
        break;
      }
    }
    return count >= 3;
  }

  // ── Status dot characters ────────────────────────────────────────────────

  var STATUS_DOTS = {
    active: '\u25CF',       // ● filled circle
    idle: '\u25CB',         // ○ empty circle
    disconnected: '\u25CC', // ◌ dotted circle
  };

  // ── DOM references ────────────────────────────────────────────────────────

  var $agentCount = document.getElementById('agent-count');
  var $missionCount = document.getElementById('mission-count');
  var $eventCount = document.getElementById('event-count');
  var $uptime = document.getElementById('uptime');
  var $connectionStatus = document.getElementById('connection-status');
  var $agentsList = document.getElementById('agents-list');
  var $agentsBadge = document.getElementById('agents-badge');
  var $missionsList = document.getElementById('missions-list');
  var $missionsBadge = document.getElementById('missions-badge');
  var $timelineList = document.getElementById('timeline-list');
  var $timelineBadge = document.getElementById('timeline-badge');
  var $timelineFilter = document.getElementById('timeline-filter');
  var $commandInput = document.getElementById('command-input');
  var $commandTarget = document.getElementById('command-target');
  var $newMissionBtn = document.getElementById('new-mission-btn');
  var $missionInlineForm = document.getElementById('mission-inline-form');
  var $missionTitleInput = document.getElementById('mission-title-input');
  var $missionCreateBtn = document.getElementById('mission-create-btn');
  var $missionCancelBtn = document.getElementById('mission-cancel-btn');
  var $kbdHelp = document.getElementById('kbd-help');
  var $securityBtn = document.getElementById('security-btn');
  var $securityCount = document.getElementById('security-count');
  var $securityOverlay = document.getElementById('security-overlay');
  var $securityClose = document.getElementById('security-close');
  var $securityLog = document.getElementById('security-log');
  var $radarBlips = document.getElementById('radar-blips');
  var $leftCol = document.getElementById('left-col');
  var $rightCol = document.getElementById('right-col');
  var $mobileTabs = document.getElementById('mobile-tabs');
  var $mobAgentCount = document.getElementById('mob-agent-count');
  var $mobMissionCount = document.getElementById('mob-mission-count');
  var $mobEventCount = document.getElementById('mob-event-count');
  var $mobUsageCount = document.getElementById('mob-usage-count');
  var $usageList = document.getElementById('usage-list');
  var $usageBadge = document.getElementById('usage-badge');

  var panels = [
    document.getElementById('agents-panel'),
    document.getElementById('missions-panel'),
    document.getElementById('usage-panel'),
    document.getElementById('timeline-panel'),
  ];

  // ── Utilities ─────────────────────────────────────────────────────────────

  function formatTime(ts) {
    if (!ts) return '--:--:--';
    var d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' +
           String(d.getMinutes()).padStart(2, '0') + ':' +
           String(d.getSeconds()).padStart(2, '0');
  }

  function formatDuration(ms) {
    if (ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var h = String(Math.floor(s / 3600)).padStart(2, '0');
    var m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    var sec = String(s % 60).padStart(2, '0');
    return h + ':' + m + ':' + sec;
  }

  function timeAgo(ts) {
    if (!ts) return '';
    var diff = Date.now() - new Date(ts).getTime();
    if (diff < 0) diff = 0;
    var seconds = Math.floor(diff / 1000);
    if (seconds < 60) return seconds + 's ago';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    return Math.floor(minutes / 60) + 'h ago';
  }

  function elapsed(since) {
    if (!since) return '';
    var diff = Date.now() - new Date(since).getTime();
    return formatDuration(diff);
  }

  function createEl(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (key === 'className') el.className = attrs[key];
        else if (key === 'textContent') el.textContent = attrs[key];
        else if (key.indexOf('data-') === 0) el.setAttribute(key, attrs[key]);
        else if (key === 'style') el.setAttribute('style', attrs[key]);
        else el[key] = attrs[key];
      });
    }
    if (children) {
      children.forEach(function (child) { if (child) el.appendChild(child); });
    }
    return el;
  }

  function clearElement(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  // ── Toast notifications ───────────────────────────────────────────────────

  function showToast(message) {
    var toast = createEl('div', { className: 'toast', textContent: message });
    document.body.appendChild(toast);
    // Trigger reflow for animation
    toast.offsetHeight;
    toast.classList.add('toast-visible');
    setTimeout(function () {
      toast.classList.remove('toast-visible');
      setTimeout(function () { toast.remove(); }, 300);
    }, 2500);
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────

  function connectWebSocket() {
    var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(protocol + '//' + location.host);

    ws.onopen = function () {
      state.connected = true;
      renderConnectionStatus();
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    };

    ws.onclose = function () {
      state.connected = false;
      renderConnectionStatus();
      scheduleReconnect();
    };

    ws.onerror = function () {};

    ws.onmessage = function (evt) {
      try { handleMessage(JSON.parse(evt.data)); } catch (e) {}
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
      // ── Initial bulk loads ──
      case 'agents':
        state.agents = msg.data || [];
        renderAgents();
        break;
      case 'events':
        state.events = msg.data || [];
        eventCount = state.events.length;
        state.events.forEach(trackAgentActivity);
        renderTimeline();
        // Also fetch missions on initial connect
        fetchMissions();
        break;
      case 'missions':
        state.missions = msg.data || [];
        renderMissions();
        break;

      // ── Incremental updates (server uses colon-separated types) ──
      case 'event:new':
      case 'event':
        state.events.push(msg.data);
        eventCount++;
        trackAgentActivity(msg.data);
        renderTimelineAppend(msg.data);
        scheduleUsageRefresh();
        break;
      case 'agent:update':
      case 'agent_update':
        upsertAgent(msg.data);
        renderAgents();
        break;
      case 'mission:update':
      case 'mission_update':
        upsertMission(msg.data);
        renderMissions();
        break;
      case 'instruction:new':
        showToast('Instruction sent to ' + (msg.data.target_agent_id || 'agent'));
        break;
      case 'security:event':
        handleSecurityEvent(msg.data);
        break;
    }
    updateHeaderStats();
  }

  // Fetch missions via REST (server doesn't send them on WS connect)
  function fetchMissions() {
    fetch('/api/missions')
      .then(function (res) { return res.json(); })
      .then(function (missions) {
        if (Array.isArray(missions)) {
          state.missions = missions;
        } else if (missions && Array.isArray(missions.data)) {
          state.missions = missions.data;
        }
        renderMissions();
        updateHeaderStats();
      })
      .catch(function () {});
  }

  function upsertAgent(agent) {
    var idx = state.agents.findIndex(function (a) { return a.id === agent.id; });
    if (idx >= 0) state.agents[idx] = agent;
    else state.agents.push(agent);
  }

  function upsertMission(mission) {
    var idx = state.missions.findIndex(function (m) { return m.id === mission.id; });
    if (idx >= 0) state.missions[idx] = mission;
    else state.missions.push(mission);
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function renderConnectionStatus() {
    if (state.connected) {
      $connectionStatus.className = 'conn-status connected';
      $connectionStatus.querySelector('.conn-text').textContent = 'CONNECTED';
    } else {
      $connectionStatus.className = 'conn-status disconnected';
      $connectionStatus.querySelector('.conn-text').textContent = 'DISCONNECTED';
    }
  }

  function updateHeaderStats() {
    $agentCount.textContent = state.agents.length;
    $missionCount.textContent = state.missions.length;
    $eventCount.textContent = eventCount;
    // Mobile tab counts
    if ($mobAgentCount) $mobAgentCount.textContent = state.agents.length;
    if ($mobMissionCount) $mobMissionCount.textContent = state.missions.length;
    if ($mobEventCount) $mobEventCount.textContent = eventCount;
  }

  function updateUptime() {
    $uptime.textContent = formatDuration(Date.now() - startTime);
  }

  // ── Agents panel ──────────────────────────────────────────────────────────

  function renderAgents() {
    $agentsBadge.textContent = state.agents.length;
    clearElement($agentsList);

    if (state.agents.length === 0) {
      $agentsList.appendChild(createEl('div', { className: 'empty-state', textContent: 'No agents connected' }));
      return;
    }

    state.agents.forEach(function (agent, i) {
      var statusClass = agent.status || 'active';
      var name = agent.name || agent.agent_id || agent.id;
      var isSubagent = agent.agent_id && agent.agent_id !== 'main';
      var focused = (state.activePanel === 0 && state.focusedRow[0] === i);
      var selected = (state.selectedAgentId === agent.id);
      var rowClass = 'agent-row' + (focused ? ' focused' : '') + (selected ? ' selected' : '') + (isSubagent ? ' subagent' : '');

      // Status dot (Unicode)
      var dotChar = STATUS_DOTS[statusClass] || STATUS_DOTS.disconnected;
      var dot = createEl('span', { className: 'agent-dot ' + statusClass, textContent: dotChar });
      var nameEl = createEl('span', { className: 'agent-name', textContent: (isSubagent ? '\u2514 ' : '') + name });
      var timeEl = createEl('span', { className: 'agent-time', textContent: timeAgo(agent.last_seen_at) });

      var topChildren = [dot, nameEl];

      // Alert badges
      if (statusClass === 'active' && isAgentStuck(agent.id)) {
        topChildren.push(createEl('span', { className: 'agent-alert stuck', textContent: '! STUCK' }));
      } else if (isAgentLooping(agent.id)) {
        topChildren.push(createEl('span', { className: 'agent-alert loop', textContent: '! LOOP' }));
      }

      topChildren.push(timeEl);
      var topRow = createEl('div', { className: 'agent-row-top' }, topChildren);

      var children = [topRow];

      // Show cwd when selected or stuck — helps find the right terminal
      if (selected && agent.cwd) {
        children.push(createEl('div', { className: 'agent-activity cwd', textContent: agent.cwd }));
      }

      // Activity line
      var activity = agent.current_tool || '';
      if (statusClass === 'active' && isAgentStuck(agent.id)) {
        activity = 'no activity for ' + timeAgo(agent.last_seen_at) + ' — check terminal';
      } else if (statusClass === 'idle') {
        activity = 'idle ' + timeAgo(agent.last_seen_at);
      }
      if (activity) {
        children.push(createEl('div', { className: 'agent-activity', textContent: activity }));
      }

      var row = createEl('div', { className: rowClass, 'data-agent-id': agent.id }, children);
      $agentsList.appendChild(row);
    });
  }

  // ── Missions panel ────────────────────────────────────────────────────────

  function renderMissions() {
    $missionsBadge.textContent = state.missions.length;
    clearElement($missionsList);

    if (state.missions.length === 0) {
      $missionsList.appendChild(createEl('div', { className: 'empty-state', textContent: 'No missions' }));
      return;
    }

    state.missions.forEach(function (mission, i) {
      var status = mission.status || 'queued';
      var focused = (state.activePanel === 1 && state.focusedRow[1] === i);
      var rowClass = 'mission-row' + (focused ? ' focused' : '');

      var tag = createEl('span', { className: 'status-tag ' + status, textContent: status.toUpperCase() });
      var titleEl = createEl('span', { className: 'mission-title', textContent: mission.title });

      // Meta: agent assignment + elapsed time
      var metaText = '';
      if (mission.assigned_agent_id) {
        metaText = '\u2190 ' + mission.assigned_agent_id;
        if (mission.started_at && status === 'active') {
          metaText += '  ' + elapsed(mission.started_at);
        }
      } else if (mission.completed_at && status === 'completed') {
        metaText = 'completed ' + timeAgo(mission.completed_at);
      } else if (mission.priority) {
        metaText = 'priority: ' + (mission.priority > 5 ? 'HIGH' : mission.priority > 2 ? 'MED' : 'LOW');
      }

      var metaEl = metaText ? createEl('span', { className: 'mission-meta', textContent: metaText }) : null;
      var topRow = createEl('div', { className: 'mission-top' }, [tag, titleEl, metaEl].filter(Boolean));

      var children = [topRow];

      // Dependency info for blocked missions
      if (status === 'blocked' && mission.depends_on) {
        var deps = mission.depends_on;
        if (typeof deps === 'string') {
          try { deps = JSON.parse(deps); } catch (e) { deps = []; }
        }
        if (deps.length > 0) {
          var depEl = createEl('div', { className: 'mission-detail' });
          depEl.appendChild(createEl('span', { className: 'dep-label', textContent: 'waiting on: ' }));
          depEl.appendChild(document.createTextNode(deps.join(', ')));
          children.push(depEl);
        }
      }

      var row = createEl('div', { className: rowClass, 'data-mission-id': mission.id }, children);
      $missionsList.appendChild(row);
    });
  }

  // ── Timeline panel ────────────────────────────────────────────────────────

  function getEventDetail(evt) {
    var input = evt.tool_input;
    if (!input) return '';
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch (e) { return ''; }
    }
    if (input.file_path) return input.file_path.split('/').slice(-2).join('/');
    if (input.command) {
      var cmd = input.command;
      return cmd.length > 60 ? cmd.substring(0, 57) + '...' : cmd;
    }
    if (input.pattern) return input.pattern;
    return '';
  }

  function buildTimelineRowEl(evt) {
    var agentLabel = evt.agent_id || 'unknown';

    // Filter check
    if (state.timelineFilter && agentLabel !== state.timelineFilter) return null;

    var color = getAgentColor(agentLabel);
    var toolName = evt.tool_name || evt.event_type || '';
    var detail = getEventDetail(evt);

    var timeEl = createEl('span', { className: 'timeline-time', textContent: formatTime(evt.timestamp) });
    var agentEl = createEl('span', { className: 'timeline-agent', style: 'color:' + color, textContent: agentLabel });
    var toolEl = createEl('span', { className: 'timeline-tool', textContent: toolName });
    var detailEl = createEl('span', { className: 'timeline-detail', textContent: detail });

    return createEl('div', { className: 'timeline-row' }, [timeEl, agentEl, toolEl, detailEl]);
  }

  function renderTimeline() {
    $timelineBadge.textContent = eventCount;
    clearElement($timelineList);

    if (state.events.length === 0) {
      $timelineList.appendChild(createEl('div', { className: 'empty-state', textContent: 'Waiting for events...' }));
      return;
    }

    var count = 0;
    state.events.forEach(function (evt) {
      var row = buildTimelineRowEl(evt);
      if (row) { $timelineList.appendChild(row); count++; }
    });

    if (count === 0) {
      $timelineList.appendChild(createEl('div', { className: 'empty-state', textContent: 'No events match filter' }));
    }

    scrollTimelineToBottom();
  }

  function renderTimelineAppend(evt) {
    $timelineBadge.textContent = eventCount;

    var row = buildTimelineRowEl(evt);
    if (!row) return;

    var empty = $timelineList.querySelector('.empty-state');
    if (empty) empty.remove();

    $timelineList.appendChild(row);
    scrollTimelineToBottom();
  }

  function scrollTimelineToBottom() {
    $timelineList.scrollTop = $timelineList.scrollHeight;
  }

  function setTimelineFilter(agentId) {
    state.timelineFilter = agentId;
    if (agentId) {
      $timelineFilter.textContent = 'filter: ' + agentId + ' [x]';
      $timelineFilter.classList.remove('hidden');
    } else {
      // Clearing filter also deselects the agent and resets usage to global
      state.selectedAgentId = null;
      $timelineFilter.classList.add('hidden');
      $commandTarget.textContent = 'to: (select agent)';
      $commandInput.disabled = true;
      $commandInput.placeholder = 'Select an agent first';
      renderAgents();
      fetchUsage();
    }
    renderTimeline();
  }

  // ── Usage panel ───────────────────────────────────────────────────────────

  var usageData = null;
  var usageRefreshTimer = null;
  var usagePeriodHours = 24;
  var $periodTabs = document.getElementById('period-tabs');

  function scheduleUsageRefresh() {
    if (usageRefreshTimer) return;
    usageRefreshTimer = setTimeout(function () {
      usageRefreshTimer = null;
      fetchUsage();
    }, 5000);
  }

  function setUsagePeriod(hours) {
    usagePeriodHours = hours;
    // Update tab active state
    if ($periodTabs) {
      var tabs = $periodTabs.querySelectorAll('.period-tab');
      tabs.forEach(function (tab) {
        if (parseInt(tab.getAttribute('data-hours'), 10) === hours) {
          tab.classList.add('active');
        } else {
          tab.classList.remove('active');
        }
      });
    }
    fetchUsage();
  }

  // Period tab click handler
  if ($periodTabs) {
    $periodTabs.addEventListener('click', function (e) {
      var tab = e.target.closest('.period-tab');
      if (!tab) return;
      var hours = parseInt(tab.getAttribute('data-hours'), 10);
      if (!isNaN(hours)) setUsagePeriod(hours);
    });
  }

  var tokenData = null;

  function fetchUsage() {
    var usageUrl = '/api/usage?hours=' + usagePeriodHours;
    if (state.selectedAgentId) {
      usageUrl += '&agent=' + encodeURIComponent(state.selectedAgentId);
    }
    var tokenUrl = '/api/tokens?hours=' + usagePeriodHours;

    // Fetch both in parallel
    Promise.all([
      fetch(usageUrl).then(function (r) { return r.json(); }),
      fetch(tokenUrl).then(function (r) { return r.json(); }).catch(function () { return null; }),
    ]).then(function (results) {
      usageData = results[0];
      tokenData = results[1];
      renderUsage();
    }).catch(function () {});
  }

  function formatCost(amount) {
    if (amount >= 1) return '$' + amount.toFixed(2);
    if (amount >= 0.01) return '$' + amount.toFixed(3);
    return '$' + amount.toFixed(4);
  }

  function formatTokens(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  function renderUsage() {
    if (!usageData && !tokenData) return;

    // Prefer token data (real) over usage data (estimates)
    var hasTokens = tokenData && tokenData.totalCost > 0;
    var periodLabel = usageData && usageData.period === 'all' ? 'All Time' : (usageData ? usageData.period.toUpperCase() : '24H');

    var badgeText = hasTokens ? formatCost(tokenData.totalCost) : (usageData ? String(usageData.totalToolCalls) : '0');
    $usageBadge.textContent = badgeText;
    if ($mobUsageCount) $mobUsageCount.textContent = badgeText;
    clearElement($usageList);

    if (!hasTokens && (!usageData || usageData.totalToolCalls === 0)) {
      $usageList.appendChild(createEl('div', { className: 'empty-state', textContent: 'No usage data yet' }));
      return;
    }

    // ── Summary stats ──
    var summary = createEl('div', { className: 'usage-summary' });

    if (hasTokens) {
      // Real token data from JSONL logs
      var tokenStats = [
        { value: formatCost(tokenData.totalCost), label: 'Cost (' + periodLabel + ')', cls: 'cost' },
        { value: formatTokens(tokenData.totalTokens), label: 'Tokens', cls: '' },
        { value: String(tokenData.totalMessages), label: 'Messages', cls: '' },
        { value: String(tokenData.totalSessions), label: 'Sessions', cls: '' },
        { value: tokenData.cacheHitRate + '%', label: 'Cache Hit', cls: 'cache' },
      ];
      tokenStats.forEach(function (s) {
        var valueClass = 'usage-stat-value' + (s.cls ? ' ' + s.cls : '');
        summary.appendChild(createEl('div', { className: 'usage-stat' }, [
          createEl('span', { className: valueClass, textContent: s.value }),
          createEl('span', { className: 'usage-stat-label', textContent: s.label }),
        ]));
      });
    } else {
      // Fallback: estimated from tool calls
      var summaryStats = [
        { value: formatCost(usageData.totalEstimatedCost), label: 'Est. Cost (' + periodLabel + ')', cls: 'cost' },
        { value: String(usageData.totalToolCalls), label: 'Tool Calls', cls: '' },
        { value: String(usageData.totalSessions || 0), label: 'Sessions', cls: '' },
        { value: String(usageData.uniqueAgents), label: 'Agents', cls: '' },
      ];
      summaryStats.forEach(function (s) {
        var valueClass = 'usage-stat-value' + (s.cls ? ' ' + s.cls : '');
        summary.appendChild(createEl('div', { className: 'usage-stat' }, [
          createEl('span', { className: valueClass, textContent: s.value }),
          createEl('span', { className: 'usage-stat-label', textContent: s.label }),
        ]));
      });
    }
    $usageList.appendChild(summary);

    // ── Token breakdown (real data) ──
    if (hasTokens) {
      var tokenSection = createEl('div', { className: 'usage-section' });
      tokenSection.appendChild(createEl('div', { className: 'usage-section-title', textContent: 'Token Breakdown' }));

      var tokenRows = [
        { label: 'Input', value: formatTokens(tokenData.totalInputTokens), cls: '' },
        { label: 'Output', value: formatTokens(tokenData.totalOutputTokens), cls: '' },
        { label: 'Cache Write', value: formatTokens(tokenData.totalCacheCreationTokens), cls: '' },
        { label: 'Cache Read', value: formatTokens(tokenData.totalCacheReadTokens), cls: 'cache' },
      ];
      tokenRows.forEach(function (r) {
        var valueClass = 'session-cost' + (r.cls ? ' ' + r.cls : '');
        tokenSection.appendChild(createEl('div', { className: 'session-row' }, [
          createEl('span', { className: 'session-label', textContent: r.label }),
          createEl('span', { className: valueClass, textContent: r.value }),
        ]));
      });
      $usageList.appendChild(tokenSection);

      // Model usage
      if (tokenData.models && tokenData.models.length > 0) {
        var modelSection = createEl('div', { className: 'usage-section' });
        modelSection.appendChild(createEl('div', { className: 'usage-section-title', textContent: 'Cost by Model' }));

        var maxModelCost = tokenData.models[0].cost || 0.001;
        tokenData.models.forEach(function (m) {
          var pct = Math.round((m.cost / maxModelCost) * 100);
          var modelName = m.model.replace('claude-', '');
          var fill = createEl('div', { className: 'usage-bar-fill', style: 'width:' + pct + '%' });
          var track = createEl('div', { className: 'usage-bar-track' }, [fill]);
          modelSection.appendChild(createEl('div', { className: 'usage-bar-row' }, [
            createEl('span', { className: 'usage-bar-label', textContent: modelName }),
            track,
            createEl('span', { className: 'usage-bar-count cost-count', textContent: formatCost(m.cost) }),
          ]));
        });
        $usageList.appendChild(modelSection);
      }
    }

    // ── Session costs (real data preferred) ──
    var sessionsList = hasTokens ? tokenData.sessions : (usageData ? usageData.sessionCosts : []);
    if (sessionsList && sessionsList.length > 0) {
      var sessionSection = createEl('div', { className: 'usage-section' });
      sessionSection.appendChild(createEl('div', { className: 'usage-section-title', textContent: 'Session Costs' }));

      sessionsList.slice(0, 8).forEach(function (s) {
        var sid = s.sessionId || s.session_id || '';
        var sessionLabel = sid.length > 10 ? sid.slice(0, 8) + '..' : sid;
        var sCost = s.cost !== undefined ? s.cost : (s.estimated_cost || 0);
        var sMessages = s.messageCount || s.tool_calls || 0;
        var sTime = s.lastTimestamp || s.last_event || '';
        var msgLabel = s.messageCount !== undefined ? sMessages + ' msgs' : sMessages + ' calls';

        var children = [
          createEl('span', { className: 'session-label', textContent: sessionLabel, title: sid }),
          createEl('span', { className: 'session-cost', textContent: formatCost(sCost) }),
          createEl('span', { className: 'session-meta', textContent: msgLabel }),
        ];
        if (s.model) {
          children.push(createEl('span', { className: 'session-meta', textContent: s.model.replace('claude-', '') }));
        }
        children.push(createEl('span', { className: 'session-time', textContent: timeAgo(sTime) }));

        sessionSection.appendChild(createEl('div', { className: 'session-row' }, children));
      });
      $usageList.appendChild(sessionSection);
    }

    // ── Daily costs (real data preferred) ──
    var dailyList = hasTokens ? tokenData.daily : (usageData ? usageData.dailyCosts : []);
    if (dailyList && dailyList.length > 0) {
      var dailySection = createEl('div', { className: 'usage-section' });
      var dailyTitle = 'Daily Costs (' + periodLabel + ')';
      dailySection.appendChild(createEl('div', { className: 'usage-section-title', textContent: dailyTitle }));

      var maxDailyCost = 0.001;
      dailyList.forEach(function (d) {
        var dCost = d.cost !== undefined ? d.cost : (d.estimated_cost || 0);
        if (dCost > maxDailyCost) maxDailyCost = dCost;
      });

      dailyList.forEach(function (d) {
        var dCost = d.cost !== undefined ? d.cost : (d.estimated_cost || 0);
        var pct = Math.round((dCost / maxDailyCost) * 100);
        var fill = createEl('div', { className: 'usage-bar-fill daily', style: 'width:' + pct + '%' });
        var track = createEl('div', { className: 'usage-bar-track' }, [fill]);
        var dateLabel = d.date.slice(5);
        dailySection.appendChild(createEl('div', { className: 'usage-bar-row' }, [
          createEl('span', { className: 'usage-bar-label', textContent: dateLabel }),
          track,
          createEl('span', { className: 'usage-bar-count cost-count', textContent: formatCost(dCost) }),
        ]));
      });
      $usageList.appendChild(dailySection);
    }

    // ── Tool usage bars (from hook events) ──
    if (usageData && usageData.toolUsage && usageData.toolUsage.length > 0) {
      var toolSection = createEl('div', { className: 'usage-section' });
      toolSection.appendChild(createEl('div', { className: 'usage-section-title', textContent: 'Top Tools' }));

      var maxToolCount = usageData.toolUsage[0].count;
      usageData.toolUsage.slice(0, 10).forEach(function (t) {
        var pct = Math.round((t.count / maxToolCount) * 100);
        var fill = createEl('div', { className: 'usage-bar-fill', style: 'width:' + pct + '%' });
        var track = createEl('div', { className: 'usage-bar-track' }, [fill]);
        toolSection.appendChild(createEl('div', { className: 'usage-bar-row' }, [
          createEl('span', { className: 'usage-bar-label', textContent: t.tool_name }),
          track,
          createEl('span', { className: 'usage-bar-count', textContent: String(t.count) }),
        ]));
      });
      $usageList.appendChild(toolSection);
    }

    // ── Hourly activity sparkline ──
    if (usageData && usageData.hourlyActivity && usageData.hourlyActivity.length > 0) {
      var activitySection = createEl('div', { className: 'usage-section' });
      activitySection.appendChild(createEl('div', { className: 'usage-section-title', textContent: 'Activity (24h)' }));

      var activityRow = createEl('div', { className: 'usage-activity-row' });
      var maxHourly = 1;
      usageData.hourlyActivity.forEach(function (h) {
        if (h.count > maxHourly) maxHourly = h.count;
      });
      usageData.hourlyActivity.forEach(function (h) {
        var heightPct = Math.max(2, Math.round((h.count / maxHourly) * 100));
        activityRow.appendChild(createEl('div', {
          className: 'usage-activity-bar',
          style: 'height:' + heightPct + '%',
          title: h.hour.slice(11, 16) + ' — ' + h.count + ' events',
        }));
      });
      activitySection.appendChild(activityRow);
      $usageList.appendChild(activitySection);
    }
  }

  // ── Panel focus ───────────────────────────────────────────────────────────

  function setActivePanel(index) {
    state.activePanel = index;
    panels.forEach(function (p, i) {
      if (i === index) p.classList.add('active-panel');
      else p.classList.remove('active-panel');
    });
    renderAgents();
    renderMissions();
  }

  function cyclePanels(direction) {
    setActivePanel((state.activePanel + direction + panels.length) % panels.length);
  }

  function navigateRows(direction) {
    var panelIdx = state.activePanel;
    var listLength = panelIdx === 0 ? state.agents.length : panelIdx === 1 ? state.missions.length : 0;
    if (listLength === 0) return;

    state.focusedRow[panelIdx] = Math.max(0, Math.min(listLength - 1, state.focusedRow[panelIdx] + direction));
    if (panelIdx === 0) renderAgents();
    else renderMissions();
  }

  function selectFocusedRow() {
    if (state.activePanel === 0 && state.agents.length > 0) {
      var agent = state.agents[state.focusedRow[0]];
      state.selectedAgentId = agent.id;
      $commandTarget.textContent = 'to: ' + (agent.name || agent.agent_id || agent.id);
      $commandInput.disabled = false;
      $commandInput.placeholder = 'Type instruction...';
      renderAgents();
      // Filter timeline and usage to this agent
      setTimelineFilter(agent.agent_id || agent.id);
      fetchUsage();
    }
  }

  // ── Inline mission creation ──────────────────────────────────────────────

  function showMissionForm() {
    $newMissionBtn.classList.add('hidden');
    $missionInlineForm.classList.remove('hidden');
    $missionTitleInput.value = '';
    $missionTitleInput.focus();
  }

  function hideMissionForm() {
    $missionInlineForm.classList.add('hidden');
    $newMissionBtn.classList.remove('hidden');
  }

  function submitMission() {
    var title = $missionTitleInput.value.trim();
    if (!title) return;

    hideMissionForm();

    fetch('/api/missions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title }),
    })
      .then(function (res) {
        if (!res.ok) {
          return res.json().then(function (body) { showToast('Error: ' + (body.error || 'Failed')); });
        }
        return res.json().then(function (mission) {
          upsertMission(mission);
          renderMissions();
          updateHeaderStats();
          showToast('Mission created: ' + title);
        });
      })
      .catch(function () { showToast('Failed to create mission'); });
  }

  // ── Instruction sending ──────────────────────────────────────────────────

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
      .then(function (res) {
        if (res.ok) {
          $commandInput.value = '';
          showToast('Instruction sent');
        } else {
          return res.json().then(function (body) {
            showToast('Error: ' + (body.error || 'Failed'));
          });
        }
      })
      .catch(function () { showToast('Failed to send instruction'); });
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName) ? e.target.tagName : '';
    var isInput = tag === 'INPUT' || tag === 'TEXTAREA';

    // Input-specific handlers
    if (isInput) {
      if (e.key === 'Escape') {
        e.target.blur();
        if (e.target === $missionTitleInput) hideMissionForm();
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.target === $commandInput) sendInstruction();
        if (e.target === $missionTitleInput) submitMission();
      }
      return;
    }

    // Global shortcuts
    switch (e.key) {
      case 'Tab':
        e.preventDefault();
        cyclePanels(e.shiftKey ? -1 : 1);
        break;
      case 'j':
      case 'ArrowDown':
        e.preventDefault();
        navigateRows(1);
        break;
      case 'k':
      case 'ArrowUp':
        e.preventDefault();
        navigateRows(-1);
        break;
      case 'Enter':
        selectFocusedRow();
        break;
      case 'n':
        e.preventDefault();
        showMissionForm();
        break;
      case 'i':
        e.preventDefault();
        if (state.selectedAgentId) $commandInput.focus();
        break;
      case '/':
        e.preventDefault();
        // Toggle timeline filter off
        if (state.timelineFilter) setTimelineFilter(null);
        break;
      case '?':
        e.preventDefault();
        $kbdHelp.classList.toggle('hidden');
        break;
      case 'Escape':
        hideMissionForm();
        $kbdHelp.classList.add('hidden');
        if (state.timelineFilter) setTimelineFilter(null);
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
      $commandTarget.textContent = 'to: ' + (agent.name || agent.agent_id || agent.id);
      $commandInput.disabled = false;
      $commandInput.placeholder = 'Type instruction...';
      setTimelineFilter(agent.agent_id || agent.id);
    }
    renderAgents();
    fetchUsage();
  });

  $timelineFilter.addEventListener('click', function () {
    setTimelineFilter(null);
  });

  $newMissionBtn.addEventListener('click', showMissionForm);
  $missionCreateBtn.addEventListener('click', submitMission);
  $missionCancelBtn.addEventListener('click', hideMissionForm);

  $kbdHelp.addEventListener('click', function (e) {
    if (e.target === $kbdHelp) $kbdHelp.classList.add('hidden');
  });

  // ── Mobile tab navigation ─────────────────────────────────────────────────

  var mobileActiveTab = 'agents';

  function isMobile() {
    return window.innerWidth <= 640;
  }

  function setMobileTab(tabName) {
    mobileActiveTab = tabName;

    // Update tab buttons
    var tabs = document.querySelectorAll('.mobile-tab');
    tabs.forEach(function (tab) {
      if (tab.getAttribute('data-tab') === tabName) {
        tab.classList.add('active');
      } else {
        tab.classList.remove('active');
      }
    });

    // Show/hide columns
    if (tabName === 'agents') {
      $leftCol.classList.add('mobile-visible');
      $rightCol.classList.remove('mobile-visible');
      panels[1].style.display = '';
      panels[2].style.display = '';
      panels[3].style.display = '';
    } else if (tabName === 'missions') {
      $leftCol.classList.remove('mobile-visible');
      $rightCol.classList.add('mobile-visible');
      panels[1].style.display = '';
      panels[2].style.display = 'none';
      panels[3].style.display = 'none';
    } else if (tabName === 'usage') {
      $leftCol.classList.remove('mobile-visible');
      $rightCol.classList.add('mobile-visible');
      panels[1].style.display = 'none';
      panels[2].style.display = '';
      panels[3].style.display = 'none';
    } else if (tabName === 'timeline') {
      $leftCol.classList.remove('mobile-visible');
      $rightCol.classList.add('mobile-visible');
      panels[1].style.display = 'none';
      panels[2].style.display = 'none';
      panels[3].style.display = '';
    }
  }

  // Tab click handlers
  if ($mobileTabs) {
    $mobileTabs.addEventListener('click', function (e) {
      var tab = e.target.closest('.mobile-tab');
      if (!tab) return;
      var tabName = tab.getAttribute('data-tab');
      if (tabName) setMobileTab(tabName);
    });
  }

  // Handle resize: reset mobile state when going to desktop
  function handleResize() {
    if (!isMobile()) {
      $leftCol.classList.remove('mobile-visible');
      $rightCol.classList.remove('mobile-visible');
      panels[1].style.display = '';
      panels[2].style.display = '';
      panels[3].style.display = '';
    } else {
      setMobileTab(mobileActiveTab);
    }
  }

  window.addEventListener('resize', handleResize);

  // ── Collapsible panels ────────────────────────────────────────────────────

  var COLLAPSE_KEY = 'mc_collapsed';

  function loadCollapsedState() {
    try { var s = localStorage.getItem(COLLAPSE_KEY); return s ? JSON.parse(s) : {}; }
    catch (e) { return {}; }
  }

  function saveCollapsedState(cs) {
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(cs)); } catch (e) {}
  }

  var collapsedPanels = loadCollapsedState();

  function applyCollapsedState() {
    document.querySelectorAll('.panel[data-panel]').forEach(function (panel) {
      var id = panel.getAttribute('data-panel');
      if (collapsedPanels[id]) panel.classList.add('collapsed');
    });
  }

  document.addEventListener('click', function (e) {
    var header = e.target.closest('.panel-header');
    if (!header) return;
    var panel = header.closest('.panel[data-panel]');
    if (!panel) return;
    // Don't collapse when clicking interactive elements inside header
    if (e.target.closest('button, input, .period-tab, .timeline-filter')) return;
    var id = panel.getAttribute('data-panel');
    panel.classList.toggle('collapsed');
    collapsedPanels[id] = panel.classList.contains('collapsed');
    saveCollapsedState(collapsedPanels);
  });

  applyCollapsedState();

  // ── Security bridge ──────────────────────────────────────────────────────
  // handleSecurityEvent is called from handleMessage for server-sent events.
  // security.js overrides MC.handleSecurityEvent for full processing.
  // This stub exists so the WS handler doesn't error before security.js loads.

  function handleSecurityEvent(evt) {
    if (window.MissionControl && window.MissionControl.handleSecurityEvent) {
      window.MissionControl.handleSecurityEvent(evt);
    }
  }

  // Expose API for security.js module
  window.MissionControl = {
    showToast: showToast,
    trackAgentActivity: trackAgentActivity,
    handleSecurityEvent: null, // set by security.js
    scanToolEvent: null,       // set by security.js
  };

  // Hook Layer 7 scanning into event stream once security.js loads
  var _origTrack = trackAgentActivity;
  trackAgentActivity = function (evt) {
    _origTrack(evt);
    if (window.MissionControl && window.MissionControl.scanToolEvent) {
      window.MissionControl.scanToolEvent(evt);
    }
  };

  // ── Initialize ────────────────────────────────────────────────────────────

  renderConnectionStatus();
  updateHeaderStats();
  setActivePanel(0);
  connectWebSocket();
  fetchUsage();

  // Set initial mobile state
  if (isMobile()) {
    setMobileTab('agents');
  }

  // Uptime counter — update every second
  setInterval(updateUptime, 1000);

  // Refresh agent displays every 10s (time-ago + stuck detection)
  setInterval(function () {
    renderAgents();
  }, 10000);

  // Refresh usage stats every 30s
  setInterval(fetchUsage, 30000);

})();
