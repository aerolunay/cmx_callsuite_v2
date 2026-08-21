import { useState } from "react";
import { Navigate } from "react-router-dom";
import Header from "../components/Header";
import { useAuth } from "../context/AuthContext";
import AdminUsersSection from "../components/admin/AdminUsersSection";
import AdminVicidialUsersSection from "../components/admin/AdminVicidialUsersSection";
import AdminPhonesSection from "../components/admin/AdminPhonesSection";

/*
==================================================
ADMIN PAGE — shell + section navigation
==================================================
Nav shell with distinct sections — matches the real sequence agreed
for the ViciDial-admin-migration project. ViciDial Users is now its
own standalone section (separated out from being bundled inside user
creation, per explicit request) — sits right after Users, before
Phones, since a ViciDial user is the thing that connects an app user to
a phone at all (see AdminVicidialUsersSection's own comment for the
full reasoning on why that chain can't be skipped).

Campaigns and DID/Trunk Setup remain honest "not yet built"
placeholders — their backend endpoints don't exist yet.
==================================================
*/
const SECTIONS = [
  { key: "users", label: "Users" },
  { key: "vicidial-users", label: "ViciDial Users" },
  { key: "phones", label: "Phone Extensions" },
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
            {activeSection === "phones" && <AdminPhonesSection />}

            {activeSection === "campaigns" && (
              <div className="card">
                <h3>Campaigns</h3>
                <p>
                  Campaign management isn't built yet — next in the ViciDial admin migration
                  sequence.
                </p>
              </div>
            )}

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
