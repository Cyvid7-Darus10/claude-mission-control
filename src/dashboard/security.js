// ── Security System ───────────────────────────────────────────────────────────
// 7-layer defense visualization with animated radar and threat detection.
// Loaded after app.js — extends the global MissionControl object.

(function () {
  'use strict';

  // Wait for app.js to initialize
  var MC = window.MissionControl;
  if (!MC) {
    console.warn('[security] MissionControl not found, security module disabled');
    return;
  }

  // ── State ─────────────────────────────────────────────────────────────────

  var securityEvents = [];
  var layerStatus = {}; // layer# -> 'ok'|'warn'|'critical'

  // ── DOM refs ──────────────────────────────────────────────────────────────

  var $securityBtn = document.getElementById('security-btn');
  var $securityCount = document.getElementById('security-count');
  var $securityOverlay = document.getElementById('security-overlay');
  var $securityClose = document.getElementById('security-close');
  var $securityLog = document.getElementById('security-log');
  var $radarBlips = document.getElementById('radar-blips');

  // ── Layer 7: Client-side tool scanning ────────────────────────────────────

  var DANGEROUS_PATTERNS = [
    { pattern: /rm\s+-rf\s+[\/~]/, label: 'destructive rm -rf' },
    { pattern: /rm\s+-rf\s+\*/, label: 'wildcard rm -rf' },
    { pattern: /chmod\s+777/, label: 'insecure chmod 777' },
    { pattern: /curl\s+.*\|\s*(ba)?sh/, label: 'pipe to shell' },
    { pattern: /wget\s+.*\|\s*(ba)?sh/, label: 'pipe to shell' },
    // Note: this detects the literal string "eval(" in tool commands, not JS eval
    { pattern: /eval\s*\(/, label: 'eval() usage detected' },
    { pattern: />(\/etc\/passwd|\/etc\/shadow)/, label: 'system file write' },
    { pattern: /DROP\s+TABLE|DELETE\s+FROM.*WHERE\s+1/i, label: 'destructive SQL' },
    { pattern: /--no-verify/, label: 'hook bypass attempt' },
    { pattern: /PRIVATE.KEY|BEGIN RSA|sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,}/, label: 'secret/key exposure' },
  ];

  var SENSITIVE_PATHS = [
    /\.env($|\.)/, /\.ssh\//, /id_rsa/, /credentials/, /\.aws\//, /secrets?\./,
    /\.gnupg\//, /\.npmrc/, /\.netrc/, /token\.json/,
  ];

  function scanToolEvent(evt) {
    var input = evt.tool_input;
    if (!input) return;
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch (e) { return; }
    }

    if (input.command) {
      for (var i = 0; i < DANGEROUS_PATTERNS.length; i++) {
        if (DANGEROUS_PATTERNS[i].pattern.test(input.command)) {
          handleSecurityEvent({
            layer: 7, layerName: 'TOOL SCAN', severity: 'warn',
            message: 'Suspicious: ' + DANGEROUS_PATTERNS[i].label,
            detail: input.command.substring(0, 60),
            timestamp: evt.timestamp || new Date().toISOString(),
          });
          return;
        }
      }
    }

    if (input.file_path) {
      for (var j = 0; j < SENSITIVE_PATHS.length; j++) {
        if (SENSITIVE_PATHS[j].test(input.file_path)) {
          handleSecurityEvent({
            layer: 7, layerName: 'TOOL SCAN', severity: 'info',
            message: 'Sensitive file access',
            detail: input.file_path.split('/').slice(-2).join('/'),
            timestamp: evt.timestamp || new Date().toISOString(),
          });
          return;
        }
      }
    }
  }

  // ── Security event handling ───────────────────────────────────────────────

  function handleSecurityEvent(evt) {
    securityEvents.push(evt);
    if (securityEvents.length > 100) securityEvents = securityEvents.slice(-100);

    // Escalate layer status (never downgrade)
    var cur = layerStatus[evt.layer] || 'ok';
    if (evt.severity === 'critical') layerStatus[evt.layer] = 'critical';
    else if (evt.severity === 'warn' && cur !== 'critical') layerStatus[evt.layer] = 'warn';

    updateShield();
    addRadarBlip(evt);

    if ($securityOverlay && !$securityOverlay.classList.contains('hidden')) {
      renderLog();
      renderLayers();
    }

    if (evt.severity === 'critical' && MC.showToast) {
      MC.showToast('SECURITY: ' + evt.message);
    }

    if ($securityCount) $securityCount.textContent = securityEvents.length;
  }

  // ── Shield button ─────────────────────────────────────────────────────────

  function updateShield() {
    if (!$securityBtn) return;
    var hasCrit = securityEvents.some(function (e) { return e.severity === 'critical'; });
    var hasWarn = securityEvents.some(function (e) { return e.severity === 'warn'; });

    $securityBtn.classList.remove('has-critical', 'has-warnings');
    var lbl = $securityBtn.querySelector('.shield-label');

    if (hasCrit) {
      $securityBtn.classList.add('has-critical');
      lbl.textContent = 'THREAT';
    } else if (hasWarn) {
      $securityBtn.classList.add('has-warnings');
      lbl.textContent = 'ALERT';
    } else {
      lbl.textContent = 'SECURE';
    }
  }

  // ── Radar blips ───────────────────────────────────────────────────────────

  function addRadarBlip(evt) {
    if (!$radarBlips) return;

    // Place blip at a random position — severity determines distance from center
    // Critical = closer to center (more threatening), info = outer rings
    var angle = Math.random() * Math.PI * 2;
    var minR, maxR;
    if (evt.severity === 'critical') { minR = 15; maxR = 40; }
    else if (evt.severity === 'warn') { minR = 30; maxR = 60; }
    else { minR = 50; maxR = 80; }
    var radius = minR + Math.random() * (maxR - minR);
    var cx = 100 + Math.cos(angle) * radius;
    var cy = 100 + Math.sin(angle) * radius;

    var svgNS = 'http://www.w3.org/2000/svg';

    // Expanding ring (sonar pulse effect)
    var ring = document.createElementNS(svgNS, 'circle');
    ring.setAttribute('cx', String(cx));
    ring.setAttribute('cy', String(cy));
    ring.setAttribute('r', '4');
    ring.setAttribute('class', 'radar-blip-ring ' + evt.severity);
    $radarBlips.appendChild(ring);

    // Main blip dot
    var blip = document.createElementNS(svgNS, 'circle');
    blip.setAttribute('cx', String(cx));
    blip.setAttribute('cy', String(cy));
    blip.setAttribute('r', evt.severity === 'critical' ? '5' : '3');
    blip.setAttribute('class', 'radar-blip ' + evt.severity);
    $radarBlips.appendChild(blip);

    // Clean up after animation completes
    var duration = evt.severity === 'critical' ? 6000 : 4000;
    setTimeout(function () { blip.remove(); }, duration);
    setTimeout(function () { ring.remove(); }, 2500);
  }

  // ── Render helpers (reuse from app.js via MissionControl) ─────────────────

  var formatTime = MC.formatTime;
  var createEl = MC.createEl;
  var clearElement = MC.clearElement;

  function dismissEvent(index) {
    securityEvents.splice(index, 1);
    if ($securityCount) $securityCount.textContent = securityEvents.length;
    updateShield();
    renderLog();
    renderLayers();
  }

  function clearAllEvents() {
    securityEvents.length = 0;
    layerStatus = {};
    if ($securityCount) $securityCount.textContent = '0';
    updateShield();
    renderLog();
    renderLayers();
  }

  function renderLog() {
    if (!$securityLog) return;
    clearElement($securityLog);

    if (securityEvents.length === 0) {
      $securityLog.appendChild(createEl('div', { className: 'empty-state', textContent: 'No security events' }));
      // Hide clear-all when empty
      var clearBtn = document.getElementById('security-clear-all');
      if (clearBtn) clearBtn.classList.add('hidden');
      return;
    }

    // Show clear-all
    var clearBtn = document.getElementById('security-clear-all');
    if (clearBtn) clearBtn.classList.remove('hidden');

    // Newest first, track original index for dismiss
    for (var i = securityEvents.length - 1; i >= 0; i--) {
      var evt = securityEvents[i];
      var idx = i;

      var dismissBtn = createEl('button', { className: 'sec-event-dismiss', textContent: '\u00d7' });
      (function (capturedIdx) {
        dismissBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          dismissEvent(capturedIdx);
        });
      })(idx);

      var row = createEl('div', { className: 'sec-event-row' }, [
        createEl('span', { className: 'sec-event-time', textContent: formatTime(evt.timestamp) }),
        createEl('span', { className: 'sec-event-layer ' + evt.severity, textContent: 'L' + evt.layer }),
        createEl('span', { className: 'sec-event-msg', textContent: evt.message }),
        evt.detail ? createEl('span', { className: 'sec-event-detail', textContent: evt.detail }) : null,
        dismissBtn,
      ].filter(Boolean));

      $securityLog.appendChild(row);
    }
  }

  function renderLayers() {
    for (var i = 1; i <= 7; i++) {
      var el = document.getElementById('layer-' + i);
      if (!el) continue;
      var s = layerStatus[i] || 'ok';
      el.className = 'layer-status ' + s;
      el.textContent = s === 'ok' ? '\u2713' : s === 'warn' ? '!' : '\u2717';
    }
  }

  // ── Event listeners ───────────────────────────────────────────────────────

  if ($securityBtn) {
    $securityBtn.addEventListener('click', function () {
      if ($securityOverlay.classList.contains('hidden')) {
        $securityOverlay.classList.remove('hidden');
        renderLog();
        renderLayers();
      } else {
        $securityOverlay.classList.add('hidden');
      }
    });
  }

  if ($securityClose) {
    $securityClose.addEventListener('click', function () {
      $securityOverlay.classList.add('hidden');
    });
  }

  var $clearAll = document.getElementById('security-clear-all');
  if ($clearAll) {
    $clearAll.addEventListener('click', function () {
      clearAllEvents();
    });
  }

  if ($securityOverlay) {
    $securityOverlay.addEventListener('click', function (e) {
      if (e.target === $securityOverlay) $securityOverlay.classList.add('hidden');
    });
  }

  // ── Expose to app.js ─────────────────────────────────────────────────────

  MC.handleSecurityEvent = handleSecurityEvent;
  MC.scanToolEvent = scanToolEvent;

})();
