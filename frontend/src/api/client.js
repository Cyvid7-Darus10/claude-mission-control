const API = '/api';

async function request(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `Request failed: ${res.status}`);
  }
  return res.json();
}

// ── Projects ──
export const listProjects = () => request('/projects');
export const createProject = (data) => request('/projects', { method: 'POST', body: JSON.stringify(data) });
export const getProject = (id) => request(`/projects/${id}`);
export const deleteProject = (id) => request(`/projects/${id}`, { method: 'DELETE' });

// ── Missions ──
export function listMissions(filters = {}) {
  const params = new URLSearchParams();
  if (filters.project_id) params.set('project_id', filters.project_id);
  if (filters.status) params.set('status', filters.status);
  if (filters.tag) params.set('tag', filters.tag);
  const qs = params.toString();
  return request(`/missions${qs ? '?' + qs : ''}`);
}
export const createMission = (data) => request('/missions', { method: 'POST', body: JSON.stringify(data) });
export const getMission = (id) => request(`/missions/${id}`);
export const updateMission = (id, data) => request(`/missions/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteMission = (id) => request(`/missions/${id}`, { method: 'DELETE' });
export const generateNextMission = (id) => request(`/missions/${id}/generate-next`, { method: 'POST' });

// ── Mission Events & Scheduling ──
export const getMissionEvents = (id) => request(`/missions/${id}/events`);
export const setMissionSchedule = (id, cron) =>
  request(`/missions/${id}/schedule`, { method: 'POST', body: JSON.stringify({ cron, enabled: true }) });
export const removeMissionSchedule = (id) =>
  request(`/missions/${id}/schedule`, { method: 'DELETE' });

// ── Reports ──
export function listReports(filters = {}) {
  const params = new URLSearchParams();
  if (filters.project_id) params.set('project_id', filters.project_id);
  if (filters.mission_id) params.set('mission_id', filters.mission_id);
  const qs = params.toString();
  return request(`/reports${qs ? '?' + qs : ''}`);
}

// ── Dashboard ──
export const getDashboardStats = () => request('/dashboard/stats');

// ── Project Planner ──
export const planProject = (prompt, projectPath) => request('/plan', {
  method: 'POST',
  body: JSON.stringify({ prompt, project_path: projectPath || undefined }),
});

// ── Plugins ──
export const getPlugins = () => request('/plugins');
