import { useEffect, useState } from "react";
import { useNavigate, Navigate } from "react-router-dom";
import Header from "../components/Header";
import { useAuth } from "../context/AuthContext";
import { api } from "../api";

/*
==================================================
CAMPAIGN SELECT PAGE
==================================================
UPDATED — multi-campaign agent selection, per explicit request. Uses
getMyCampaigns() (scoped to the logged-in agent's own assignments via
cmx_dialer.agent_campaign_assignments), same as before. Also still
auto-skips the picker entirely when the agent has EXACTLY ONE assigned
campaign — no reason to make someone choose when there's only one real
choice.

MULTI-SELECT RULES (only apply when agent.multiCampaignEnabled is
true — an admin/WFM-controlled per-agent toggle, see
AdminUsersSection.jsx):
  - At most ONE OUTBOUND campaign — outbound lead-pulling
    (dialerService.js's getNextLead) is fundamentally single-campaign.
    Clicking an OUTBOUND campaign replaces any other OUTBOUND one but
    keeps the BLENDED selections. Per explicit request, outbound can be
    worked together with blended campaigns: their inbound callers are
    offered first whenever the agent goes READY.
  - Every click toggles a campaign in/out of the selection — capped at
    2 at once, per explicit request. A click that would make it 3 is
    rejected outright (selection unchanged) with an explanatory
    message, rather than silently dropping the oldest selection or
    failing to do anything without explanation.
Agents with multiCampaignEnabled OFF (the default) see the exact same
single-radio-button behavior as before — nothing changes for them.

The real selection is saved server-side via
POST /api/dialer/working-campaigns (see dialerRoutes.js — this is what
agentStatusService.getAnyReadyAgentWithExtension actually checks when
matching an incoming call to a Ready agent; it's the source of truth,
NOT localStorage). localStorage's existing single-campaign object
(cmx_dialer_campaign) is left completely unchanged in shape — still
set to exactly one campaign (the first selected one) for backward
compatibility with whatever else already reads it (DialerPage.jsx's
own display/outbound-dialing logic hasn't been audited as part of this
change). A NEW, separate key (cmx_dialer_working_campaigns) additionally
stores the full array, for anything built later that wants to show
"Working: 3 campaigns" instead of just one name.
==================================================
*/
export default function CampaignSelectPage() {
  const { agent } = useAuth();
  const [campaigns, setCampaigns] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const navigate = useNavigate();

  const multiCampaignEnabled = Boolean(agent?.multiCampaignEnabled);

  useEffect(() => {
    Promise.all([api.getMyCampaigns(), api.getWorkingCampaigns().catch(() => ({ campaignIds: [] }))])
      .then(([campaignData, workingData]) => {
        const list = campaignData.campaigns || [];

        if (list.length === 1) {
          finishSelection(list, [list[0].campaign_id]);
          return;
        }

        setCampaigns(list);
        // Pre-check whatever the agent had selected last time (e.g.
        // after a page refresh) — filtered to campaigns they're still
        // actually assigned to, in case an assignment was revoked
        // since their last selection.
        const validIds = (workingData.campaignIds || []).filter((id) => list.some((c) => c.campaign_id === id));
        setSelectedIds(validIds);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function campaignType(campaignId) {
    return campaigns.find((c) => c.campaign_id === campaignId)?.campaign_type || "OUTBOUND";
  }

  function handleToggle(campaignId) {
    if (!multiCampaignEnabled) {
      setSelectedIds([campaignId]);
      return;
    }

    const isOutboundClicked = campaignType(campaignId) === "OUTBOUND";

    setSelectedIds((prev) => {
      if (prev.includes(campaignId)) {
        setError("");
        return prev.filter((id) => id !== campaignId);
      }
      // Only one outbound campaign at a time — a new one replaces the old.
      const kept = isOutboundClicked ? prev.filter((id) => campaignType(id) !== "OUTBOUND") : prev;
      // Per explicit request — capped at 2 campaigns at once, even for an
      // agent with multiCampaignEnabled on and 3+ actual assignments.
      if (kept.length >= 2) {
        setError("You can work a maximum of 2 campaigns at once — deselect one first.");
        return prev;
      }
      setError("");
      return [...kept, campaignId];
    });
  }

  async function finishSelection(campaignList, ids) {
    setSaving(true);
    setError("");
    try {
      await api.setWorkingCampaigns(ids);
      const selectedCampaigns = campaignList.filter((c) => ids.includes(c.campaign_id));
      // Backward-compatible single-object shape — first selected
      // campaign, unchanged from what this page has always stored.
      localStorage.setItem("cmx_dialer_campaign", JSON.stringify(selectedCampaigns[0]));
      // New, separate key — full array, for anything built later that
      // wants to reflect a multi-campaign working session.
      localStorage.setItem("cmx_dialer_working_campaigns", JSON.stringify(selectedCampaigns));
      navigate("/dialer", { replace: true });
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  function handleContinue() {
    if (selectedIds.length === 0) return;
    finishSelection(campaigns, selectedIds);
  }

  // NEW — per explicit request: only agent/supervisor/training_quality
  // ever work a campaign at all, so only they should ever land here.
  // Matches DialerPage.jsx's own exact role restriction (the two pages
  // exist as a pair — there's no reason to let someone select a
  // campaign to work if they can't actually reach the dialer to work
  // it). Redirects everyone else the same way LandingPage.jsx's own
  // post-login redirect does, so there's no risk of a second bounce-
  // back loop: admin/wfm -> /admin, everyone else (account_manager) ->
  // /live-status. Placed after all hooks above (React rules — hooks
  // must run unconditionally every render), same pattern already used
  // in DialerPage.jsx/LiveStatusDashboard.jsx for their own guards.
  if (agent && !["agent", "supervisor", "training_quality"].includes(agent.accessLevel)) {
    if (["admin", "wfm"].includes(agent.accessLevel)) {
      return <Navigate to="/admin" replace />;
    }
    return <Navigate to="/live-status" replace />;
  }

  return (
    <>
      <Header />
      <div className="page-content">
        <h2>Select {multiCampaignEnabled ? "campaign(s)" : "a campaign"}</h2>

        {loading && <p>Loading campaigns…</p>}
        {error && <div className="error">{error}</div>}

        {!loading && !error && campaigns.length === 0 && <p>No active campaigns found.</p>}

        {!loading && campaigns.length > 0 && (
          <div className="card">
            {multiCampaignEnabled && (
              <p style={{ fontSize: 13, color: "#888", marginBottom: 10 }}>
                You can select up to 2 campaigns to work at once, including at most one outbound
                campaign. Working an outbound campaign with a blended one, inbound callers come first.
              </p>
            )}
            {campaigns.map((c) => (
              <label key={c.campaign_id} className="campaign-row">
                <input
                  type={multiCampaignEnabled ? "checkbox" : "radio"}
                  name="campaign"
                  value={c.campaign_id}
                  checked={selectedIds.includes(c.campaign_id)}
                  onChange={() => handleToggle(c.campaign_id)}
                />
                <span className="campaign-name">{c.campaign_name}</span>
                <span className="campaign-id">
                  {c.campaign_id} {c.campaign_type === "OUTBOUND" ? "(Outbound)" : "(Blended)"}
                </span>
              </label>
            ))}

            <button
              className="button-secondary"
              style={{ marginTop: 16 }}
              disabled={selectedIds.length === 0 || saving}
              onClick={handleContinue}
            >
              {saving ? "Saving…" : "Continue →"}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
