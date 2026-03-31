// ── Mission Control Dashboard ─────────────────────────────────────────────────
// Copyright 2026 Cyrus David Pastelero. Apache-2.0 License.
// https://github.com/Cyvid7-Darus10/claude-mission-control
//
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

  // ── File activity & diff tracking (from claude-squad / agent-farm) ────────

  var agentFiles = {};      // agentId -> Set of file paths touched
  var agentEditCount = {};  // agentId -> { added: N, removed: N }
  var agentCurrentTool = {}; // agentId -> { tool, target } for live activity display

  function trackAgentActivity(evt) {
    var aid = evt.agent_id || 'unknown';

    // Clear tracking on session end — prevents stale LOOP/STUCK badges
    if (evt.event_type === 'stop' || evt.event_type === 'Stop') {
      clearAgentTracking(aid);
      return;
    }

    agentLastSeen[aid] = Date.now();

    if (evt.tool_name) {
      if (!agentRecentTools[aid]) agentRecentTools[aid] = [];
      var inputKey = '';
      var input;
      try {
        input = typeof evt.tool_input === 'string' ? JSON.parse(evt.tool_input) : evt.tool_input;
        inputKey = JSON.stringify(input);
      } catch (e) {
        input = null;
        inputKey = String(evt.tool_input);
      }
      agentRecentTools[aid].push({ tool: evt.tool_name, input: inputKey });
      // Keep last 10
      if (agentRecentTools[aid].length > 10) {
        agentRecentTools[aid] = agentRecentTools[aid].slice(-10);
      }

      // Track files touched by this agent
      if (input && input.file_path) {
        if (!agentFiles[aid]) agentFiles[aid] = {};
        agentFiles[aid][input.file_path] = true;
      }

      // Track edit diffs (rough line count estimates)
      if (evt.tool_name === 'Edit' && input) {
        if (!agentEditCount[aid]) agentEditCount[aid] = { added: 0, removed: 0 };
        var oldStr = input.old_string || '';
        var newStr = input.new_string || '';
        var oldLines = oldStr.split ? oldStr.split('\n').length : 0;
        var newLines = newStr.split ? newStr.split('\n').length : 0;
        agentEditCount[aid].removed += oldLines;
        agentEditCount[aid].added += newLines;
      } else if (evt.tool_name === 'Write' && input && input.content) {
        if (!agentEditCount[aid]) agentEditCount[aid] = { added: 0, removed: 0 };
        agentEditCount[aid].added += (input.content.split ? input.content.split('\n').length : 0);
      }

      // Track current tool for live display
      var target = '';
      if (input) {
        if (input.file_path) target = input.file_path.split('/').pop();
        else if (input.command) target = input.command.length > 30 ? input.command.slice(0, 27) + '...' : input.command;
        else if (input.pattern) target = input.pattern;
      }
      agentCurrentTool[aid] = { tool: evt.tool_name, target: target };
    }
  }

  function getAgentFileCount(agentId) {
    return agentFiles[agentId] ? Object.keys(agentFiles[agentId]).length : 0;
  }

  function getAgentDiffStats(agentId) {
    return agentEditCount[agentId] || { added: 0, removed: 0 };
  }

  function getAgentCurrentActivity(agentId) {
    return agentCurrentTool[agentId] || null;
  }

  // Clear tracking data when a session ends — prevents stale LOOP/STUCK alerts
  function clearAgentTracking(agentId) {
    delete agentRecentTools[agentId];
    delete agentCurrentTool[agentId];
    delete agentLastSeen[agentId];
  }

  function isAgentStuck(agentId) {
    var lastSeen = agentLastSeen[agentId];
    if (!lastSeen) return false;
    return (Date.now() - lastSeen) > STUCK_THRESHOLD_MS;
  }

  // Tools that are normal to call repeatedly — don't flag as loops.
  // Only flag write tools (Edit, Write, Bash) that repeat with identical input.
  var LOOP_IGNORE_TOOLS = {
    'Read': true, 'Grep': true, 'Glob': true,
    'Agent': true, 'SendMessage': true,
    'TaskCreate': true, 'TaskUpdate': true, 'TaskGet': true, 'TaskList': true,
    'WebSearch': true, 'WebFetch': true,
    'Skill': true, 'ToolSearch': true, 'LSP': true
  };

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
    if (count >= 3) return true;
    // Convergence score: total calls / unique tools > 3.0 (from builderz)
    // Catches subtle loops like A->B->A->B that consecutive matching misses
    if (recent.length >= 6) {
      var uniqueTools = {};
      for (var j = 0; j < recent.length; j++) {
        uniqueTools[recent[j].tool] = true;
      }
      var uniqueCount = Object.keys(uniqueTools).length;
      if (uniqueCount > 0 && recent.length / uniqueCount > 3.0) return true;
    }
    return false;
  }

  // ── Enhanced anti-pattern detection (inspired by agenttop) ───────────────

  var MARATHON_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes continuous
  var agentFirstSeen = {};      // agentId -> timestamp
  var agentErrorCount = {};     // agentId -> count of recent errors
  var agentCorrectionSpiral = {}; // agentId -> count of edit-then-re-edit same file

  function trackAgentPatterns(evt) {
    var aid = evt.agent_id || 'unknown';

    // Track session start
    if (!agentFirstSeen[aid]) agentFirstSeen[aid] = Date.now();

    // Track errors (failed tool calls)
    if (evt.event_type === 'PostToolUse') {
      var output = evt.tool_output;
      if (typeof output === 'string') {
        try { output = JSON.parse(output); } catch (e) { /* ignore */ }
      }
      var isError = false;
      if (typeof output === 'object' && output !== null) {
        isError = output.error || output.stderr || output.is_error;
      } else if (typeof output === 'string') {
        isError = output.indexOf('Error') !== -1 || output.indexOf('error') !== -1;
      }
      if (isError) {
        agentErrorCount[aid] = (agentErrorCount[aid] || 0) + 1;
      }
    }

    // Track correction spirals (editing same file repeatedly)
    if (evt.tool_name === 'Edit' || evt.tool_name === 'Write') {
      var input = evt.tool_input;
      if (typeof input === 'string') {
        try { input = JSON.parse(input); } catch (e) { /* ignore */ }
      }
      var filePath = input && input.file_path;
      if (filePath) {
        var recent = agentRecentTools[aid] || [];
        var editCount = 0;
        for (var i = recent.length - 1; i >= Math.max(0, recent.length - 6); i--) {
          if ((recent[i].tool === 'Edit' || recent[i].tool === 'Write') &&
              recent[i].input.indexOf(filePath) !== -1) {
            editCount++;
          }
        }
        if (editCount >= 3) {
          agentCorrectionSpiral[aid] = (agentCorrectionSpiral[aid] || 0) + 1;
        }
      }
    }
  }

  function isMarathonSession(agentId) {
    var first = agentFirstSeen[agentId];
    if (!first) return false;
    return (Date.now() - first) > MARATHON_THRESHOLD_MS;
  }

  function hasErrorBurst(agentId) {
    return (agentErrorCount[agentId] || 0) >= 5;
  }

  function hasCorrectionSpiral(agentId) {
    return (agentCorrectionSpiral[agentId] || 0) >= 2;
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
        else if (key !== 'innerHTML') el[key] = attrs[key];
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

  // ── Custom tooltip ─────────────────────────────────────────────────────────

  var $tooltip = createEl('div', { className: 'custom-tooltip hidden' });
  document.body.appendChild($tooltip);
  var tooltipHideTimer = null;

  function showTooltip(target) {
    var text = target.getAttribute('data-tooltip');
    if (!text) return;

    clearElement($tooltip);
    text.split('\n').forEach(function (line) {
      var parts = line.split(': ');
      var row = createEl('div', { className: 'tooltip-row' });
      if (parts.length >= 2) {
        row.appendChild(createEl('span', { className: 'tooltip-label', textContent: parts[0] + ':' }));
        row.appendChild(createEl('span', { className: 'tooltip-value', textContent: parts.slice(1).join(': ') }));
      } else {
        row.appendChild(createEl('span', { className: 'tooltip-value', textContent: line }));
      }
      $tooltip.appendChild(row);
    });

    // Position near the element
    var rect = target.getBoundingClientRect();
    var left = rect.right + 8;
    var top = rect.top;

    // If it would overflow right, show on left
    if (left + 280 > window.innerWidth) {
      left = rect.left - 288;
      if (left < 0) left = 8;
    }
    // If it would overflow bottom
    if (top + 160 > window.innerHeight) {
      top = window.innerHeight - 168;
    }

    $tooltip.style.left = left + 'px';
    $tooltip.style.top = top + 'px';
    $tooltip.classList.remove('hidden');
  }

  function hideTooltip() {
    $tooltip.classList.add('hidden');
  }

  // Show on mouseenter of elements with data-tooltip
  document.addEventListener('mouseenter', function (e) {
    var target = e.target.closest('[data-tooltip]');
    if (target) {
      if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; }
      showTooltip(target);
    }
  }, true);

  document.addEventListener('mouseleave', function (e) {
    var target = e.target.closest('[data-tooltip]');
    if (target) {
      tooltipHideTimer = setTimeout(hideTooltip, 150);
    }
  }, true);

  // Keep tooltip visible when hovering the tooltip itself
  $tooltip.addEventListener('mouseenter', function () {
    if (tooltipHideTimer) { clearTimeout(tooltipHideTimer); tooltipHideTimer = null; }
  });
  $tooltip.addEventListener('mouseleave', function () {
    tooltipHideTimer = setTimeout(hideTooltip, 150);
  });

  // Mobile: show on tap, hide on tap elsewhere
  document.addEventListener('touchstart', function (e) {
    var target = e.target.closest('[data-tooltip]');
    if (target) {
      showTooltip(target);
    } else if (!e.target.closest('.custom-tooltip')) {
      hideTooltip();
    }
  });

  // ── WebSocket ─────────────────────────────────────────────────────────────

  var wsFailCount = 0;

  function connectWebSocket() {
    var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(protocol + '//' + location.host);

    ws.onopen = function () {
      state.connected = true;
      wsFailCount = 0;
      renderConnectionStatus();
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    };

    ws.onclose = function (e) {
      state.connected = false;
      renderConnectionStatus();
      // Code 1008 = policy violation (auth rejected), or repeated failures = likely unauthorized
      wsFailCount++;
      if (e.code === 1008 || wsFailCount >= 3) {
        window.location.href = '/login';
        return;
      }
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
        state.events.forEach(function (e) { trackAgentActivity(e); trackAgentPatterns(e); });
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
        trackAgentPatterns(msg.data);
        scanForSecrets(msg.data);
        renderTimelineAppend(msg.data);
        scheduleUsageRefresh();
        break;
      case 'agent:update':
      case 'agent_update':
        // Clear stale alerts when agent disconnects
        if (msg.data && msg.data.status === 'disconnected') {
          clearAgentTracking(msg.data.id);
        }
        upsertAgent(msg.data);
        renderAgents();
        break;
      case 'mission:update':
      case 'mission_update':
        upsertMission(msg.data);
        renderMissions();
        break;
      case 'instruction:new':
        trackInstruction(msg.data);
        break;
      case 'instruction:delivered':
        markInstructionDelivered(msg.data);
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

  // ── Agents panel (tree hierarchy) ──────────────────────────────────────────

  // Clean display name: strip UUIDs, show meaningful label
  function agentDisplayName(agent) {
    // Prefer server-derived name (from agent-tracker.ts)
    if (agent.name) return agent.name;
    // If agent_id is "main", use session project or short ID
    var aid = agent.agent_id || '';
    if (aid === 'main') {
      if (agent.cwd) return agent.cwd.split('/').filter(Boolean).pop() || 'main';
      // Short session prefix instead of full UUID
      var sid = agent.session_id || agent.id || '';
      return sid.length > 12 ? 'Session ' + sid.slice(0, 8) : sid || 'main';
    }
    // Subagent: agent_id is usually a UUID — show short version
    return aid.length > 16 ? 'Sub-' + aid.slice(0, 6) : aid;
  }

  // Agent filter: 'all', 'active', 'idle'
  var agentFilter = 'all';

  function matchesAgentFilter(agent) {
    if (agentFilter === 'all') return true;
    if (agentFilter === 'active') return agent.status === 'active';
    if (agentFilter === 'idle') return agent.status === 'idle';
    return true;
  }

  // Wire up filter buttons
  var $agentFilters = document.getElementById('agent-filters');
  if ($agentFilters) {
    $agentFilters.addEventListener('click', function (e) {
      var btn = e.target.closest('.agent-filter-btn');
      if (!btn) return;
      e.stopPropagation(); // Don't trigger panel collapse
      var filter = btn.getAttribute('data-filter');
      if (!filter) return;
      agentFilter = filter;
      // Update active class
      $agentFilters.querySelectorAll('.agent-filter-btn').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-filter') === filter);
      });
      renderAgents();
    });
  }

  function buildAgentTree() {
    var sessions = {};
    var orphans = [];
    state.agents.forEach(function (agent) {
      var sid = agent.session_id || '';
      var aid = agent.agent_id || 'main';
      if (!sid) { orphans.push(agent); return; }
      if (!sessions[sid]) sessions[sid] = { main: null, subs: [] };
      if (aid === 'main') sessions[sid].main = agent;
      else sessions[sid].subs.push(agent);
    });
    return { sessions: sessions, orphans: orphans };
  }

  function buildAgentRow(agent, isSub, isLast, flatIdx) {
    var statusClass = agent.status || 'active';
    var name = agentDisplayName(agent);
    var focused = (state.activePanel === 0 && state.focusedRow[0] === flatIdx);
    var selected = (state.selectedAgentId === agent.id);
    var rowClass = 'agent-row' + (focused ? ' focused' : '') + (selected ? ' selected' : '') + (isSub ? ' subagent' : ' main-agent');

    var dotChar = STATUS_DOTS[statusClass] || STATUS_DOTS.disconnected;
    var dot = createEl('span', { className: 'agent-dot ' + statusClass, textContent: dotChar });
    var nameEl = createEl('span', { className: 'agent-name', textContent: name });
    var timeEl = createEl('span', { className: 'agent-time', textContent: timeAgo(agent.last_seen_at) });

    var topChildren = [dot, nameEl];

    // Sub-count badge (clickable toggle) for main agents with children
    if (!isSub && agent._subCount > 0) {
      var chevron = agent._sessionCollapsed ? '\u25B8' : '\u25BE'; // ▸ or ▾
      var toggleEl = createEl('span', {
        className: 'agent-sub-toggle',
        textContent: chevron + ' ' + agent._subCount + ' sub'
      });
      topChildren.push(toggleEl);
    }

    // Alert badges
    if (statusClass === 'active' && isAgentStuck(agent.id)) {
      topChildren.push(createEl('span', { className: 'agent-alert stuck', textContent: '! STUCK' }));
    } else if (isAgentLooping(agent.id)) {
      topChildren.push(createEl('span', { className: 'agent-alert loop', textContent: '! LOOP' }));
    } else if (typeof hasCorrectionSpiral === 'function' && hasCorrectionSpiral(agent.id)) {
      topChildren.push(createEl('span', { className: 'agent-alert spiral', textContent: '! SPIRAL' }));
    } else if (typeof hasErrorBurst === 'function' && hasErrorBurst(agent.id)) {
      topChildren.push(createEl('span', { className: 'agent-alert errors', textContent: '! ERRORS' }));
    } else if (typeof isMarathonSession === 'function' && isMarathonSession(agent.id)) {
      topChildren.push(createEl('span', { className: 'agent-alert marathon', textContent: 'MARATHON' }));
    }

    topChildren.push(timeEl);
    var topRow = createEl('div', { className: 'agent-row-top' }, topChildren);
    var children = [topRow];

    if (selected && agent.cwd) {
      children.push(createEl('div', { className: 'agent-activity cwd', textContent: agent.cwd }));
    }

    // Live activity line — show current tool + target
    var currentAct = getAgentCurrentActivity(agent.id);
    var activity = '';
    if (statusClass === 'active' && isAgentStuck(agent.id)) {
      activity = 'no activity for ' + timeAgo(agent.last_seen_at) + ' — check terminal';
    } else if (currentAct && statusClass === 'active') {
      activity = currentAct.tool + (currentAct.target ? ' ' + currentAct.target : '');
    } else if (statusClass === 'idle') {
      activity = 'idle ' + timeAgo(agent.last_seen_at);
    } else if (agent.current_tool) {
      activity = agent.current_tool;
    }
    if (activity) {
      children.push(createEl('div', { className: 'agent-activity', textContent: activity }));
    }

    // Stats line — diff stats, files touched, session duration
    var diff = getAgentDiffStats(agent.id);
    var fileCount = getAgentFileCount(agent.id);
    var statParts = [];
    if (diff.added > 0 || diff.removed > 0) {
      statParts.push('+' + diff.added + ' -' + diff.removed);
    }
    if (fileCount > 0) {
      statParts.push(fileCount + ' file' + (fileCount !== 1 ? 's' : ''));
    }
    if (agent.first_seen_at) {
      statParts.push(elapsed(agent.first_seen_at));
    }
    if (statParts.length > 0) {
      children.push(createEl('div', { className: 'agent-stats', textContent: statParts.join('  ·  ') }));
    }

    // Quick-action buttons (visible on hover)
    var quickActions = createEl('div', { className: 'agent-quick-actions' });

    if (agent.cwd) {
      var copyPathBtn = createEl('button', { className: 'agent-quick-btn', textContent: '\u2398 Copy Path' });
      (function (cwd) {
        copyPathBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          navigator.clipboard.writeText(cwd).then(function () {
            showToast('Copied: ' + cwd);
          }).catch(function () {
            // Fallback for non-HTTPS
            var ta = document.createElement('textarea');
            ta.value = cwd;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            showToast('Copied: ' + cwd);
          });
        });
      })(agent.cwd);
      quickActions.appendChild(copyPathBtn);
    }

    if (agent.session_id) {
      var copyIdBtn = createEl('button', { className: 'agent-quick-btn', textContent: '\u2397 Copy ID' });
      (function (sid) {
        copyIdBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          navigator.clipboard.writeText(sid).then(function () {
            showToast('Copied session ID');
          }).catch(function () {
            var ta = document.createElement('textarea');
            ta.value = sid;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
            showToast('Copied session ID');
          });
        });
      })(agent.session_id);
      quickActions.appendChild(copyIdBtn);
    }

    if (quickActions.childNodes.length > 0) {
      children.push(quickActions);
    }

    // Store tooltip data for custom tooltip
    var tipParts = [];
    if (agent.name) tipParts.push('Name: ' + agent.name);
    tipParts.push('ID: ' + agent.id);
    if (agent.session_id) tipParts.push('Session: ' + agent.session_id);
    if (agent.cwd) tipParts.push('Path: ' + agent.cwd);
    if (agent.model) tipParts.push('Model: ' + agent.model);
    tipParts.push('Status: ' + statusClass);
    if (agent.current_tool) tipParts.push('Activity: ' + agent.current_tool);
    if (agent.current_mission_id) tipParts.push('Mission: ' + agent.current_mission_id);

    var row = createEl('div', { className: rowClass, 'data-agent-id': agent.id }, children);
    row.setAttribute('data-tooltip', tipParts.join('\n'));
    return row;
  }

  // Track collapsed sessions (persisted)
  var SESSION_COLLAPSE_KEY = 'mc_session_collapsed';
  var collapsedSessions = {};
  try {
    var saved = localStorage.getItem(SESSION_COLLAPSE_KEY);
    if (saved) collapsedSessions = JSON.parse(saved);
  } catch (e) {}

  function toggleSessionCollapse(sid) {
    collapsedSessions[sid] = !collapsedSessions[sid];
    try { localStorage.setItem(SESSION_COLLAPSE_KEY, JSON.stringify(collapsedSessions)); } catch (e) {}
    renderAgents();
  }

  function renderAgents() {
    // Show filtered count vs total
    var activeCount = state.agents.filter(function (a) { return a.status === 'active'; }).length;
    var totalCount = state.agents.length;
    $agentsBadge.textContent = agentFilter === 'all' ? totalCount : activeCount + '/' + totalCount;
    clearElement($agentsList);

    if (state.agents.length === 0) {
      $agentsList.appendChild(createEl('div', { className: 'empty-state', textContent: 'No agents connected' }));
      return;
    }

    var tree = buildAgentTree();
    var flatIdx = 0;
    var sessionIds = Object.keys(tree.sessions);
    var visibleCount = 0;

    sessionIds.forEach(function (sid) {
      var group = tree.sessions[sid];
      var main = group.main;
      var subs = group.subs;
      var isCollapsed = !!collapsedSessions[sid];

      // Filter: skip entire session if no agents match
      var mainMatches = main && matchesAgentFilter(main);
      var matchingSubs = subs.filter(matchesAgentFilter);
      if (!mainMatches && matchingSubs.length === 0) {
        // Still increment flatIdx for hidden agents
        if (main) flatIdx++;
        flatIdx += subs.length;
        return;
      }

      var container = createEl('div', { className: 'agent-group' + (isCollapsed ? ' session-collapsed' : '') });

      // Main agent row
      if (main) {
        main._subCount = subs.length;
        main._sessionCollapsed = isCollapsed;
        var mainRow = buildAgentRow(main, false, false, flatIdx++);
        container.appendChild(mainRow);
      } else {
        var label = 'Session ' + sid.slice(0, 8);
        var labelEl = createEl('div', { className: 'agent-group-label', textContent: label });
        if (subs.length > 0) {
          var toggleEl = createEl('span', {
            className: 'session-toggle',
            textContent: isCollapsed ? '\u25B8 ' + subs.length + ' sub' : '\u25BE ' + subs.length + ' sub'
          });
          labelEl.appendChild(toggleEl);
        }
        container.appendChild(labelEl);
      }

      // Toggle click on the sub-count badge or main row
      (function (capturedSid) {
        container.addEventListener('click', function (e) {
          var toggle = e.target.closest('.agent-sub-toggle');
          if (toggle) {
            e.stopPropagation();
            toggleSessionCollapse(capturedSid);
          }
        });
      })(sid);

      // Subagents nested underneath (hidden when collapsed)
      if (subs.length > 0 && !isCollapsed) {
        var subContainer = createEl('div', { className: 'agent-subs' });
        subs.forEach(function (sub, j) {
          sub._subCount = 0;
          subContainer.appendChild(buildAgentRow(sub, true, j === subs.length - 1, flatIdx++));
        });
        container.appendChild(subContainer);
      } else if (subs.length > 0 && isCollapsed) {
        // Still count flatIdx for collapsed subs so keyboard nav stays consistent
        flatIdx += subs.length;
      }

      $agentsList.appendChild(container);
    });

    tree.orphans.forEach(function (agent) {
      agent._subCount = 0;
      $agentsList.appendChild(buildAgentRow(agent, false, true, flatIdx++));
    });
  }

  // ── Missions panel ────────────────────────────────────────────────────────

  var expandedMissionId = null;

  function patchMission(missionId, fields) {
    return fetch('/api/missions/' + missionId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
      credentials: 'include',
    }).then(function (res) {
      if (!res.ok) return res.json().then(function (b) { showToast('Error: ' + (b.error || res.status)); });
      return res.json().then(function (updated) {
        upsertMission(updated);
        renderMissions();
        updateHeaderStats();
      });
    }).catch(function () { showToast('Failed to update mission'); });
  }

  function deleteMission(missionId) {
    return fetch('/api/missions/' + missionId, {
      method: 'DELETE',
      credentials: 'include',
    }).then(function (res) {
      if (res.ok) {
        state.missions = state.missions.filter(function (m) { return m.id !== missionId; });
        expandedMissionId = null;
        renderMissions();
        updateHeaderStats();
        showToast('Mission deleted');
      } else {
        return res.json().then(function (b) { showToast('Error: ' + (b.error || res.status)); });
      }
    }).catch(function () { showToast('Failed to delete mission'); });
  }

  function buildMissionActions(mission) {
    var status = mission.status || 'queued';
    var actions = createEl('div', { className: 'mission-actions' });

    if (status === 'queued') {
      // Assign to agent — show a select with active agents
      var activeAgents = state.agents.filter(function (a) { return a.status === 'active'; });
      if (activeAgents.length > 0) {
        var select = createEl('select', { className: 'mission-agent-select' });
        select.appendChild(createEl('option', { textContent: 'Assign to...', className: 'placeholder-opt' }));
        select.options[0].disabled = true;
        select.options[0].selected = true;
        activeAgents.forEach(function (agent) {
          var label = agentDisplayName(agent);
          select.appendChild(createEl('option', { textContent: label }));
          select.options[select.options.length - 1].value = agent.id;
        });
        select.addEventListener('change', function () {
          if (select.value) {
            patchMission(mission.id, { assigned_agent_id: select.value, status: 'active' });
          }
        });
        actions.appendChild(select);
      }

      // Start without agent
      var startBtn = createEl('button', { className: 'mission-action-btn start', textContent: '\u25B6 START' });
      startBtn.addEventListener('click', function () { patchMission(mission.id, { status: 'active' }); });
      actions.appendChild(startBtn);

      // Delete
      var delBtn = createEl('button', { className: 'mission-action-btn danger', textContent: '\u2715 DELETE' });
      delBtn.addEventListener('click', function () { deleteMission(mission.id); });
      actions.appendChild(delBtn);
    }

    if (status === 'active') {
      // Complete
      var completeBtn = createEl('button', { className: 'mission-action-btn success', textContent: '\u2713 COMPLETE' });
      completeBtn.addEventListener('click', function () { patchMission(mission.id, { status: 'completed', result: 'Completed from dashboard' }); });
      actions.appendChild(completeBtn);

      // Fail
      var failBtn = createEl('button', { className: 'mission-action-btn danger', textContent: '\u2715 FAIL' });
      failBtn.addEventListener('click', function () { patchMission(mission.id, { status: 'failed', result: 'Failed from dashboard' }); });
      actions.appendChild(failBtn);
    }

    if (status === 'blocked') {
      // Force unblock
      var unblockBtn = createEl('button', { className: 'mission-action-btn', textContent: '\u21AA UNBLOCK' });
      unblockBtn.addEventListener('click', function () { patchMission(mission.id, { status: 'queued' }); });
      actions.appendChild(unblockBtn);
    }

    if (status === 'completed' || status === 'failed') {
      // Requeue
      var requeueBtn = createEl('button', { className: 'mission-action-btn', textContent: '\u21BB REQUEUE' });
      requeueBtn.addEventListener('click', function () { patchMission(mission.id, { status: 'queued', assigned_agent_id: null }); });
      actions.appendChild(requeueBtn);
    }

    return actions;
  }

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
      var isExpanded = expandedMissionId === mission.id;
      var rowClass = 'mission-row' + (focused ? ' focused' : '') + (isExpanded ? ' expanded' : '');

      var tag = createEl('span', { className: 'status-tag ' + status, textContent: status.toUpperCase() });
      var titleEl = createEl('span', { className: 'mission-title', textContent: mission.title });

      // Meta: agent assignment + elapsed time
      var metaText = '';
      if (mission.assigned_agent_id) {
        var assignedAgent = state.agents.find(function (a) { return a.id === mission.assigned_agent_id; });
        var agentLabel = assignedAgent ? agentDisplayName(assignedAgent) : mission.assigned_agent_id;
        metaText = '\u2190 ' + agentLabel;
        if (mission.started_at && status === 'active') {
          metaText += '  ' + elapsed(mission.started_at);
        }
      } else if (mission.completed_at && status === 'completed') {
        metaText = 'completed ' + timeAgo(mission.completed_at);
      } else if (mission.completed_at && status === 'failed') {
        metaText = 'failed ' + timeAgo(mission.completed_at);
      } else if (mission.priority) {
        metaText = 'priority: ' + (mission.priority > 5 ? 'HIGH' : mission.priority > 2 ? 'MED' : 'LOW');
      }

      var metaEl = metaText ? createEl('span', { className: 'mission-meta', textContent: metaText }) : null;
      var topRow = createEl('div', { className: 'mission-top' }, [tag, titleEl, metaEl].filter(Boolean));

      var children = [topRow];

      // Description (show when expanded)
      if (isExpanded && mission.description) {
        children.push(createEl('div', { className: 'mission-desc', textContent: mission.description }));
      }

      // Result (show when expanded and completed/failed)
      if (isExpanded && mission.result && (status === 'completed' || status === 'failed')) {
        children.push(createEl('div', { className: 'mission-result', textContent: 'Result: ' + mission.result }));
      }

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

      // Subtask progress bar
      if (mission.subtasks) {
        var subtasks = mission.subtasks;
        if (typeof subtasks === 'string') {
          try { subtasks = JSON.parse(subtasks); } catch (e) { subtasks = null; }
        }
        if (Array.isArray(subtasks) && subtasks.length > 0) {
          var done = subtasks.filter(function (s) { return s.done; }).length;
          var total = subtasks.length;
          var pct = Math.round((done / total) * 100);
          var progressFill = createEl('div', { className: 'subtask-progress-fill', style: 'width:' + pct + '%' });
          var progressBar = createEl('div', { className: 'subtask-progress-bar' }, [progressFill]);
          var progressLabel = createEl('span', { className: 'subtask-progress-label', textContent: done + '/' + total });
          children.push(createEl('div', { className: 'subtask-progress' }, [progressBar, progressLabel]));
        }
      }

      // Action buttons (show when expanded)
      if (isExpanded) {
        children.push(buildMissionActions(mission));
      }

      var row = createEl('div', { className: rowClass, 'data-mission-id': mission.id }, children);
      $missionsList.appendChild(row);
    });
  }

  // Click to expand/collapse mission
  $missionsList.addEventListener('click', function (e) {
    // Don't toggle if clicking an action button or select
    if (e.target.closest('.mission-action-btn, .mission-agent-select')) return;
    var row = e.target.closest('[data-mission-id]');
    if (!row) return;
    var id = row.getAttribute('data-mission-id');
    expandedMissionId = (expandedMissionId === id) ? null : id;
    renderMissions();
  });

  // ── Timeline panel ────────────────────────────────────────────────────────

  // Smarter per-tool-type summary (inspired by disler's toolInfo pattern)
  function getEventDetail(evt) {
    var input = evt.tool_input;
    if (!input) return evt.event_type === 'Stop' ? 'session ended' : '';
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch (e) { return ''; }
    }
    var toolName = evt.tool_name || '';

    // File tools: show last 2 path segments
    if (input.file_path) {
      var shortPath = input.file_path.split('/').slice(-2).join('/');
      if (toolName === 'Edit' && input.old_string) return shortPath + ' (edit)';
      if (toolName === 'Write') return shortPath + ' (write)';
      return shortPath;
    }
    // Bash: show command, truncated
    if (input.command) {
      var cmd = input.command;
      if (input.description) return input.description;
      return cmd.length > 60 ? cmd.substring(0, 57) + '...' : cmd;
    }
    // Search tools
    if (input.pattern) {
      var search = input.pattern;
      if (input.path) search += ' in ' + input.path.split('/').pop();
      return search.length > 60 ? search.substring(0, 57) + '...' : search;
    }
    // Agent tool
    if (input.prompt) return (input.description || input.prompt.substring(0, 50) + '...');
    // Task tools
    if (input.description) return input.description;
    // SendMessage
    if (input.to) return '-> ' + input.to;
    // WebFetch/WebSearch
    if (input.url) return input.url.length > 60 ? input.url.substring(0, 57) + '...' : input.url;
    if (input.query) return input.query;
    // Skill
    if (input.skill) return input.skill;
    return '';
  }

  function getExpandedDetail(evt) {
    var parts = [];
    var input = evt.tool_input;
    if (input) {
      if (typeof input === 'string') {
        try { input = JSON.parse(input); } catch (e) { /* keep string */ }
      }
      if (typeof input === 'object' && input !== null) {
        if (input.file_path) parts.push('File: ' + input.file_path);
        if (input.command) parts.push('Cmd: ' + input.command);
        if (input.pattern) parts.push('Pattern: ' + input.pattern);
        if (input.content) parts.push('Content: ' + String(input.content).slice(0, 200) + (String(input.content).length > 200 ? '...' : ''));
        if (input.old_string) parts.push('Replace: ' + String(input.old_string).slice(0, 100) + ' → ' + String(input.new_string || '').slice(0, 100));
      }
    }
    var output = evt.tool_output;
    if (output) {
      if (typeof output === 'string') {
        try { output = JSON.parse(output); } catch (e) { /* keep string */ }
      }
      if (typeof output === 'string' && output.length > 0) {
        parts.push('Output: ' + output.slice(0, 200) + (output.length > 200 ? '...' : ''));
      } else if (typeof output === 'object' && output !== null) {
        if (output.error) parts.push('Error: ' + String(output.error).slice(0, 200));
        if (output.stderr) parts.push('Stderr: ' + String(output.stderr).slice(0, 200));
      }
    }
    return parts.join('\n');
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

    var row = createEl('div', { className: 'timeline-row' }, [timeEl, agentEl, toolEl, detailEl]);

    // Expandable: click to show full input/output
    if (evt.tool_input || evt.tool_output) {
      row.style.cursor = 'pointer';
      row.addEventListener('click', function () {
        var existing = row.querySelector('.timeline-expanded');
        if (existing) {
          existing.remove();
          row.classList.remove('expanded');
          return;
        }
        var expanded = getExpandedDetail(evt);
        if (expanded) {
          var expandEl = createEl('pre', { className: 'timeline-expanded', textContent: expanded });
          row.appendChild(expandEl);
          row.classList.add('expanded');
        }
      });
    }

    return row;
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

    // ── Context window health for active sessions (inspired by claude-hud) ──
    if (hasTokens && tokenData.activeSessions > 0) {
      var activeSessions = tokenData.sessions.filter(function (s) { return s.isActive; });
      if (activeSessions.length > 0) {
        var ctxSection = createEl('div', { className: 'usage-section' });
        ctxSection.appendChild(createEl('div', { className: 'usage-section-title', textContent: 'Active Sessions — Context Health' }));

        activeSessions.forEach(function (s) {
          var pct = s.contextWindowPercent || 0;
          var colorClass = pct >= 85 ? 'ctx-danger' : pct >= 60 ? 'ctx-warning' : 'ctx-ok';
          var sid = s.sessionId.length > 10 ? s.sessionId.slice(0, 8) + '..' : s.sessionId;
          var modelShort = (s.model || 'unknown').replace('claude-', '');

          var fill = createEl('div', { className: 'ctx-bar-fill ' + colorClass, style: 'width:' + pct + '%' });
          var track = createEl('div', { className: 'ctx-bar-track' }, [fill]);

          var row = createEl('div', { className: 'ctx-row' }, [
            createEl('span', { className: 'ctx-label', textContent: sid, title: s.sessionId }),
            createEl('span', { className: 'ctx-model', textContent: modelShort }),
            track,
            createEl('span', { className: 'ctx-pct ' + colorClass, textContent: pct + '%' }),
            createEl('span', { className: 'ctx-tokens', textContent: formatTokens(s.contextWindowUsed) }),
          ]);
          ctxSection.appendChild(row);
        });
        $usageList.appendChild(ctxSection);
      }
    }

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

  // ── Instruction tracking ─────────────────────────────────────────────────
  // Show sent instructions with delivery status so user knows if agent received them.

  var sentInstructions = []; // { id, message, status, target_agent_id, created_at }
  var MAX_INSTRUCTION_LOG = 5;

  function trackInstruction(instr) {
    sentInstructions.unshift({
      id: instr.id,
      message: instr.message,
      status: 'pending',
      target: instr.target_agent_id,
      time: instr.created_at || new Date().toISOString(),
    });
    if (sentInstructions.length > MAX_INSTRUCTION_LOG) sentInstructions.pop();
    renderInstructionLog();
  }

  function markInstructionDelivered(instr) {
    var found = sentInstructions.find(function (s) { return s.id === instr.id; });
    if (found) {
      found.status = 'delivered';
      renderInstructionLog();
      showToast('\u2713 Agent received: "' + found.message.slice(0, 40) + (found.message.length > 40 ? '...' : '') + '"');
    }
  }

  function renderInstructionLog() {
    var $log = document.getElementById('instruction-log');
    if (!$log) return;
    clearElement($log);

    if (sentInstructions.length === 0) return;

    sentInstructions.forEach(function (instr) {
      var statusText = instr.status === 'delivered' ? '\u2713 delivered' : '\u25CB pending...';
      var statusClass = 'instr-status ' + instr.status;

      var row = createEl('div', { className: 'instr-log-row' }, [
        createEl('span', { className: statusClass, textContent: statusText }),
        createEl('span', { className: 'instr-msg', textContent: instr.message.length > 50 ? instr.message.slice(0, 47) + '...' : instr.message }),
        createEl('span', { className: 'instr-time', textContent: formatTime(instr.time) }),
      ]);
      $log.appendChild(row);
    });
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

  // ? HELP button click handler
  var $kbdHint = document.querySelector('.kbd-hint');
  if ($kbdHint) {
    $kbdHint.addEventListener('click', function () {
      $kbdHelp.classList.toggle('hidden');
    });
  }

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
    formatTime: formatTime,
    createEl: createEl,
    clearElement: clearElement,
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

  // ── Browser notifications (from disler) ────────────────────────────────

  var notificationsEnabled = false;
  var notifiedAgents = {}; // agentId -> last notification type

  function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then(function (perm) {
        notificationsEnabled = (perm === 'granted');
      });
    } else {
      notificationsEnabled = (Notification.permission === 'granted');
    }
  }

  function notifyAgentIssue(agentId, issue) {
    if (!notificationsEnabled) return;
    if (notifiedAgents[agentId] === issue) return; // don't spam
    notifiedAgents[agentId] = issue;
    try {
      var n = new Notification('Agent Alert: ' + issue, {
        body: 'Agent ' + agentId + ' — ' + issue,
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">⚠️</text></svg>',
        requireInteraction: true,
      });
      n.onclick = function () { window.focus(); n.close(); };
      // Auto-close after 15s
      setTimeout(function () { n.close(); }, 15000);
    } catch (e) { /* ignore */ }
  }

  // Check agents for issues and fire notifications
  function checkAgentNotifications() {
    state.agents.forEach(function (agent) {
      if (agent.status !== 'active') return;
      if (isAgentStuck(agent.id)) {
        notifyAgentIssue(agent.id, 'STUCK — no activity');
      } else if (isAgentLooping(agent.id)) {
        notifyAgentIssue(agent.id, 'LOOP detected');
      } else if (hasCorrectionSpiral(agent.id)) {
        notifyAgentIssue(agent.id, 'Correction spiral');
      } else if (hasErrorBurst(agent.id)) {
        notifyAgentIssue(agent.id, 'Error burst (5+ failures)');
      } else {
        delete notifiedAgents[agent.id]; // Clear when resolved
      }
    });
  }

  // ── Visibility-aware polling (from builderz) ──────────────────────────

  var tabVisible = true;
  var pendingRefreshOnVisible = false;

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      tabVisible = false;
    } else {
      tabVisible = true;
      if (pendingRefreshOnVisible) {
        pendingRefreshOnVisible = false;
        renderAgents();
        fetchUsage();
      }
    }
  });

  // ── Secret scanner (from builderz) ────────────────────────────────────

  var SECRET_PATTERNS = [
    { name: 'AWS Key', pattern: /AKIA[0-9A-Z]{16}/ },
    { name: 'AWS Secret', pattern: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY|aws_secret)\s*[:=]\s*['"]?[0-9a-zA-Z/+]{40}/i },
    { name: 'GitHub Token', pattern: /gh[ps]_[A-Za-z0-9_]{36,}/ },
    { name: 'Anthropic Key', pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/ },
    { name: 'OpenAI Key', pattern: /sk-[a-zA-Z0-9]{20,}/ },
    { name: 'Stripe Key', pattern: /sk_live_[a-zA-Z0-9]{20,}/ },
    { name: 'Slack Token', pattern: /xox[bpors]-[0-9a-zA-Z-]{10,}/ },
    { name: 'Private Key', pattern: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/ },
    { name: 'JWT', pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
    { name: 'Generic Secret', pattern: /(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"][A-Za-z0-9_\-/.]{16,}['"]/i },
  ];

  var secretAlerts = []; // { agentId, secretType, timestamp }

  function scanForSecrets(evt) {
    if (!evt.tool_output) return;
    var output = typeof evt.tool_output === 'string' ? evt.tool_output : JSON.stringify(evt.tool_output);
    for (var i = 0; i < SECRET_PATTERNS.length; i++) {
      if (SECRET_PATTERNS[i].pattern.test(output)) {
        secretAlerts.push({
          agentId: evt.agent_id || 'unknown',
          secretType: SECRET_PATTERNS[i].name,
          timestamp: evt.timestamp || new Date().toISOString(),
        });
        // Keep last 50 alerts
        if (secretAlerts.length > 50) secretAlerts.shift();
        showToast('SECRET DETECTED: ' + SECRET_PATTERNS[i].name + ' in tool output!');
        break; // One alert per event
      }
    }
  }

  // ── Initialize ────────────────────────────────────────────────────────────

  renderConnectionStatus();
  updateHeaderStats();
  setActivePanel(0);
  connectWebSocket();
  fetchUsage();
  requestNotificationPermission();

  // Set initial mobile state
  if (isMobile()) {
    setMobileTab('agents');
  }

  // Uptime counter — update every second
  setInterval(updateUptime, 1000);

  // Refresh agent displays every 10s (time-ago + stuck detection)
  // Visibility-aware: skip when tab is hidden
  setInterval(function () {
    if (tabVisible) {
      renderAgents();
      checkAgentNotifications();
    } else {
      pendingRefreshOnVisible = true;
    }
  }, 10000);

  // Refresh usage stats every 30s (visibility-aware)
  setInterval(function () {
    if (tabVisible) {
      fetchUsage();
    } else {
      pendingRefreshOnVisible = true;
    }
  }, 30000);

})();
