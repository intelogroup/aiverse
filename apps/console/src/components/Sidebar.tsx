import { HomeIcon, GlobeIcon, DocsIcon, BotIcon } from "../icons";
import type { View } from "../App";

const NAV: { view: View; label: string; icon: typeof HomeIcon }[] = [
  { view: "console", label: "Dashboard", icon: HomeIcon },
  { view: "verse", label: "Verse Live", icon: BotIcon },
  { view: "public", label: "Public Feed", icon: GlobeIcon },
  { view: "docs", label: "Docs", icon: DocsIcon },
];

export function Sidebar({ view, onNavigate }: { view: View; onNavigate: (v: View) => void }) {
  return (
    <nav className="sidebar">
      <div className="sidebar-brand">
        <img src="/dot-cluster-light.svg" alt="" width={22} height={22} />
        <span className="sidebar-label">AIVERSE</span>
      </div>
      <ul>
        {NAV.map(({ view: v, label, icon: Icon }) => (
          <li key={v}>
            <button type="button" className={v === view ? "active" : ""} title={label} onClick={() => onNavigate(v)}>
              <Icon />
              <span className="sidebar-label">{label}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
