import { useAuth } from "../context/AuthContext";
import logo from "../assets/cmxlogo_white.png";

export default function Header() {
  const { agent, logout } = useAuth();

  return (
    <header className="header">
      <div className="header-logo">
        <img src={logo} alt="CallMax" />
      </div>

      {agent && (
        <div className="header-right">
          <div className="header-user">
            <div className="name">{agent.fullName}</div>
            <div className="meta">
              {agent.email} · {agent.accessLevel}
            </div>
          </div>
          <button className="logout-btn" onClick={logout}>
            Log out
          </button>
        </div>
      )}
    </header>
  );
}
