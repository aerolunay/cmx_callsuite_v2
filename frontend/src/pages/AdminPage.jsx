import { useState } from "react";
import { Navigate } from "react-router-dom";
import Header from "../components/Header";
import { useAuth } from "../context/AuthContext";
import AdminUsersSection from "../components/admin/AdminUsersSection";
import AdminVicidialUsersSection from "../components/admin/AdminVicidialUsersSection";
import AdminCampaignsSection from "../components/admin/AdminCampaignsSection";

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
  { key: "trunks", label: "DID / Trunk Setup" },
];

export default function AdminPage() {
  const { agent } = useAuth();
  const [activeSection, setActiveSection] = useState("users");

  if (agent && agent.accessLevel !== "admin") {
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

            {activeSection === "trunks" && (
              <div className="card">
                <h3>DID / Trunk Setup</h3>
                <p>
                  Trunk/Carrier setup isn't built yet. This is deliberately saved for last in the
                  migration sequence — it writes Asterisk config files directly and triggers a
                  live reload, meaningfully more complex than the other sections, which are all
                  plain database CRUD.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
