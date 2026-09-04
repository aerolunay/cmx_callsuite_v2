import { useState } from "react";
import { Navigate } from "react-router-dom";
import Header from "../components/Header";
import { useAuth } from "../context/AuthContext";
import AdminUsersSection from "../components/admin/AdminUsersSection";
import AdminVicidialUsersSection from "../components/admin/AdminVicidialUsersSection";
import AdminCampaignsSection from "../components/admin/AdminCampaignsSection";
import AdminLeadsSection from "../components/admin/AdminLeadsSection";
import AdminTrunksSection from "../components/admin/AdminTrunksSection";
import AdminCallFlagsSection from "../components/admin/AdminCallFlagsSection";

/*
==================================================
ADMIN PAGE — shell + section navigation
==================================================
Nav shell with distinct sections — matches the real sequence agreed
for the ViciDial-admin-migration project. Phone Login is its own
standalone section (separated out from being bundled inside user
creation, per explicit request) — sits right after Users, since a
Phone Login is the thing that connects an app user to a phone at all
(see AdminVicidialUsersSection's own comment for the full reasoning on
why that chain can't be skipped).

Phone Extensions (AdminPhonesSection) has been REMOVED entirely, per
explicit request — standalone phone-extension creation/management is
no longer part of this admin UI at all. Every phone now only ever
exists as a side effect of creating (or deleting) a Phone Login; there
is nothing left for a separate Phones screen to manage. The backend's
GET/PUT/DELETE /phones routes still exist for any legacy/orphaned
phone cleanup, but there is deliberately no UI surface for them anymore
here — go through the database directly if that's ever needed.

Campaigns is now live — creating one auto-creates its DID routing,
audio prompts, and dialplan (see campaignRoutes.js/
AdminCampaignsSection.jsx). DID/Trunk Setup remains an honest
"not yet built" placeholder — the shared outbound trunk (CMXSandbox)
is a one-time, already-existing piece of infrastructure that campaign
creation deliberately never touches, so there's nothing per-campaign
for this screen to manage yet.
==================================================
*/
const SECTIONS = [
  { key: "users", label: "Users" },
  { key: "vicidial-users", label: "Phone Login" },
  { key: "campaigns", label: "Campaigns" },
  { key: "leads", label: "Leads / Auto-Dial" },
  { key: "trunks", label: "DID / Trunk Setup" },
  // NEW — call avoidance tracking, per explicit request. This whole
  // page already gates to admin/wfm only (see the Navigate guard
  // below), so no additional per-section role check is needed here.
  { key: "call-flags", label: "Calls Flagged" },
];

export default function AdminPage() {
  const { agent } = useAuth();
  const [activeSection, setActiveSection] = useState("users");

  if (agent && agent.accessLevel !== "admin" && agent.accessLevel !== "wfm") {
    return <Navigate to="/" replace />;
  }

  return (
    <>
      <Header />
      <div className="page-content page-content-wide">
        <h2 style={{ marginBottom: 20 }}>Admin</h2>

        <div className="admin-shell">
          <nav className="admin-nav card">
            {SECTIONS.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setActiveSection(s.key)}
                className={`admin-nav-item${activeSection === s.key ? " admin-nav-item-active" : ""}`}
              >
                {s.label}
              </button>
            ))}
          </nav>

          <div className="admin-content">
            {activeSection === "users" && <AdminUsersSection />}
            {activeSection === "vicidial-users" && <AdminVicidialUsersSection />}
            {activeSection === "campaigns" && <AdminCampaignsSection />}
            {activeSection === "leads" && <AdminLeadsSection />}

            {activeSection === "trunks" && <AdminTrunksSection />}
            {activeSection === "call-flags" && <AdminCallFlagsSection />}
          </div>
        </div>
      </div>
    </>
  );
}
