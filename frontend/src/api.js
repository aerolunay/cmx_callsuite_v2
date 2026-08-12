/*
Thin fetch wrapper. All requests go through Vite's dev proxy (see
vite.config.js) so relative /api/* paths reach the Express backend on
port 5060 without CORS headaches. credentials: "include" is required on
every call so the session cookie actually gets sent/received.
*/
async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
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

  // Call history / stats
  getCallLog: (campaignId) => request(`/dialer/call-log?campaignId=${encodeURIComponent(campaignId)}`),
  getTodayStats: (campaignId) => request(`/dialer/stats/today?campaignId=${encodeURIComponent(campaignId)}`),

  // Agent status
  getStatus: () => request("/dialer/status"),
  setStatus: (status) =>
    request("/dialer/status", { method: "POST", body: JSON.stringify({ status }) }),

  // Dialer
  nextLead: (campaignId) =>
    request("/dialer/next-lead", { method: "POST", body: JSON.stringify({ campaignId }) }),
  startCall: (campaignId, leadId, phoneNumber, lead) =>
    request("/dialer/start-call", {
      method: "POST",
      body: JSON.stringify({ campaignId, leadId, phoneNumber, lead }),
    }),
  getCurrentCall: () => request("/dialer/current-call"),
  getCurrentInboundCall: () => request("/dialer/inbound/current"),
  endCall: (callId) => request(`/dialer/end-call/${callId}`, { method: "POST" }),
  holdCall: (callId) => request(`/dialer/hold/${callId}`, { method: "POST" }),
  unholdCall: (callId) => request(`/dialer/unhold/${callId}`, { method: "POST" }),
  holdInbound: () => request(`/dialer/inbound/hold`, { method: "POST" }),
  unholdInbound: () => request(`/dialer/inbound/unhold`, { method: "POST" }),
  endInboundCall: () => request(`/dialer/inbound/end-call`, { method: "POST" }),
  saveDisposition: (callId, payload) =>
    request(`/dialer/disposition/${callId}`, { method: "POST", body: JSON.stringify(payload) }),
  saveInboundDisposition: (payload) =>
    request(`/dialer/inbound-disposition`, { method: "POST", body: JSON.stringify(payload) }),
};