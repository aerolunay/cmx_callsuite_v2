/*
Thin fetch wrapper. All requests go through Vite's dev proxy (see
vite.config.js) so relative /api/* paths reach the Express backend on
port 5060 without CORS headaches. credentials: "include" is required on
every call so the session cookie actually gets sent/received.

UPDATED — when options.body is a FormData instance (used for Campaign
audio-upload requests), Content-Type is deliberately NOT set here.
The browser must set its own multipart/form-data header WITH the
correct boundary string itself; forcing "application/json" (or any
manual multipart header) here would break the upload silently.
*/
async function request(path, options = {}) {
  const isFormData = options.body instanceof FormData;

  const res = await fetch(`/api${path}`, {
    credentials: "include",
    headers: {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {}),
    },
    ...options,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.message || `Request failed (${res.status})`);
  }

  return data;
}

export const api = {
  // Auth
  checkUser: (email) => request("/auth/check-user", { method: "POST", body: JSON.stringify({ email }) }),
  requestOtp: (email) =>
    request("/auth/request-otp", { method: "POST", body: JSON.stringify({ email }) }),
  verifyOtp: (email, code) =>
    request("/auth/verify-otp", { method: "POST", body: JSON.stringify({ email, code }) }),
  loginTotp: (email, code) =>
    request("/auth/login-totp", { method: "POST", body: JSON.stringify({ email, code }) }),
  me: () => request("/auth/me"),
  logout: () => request("/auth/logout", { method: "POST" }),
  totpSetup: () => request("/auth/totp/setup", { method: "POST" }),
  totpConfirm: (code) =>
    request("/auth/totp/confirm", { method: "POST", body: JSON.stringify({ code }) }),

  // Campaigns
  getCampaigns: () => request("/campaigns"),
  // Scoped to the logged-in agent's own campaign assignments — see
  // dialerRoutes.js's GET /campaigns/mine for why this is a genuinely
  // separate endpoint from getCampaigns() above, not a variant of it.
  getMyCampaigns: () => request("/campaigns/mine"),

  // Call history / stats
  getCallLog: (campaignId) => request(`/dialer/call-log?campaignId=${encodeURIComponent(campaignId)}`),
  getTodayStats: (campaignId) => request(`/dialer/stats/today?campaignId=${encodeURIComponent(campaignId)}`),

  // Agent status
  getStatus: () => request("/dialer/status"),
  getWebrtcCredentials: () => request("/dialer/webrtc-credentials"),
  conferenceAdd: (target, isExtension) =>
    request("/dialer/conference-add", { method: "POST", body: JSON.stringify({ target, isExtension }) }),
  transferBlind: (target, isExtension) =>
    request("/dialer/transfer-blind", { method: "POST", body: JSON.stringify({ target, isExtension }) }),
  setStatus: (status) =>
    request("/dialer/status", { method: "POST", body: JSON.stringify({ status }) }),
  hasLeads: (campaignId) => request(`/dialer/has-leads?campaignId=${encodeURIComponent(campaignId)}`),

  // Dialer
  nextLead: (campaignId) =>
    request("/dialer/next-lead", { method: "POST", body: JSON.stringify({ campaignId }) }),
  startCall: (campaignId, leadId, phoneNumber, lead, callType) =>
    request("/dialer/start-call", {
      method: "POST",
      body: JSON.stringify({ campaignId, leadId, phoneNumber, lead, callType }),
    }),
  getCurrentCall: () => request("/dialer/current-call"),
  getCurrentInboundCall: () => request("/dialer/inbound/current"),
  endCall: (callId) => request(`/dialer/end-call/${callId}`, { method: "POST" }),
  holdCall: (callId) => request(`/dialer/hold/${callId}`, { method: "POST" }),
  unholdCall: (callId) => request(`/dialer/unhold/${callId}`, { method: "POST" }),
  // callId is required on all 4 of these now — v2's multi-call inbound
  // rebuild means there's no more implicit "the" inbound call.
  holdInbound: (callId) => request(`/dialer/inbound/hold`, { method: "POST", body: JSON.stringify({ callId }) }),
  unholdInbound: (callId) => request(`/dialer/inbound/unhold`, { method: "POST", body: JSON.stringify({ callId }) }),
  endInboundCall: (callId) => request(`/dialer/inbound/end-call`, { method: "POST", body: JSON.stringify({ callId }) }),
  saveDisposition: (callId, payload) =>
    request(`/dialer/disposition/${callId}`, { method: "POST", body: JSON.stringify(payload) }),
  saveInboundDisposition: (payload) =>
    request(`/dialer/inbound-disposition`, { method: "POST", body: JSON.stringify(payload) }),

  // Admin
  getAvailableVicidialUsers: () => request("/admin/vicidial-users/available"),
  getAdminUsers: () => request("/admin/users"),
  createAdminUser: (payload) =>
    request("/admin/users", { method: "POST", body: JSON.stringify(payload) }),
  // Combined creation — writes BOTH a brand new asterisk.vicidial_users
  // row AND the matching cmx_dialer.app_users row in one transaction
  // (see adminRoutes.js's POST /users/full). Kept as a genuinely
  // separate function from createAdminUser above, which still requires
  // binding to an ALREADY-existing ViciDial user — that path is
  // untouched.
  createFullUser: (payload) =>
    request("/admin/users/full", { method: "POST", body: JSON.stringify(payload) }),
  // ViciDial Users — standalone CRUD, separated out per explicit
  // request from being bundled inside app-user creation. A user
  // created here becomes immediately bindable via
  // getAvailableVicidialUsers()'s dropdown, same as any pre-existing
  // account.
  getVicidialUsers: () => request("/admin/vicidial-users"),
  createVicidialUser: (payload) =>
    request("/admin/vicidial-users", { method: "POST", body: JSON.stringify(payload) }),
  updateVicidialUser: (username, payload) =>
    request(`/admin/vicidial-users/${encodeURIComponent(username)}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  deleteVicidialUser: (username) =>
    request(`/admin/vicidial-users/${encodeURIComponent(username)}`, { method: "DELETE" }),
  // Phones — view/edit/delete only now. Standalone creation removed:
  // every phone is created as a side effect of createVicidialUser()
  // above. extension is treated as immutable — no rename endpoint
  // exists, matching adminRoutes.js's own design (delete + recreate).
  getPhones: () => request("/admin/phones"),
  updatePhone: (extension, payload) =>
    request(`/admin/phones/${encodeURIComponent(extension)}`, { method: "PUT", body: JSON.stringify(payload) }),
  deletePhone: (extension) =>
    request(`/admin/phones/${encodeURIComponent(extension)}`, { method: "DELETE" }),
  updateAdminUser: (appUserId, payload) =>
    request(`/admin/users/${appUserId}`, { method: "PUT", body: JSON.stringify(payload) }),
  deleteAdminUser: (appUserId) =>
    request(`/admin/users/${appUserId}`, { method: "DELETE" }),
  kickAgent: (appUserId) =>
    request(`/admin/users/${appUserId}/kick`, { method: "POST" }),
  // Real-time priority control — used by the Live Status Dashboard's
  // "Set Prio" per-row action. Deliberately lightweight/standalone,
  // not routed through updateAdminUser's full-form PUT.
  updateAgentPriority: (appUserId, priority) =>
    request(`/admin/users/${appUserId}/priority`, { method: "PATCH", body: JSON.stringify({ priority }) }),
  getLiveStatus: (campaignId) =>
    request(`/admin/live-status${campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : ""}`),
  getQueueStatus: (campaignId) =>
    request(`/admin/queue-status${campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : ""}`),
  getAbandonedCalls: (campaignId) =>
    request(`/admin/abandoned-calls${campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : ""}`),
  getTotalCalls: (campaignId) =>
    request(`/admin/total-calls${campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : ""}`),
  getScreeningHandoffCode: () => request("/dialer/screening-handoff-code", { method: "POST" }),
  getReportingSummary: (campaignId) =>
    request(`/admin/reporting-summary${campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : ""}`),
  getAggregateStats: (campaignId) =>
    request(`/admin/stats/today${campaignId ? `?campaignId=${encodeURIComponent(campaignId)}` : ""}`),

  // Reports (from production, Phase 8)
  getCampaignAgentBreakdown: (startDate, endDate, campaignId) => {
    const params = new URLSearchParams({ startDate, endDate });
    if (campaignId) params.set("campaignId", campaignId);
    return request(`/admin/reports/campaign-agent-breakdown?${params.toString()}`);
  },
  // Second report type — one row per call, combining inbound+outbound.
  getRawCallsReport: (startDate, endDate, campaignId) => {
    const params = new URLSearchParams({ startDate, endDate });
    if (campaignId) params.set("campaignId", campaignId);
    return request(`/admin/reports/raw-calls?${params.toString()}`);
  },

  // Campaign management — create/edit auto-creates the DID routing,
  // dialplan, and audio prompts server-side (see campaignRoutes.js).
  // create/update use FormData (not JSON.stringify) since both may
  // include the two audio file uploads — request() in this file
  // already knows to skip forcing a JSON Content-Type when the body
  // is a FormData instance.
  getAdminCampaigns: (queryString) => request(`/admin/campaigns${queryString ? `?${queryString}` : ""}`),
  createCampaign: (formData) => request("/admin/campaigns", { method: "POST", body: formData }),
  updateCampaign: (campaignId, formData) =>
    request(`/admin/campaigns/${encodeURIComponent(campaignId)}`, { method: "PUT", body: formData }),
  deactivateCampaign: (campaignId) =>
    request(`/admin/campaigns/${encodeURIComponent(campaignId)}/deactivate`, { method: "POST" }),
  deleteCampaign: (campaignId) =>
    request(`/admin/campaigns/${encodeURIComponent(campaignId)}`, { method: "DELETE" }),

  // Recordings — deliberately at /recordings, not /admin/recordings,
  // since this is now its own standalone page (RecordingsPage.jsx),
  // not part of Admin — gated server-side by requireAdminOrSupervisor
  // in dialerRoutes.js, not requireAdmin.
  getRecordings: (queryString) => request(`/recordings${queryString ? `?${queryString}` : ""}`),
  getRecordingPlaybackUrl: (callId) =>
    request(`/recordings/${encodeURIComponent(callId)}/playback-url`),

  // Outbound Auto-Dial, Phase 1 — lead upload, DNC management, and
  // per-campaign autodial rules. Template downloads are plain GET
  // endpoints that return a file with Content-Disposition: attachment
  // — the component just links straight to these URLs rather than
  // routing through this fetch wrapper, so the browser handles the
  // download natively.
  uploadLeads: (formData) => request("/admin/leads/upload", { method: "POST", body: formData }),
  getDncList: () => request("/admin/dnc"),
  uploadDnc: (formData) => request("/admin/dnc/upload", { method: "POST", body: formData }),
  getAutodialRules: (campaignId) => request(`/admin/campaigns/${encodeURIComponent(campaignId)}/autodial-rules`),
  updateAutodialRules: (campaignId, rules) =>
    request(`/admin/campaigns/${encodeURIComponent(campaignId)}/autodial-rules`, {
      method: "PUT",
      body: JSON.stringify(rules),
    }),
};