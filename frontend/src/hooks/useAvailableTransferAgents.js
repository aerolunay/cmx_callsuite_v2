import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

// How often to re-check who's available while the agent is on a call —
// statuses change constantly (agents go on calls, take breaks), and the
// Internal Transfer button's enabled state should keep up.
const POLL_MS = 10000;

/*
==================================================
useAvailableTransferAgents
==================================================
Per explicit request — the agents on this campaign who can take an
Internal Transfer right now: status READY only. Anyone else's phone
would just reject or miss it (logged out = softphone not registered;
already on a call = their phone refuses a second session; on a break /
ACW / Not Ready = away from the desk).

Shared by MiniPhone (to disable the Internal Transfer button with "No
agents available") and InternalTransferModal (which lists only these),
so the button and the list always agree.

Only polls while `enabled` (an active call with a known campaign).
Returns { agents, error, refresh }: agents is null until the first load
finishes (unknown — callers shouldn't treat that as "none available"),
otherwise the READY agents. refresh() re-checks immediately, e.g. when
the modal opens.
==================================================
*/
export function useAvailableTransferAgents(campaignId, enabled) {
  // Keyed by campaignId so a result loaded for a previous campaign is
  // never shown for the current one.
  const [result, setResult] = useState({ campaignId: null, agents: null, error: "" });
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!enabled || !campaignId) return;
    let cancelled = false;

    async function load() {
      try {
        const data = await api.getCampaignAgents(campaignId);
        if (cancelled) return;
        setResult({
          campaignId,
          agents: (data.agents || []).filter((a) => a.status === "READY"),
          error: "",
        });
      } catch (err) {
        if (cancelled) return;
        setResult((prev) => ({
          campaignId,
          agents: prev.campaignId === campaignId ? prev.agents : null,
          error: err.message,
        }));
      }
    }

    load();
    const interval = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [campaignId, enabled, refreshKey]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const isCurrent = enabled && result.campaignId === campaignId;
  return {
    agents: isCurrent ? result.agents : null,
    error: isCurrent ? result.error : "",
    refresh,
  };
}
