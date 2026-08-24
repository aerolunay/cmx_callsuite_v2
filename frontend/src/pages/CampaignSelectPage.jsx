import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import Header from "../components/Header";
import { api } from "../api";

/*
==================================================
CAMPAIGN SELECT PAGE
==================================================
UPDATED — uses getMyCampaigns() (scoped to the logged-in agent's own
assignments via cmx_dialer.agent_campaign_assignments), not the
unscoped getCampaigns() this used to call. Also auto-skips the picker
entirely when the agent has EXACTLY ONE assigned campaign — no reason
to make someone choose when there's only one real choice. That single
campaign is auto-stored and the agent is sent straight to /dialer,
same as if they'd manually selected it and clicked Continue.

Genuinely 0 campaigns (not yet assigned to any) still shows the
existing "No active campaigns found" message — nothing to auto-select
in that case.
==================================================
*/
export default function CampaignSelectPage() {
  const [campaigns, setCampaigns] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    api
      .getMyCampaigns()
      .then((data) => {
        const list = data.campaigns || [];
        if (list.length === 1) {
          localStorage.setItem("cmx_dialer_campaign", JSON.stringify(list[0]));
          navigate("/dialer", { replace: true });
          return;
        }
        setCampaigns(list);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [navigate]);

  function handleContinue() {
    const campaign = campaigns.find((c) => c.campaign_id === selectedId);
    if (!campaign) return;
    localStorage.setItem("cmx_dialer_campaign", JSON.stringify(campaign));
    navigate("/dialer");
  }

  return (
    <>
      <Header />
      <div className="page-content">
        <h2>Select a campaign</h2>

        {loading && <p>Loading campaigns…</p>}
        {error && <div className="error">{error}</div>}

        {!loading && !error && campaigns.length === 0 && <p>No active campaigns found.</p>}

        {!loading && campaigns.length > 0 && (
          <div className="card">
            {campaigns.map((c) => (
              <label key={c.campaign_id} className="campaign-row">
                <input
                  type="radio"
                  name="campaign"
                  value={c.campaign_id}
                  checked={selectedId === c.campaign_id}
                  onChange={() => setSelectedId(c.campaign_id)}
                />
                <span className="campaign-name">{c.campaign_name}</span>
                <span className="campaign-id">{c.campaign_id}</span>
              </label>
            ))}

            <button
              className="button-secondary"
              style={{ marginTop: 16 }}
              disabled={!selectedId}
              onClick={handleContinue}
            >
              Continue →
            </button>
          </div>
        )}
      </div>
    </>
  );
}
