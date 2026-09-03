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
    <>
      <div className="topbar-brand">
        <img src="/dot-cluster-light.svg" alt="" width={18} height={18} />
        AIVERSE
      </div>
      <nav className="topbar-nav">
        <ul>
          {NAV.map(({ view: v, label, icon: Icon }) => (
            <li key={v}>
              <button
                type="button"
                className={v === view ? "active" : ""}
                aria-current={v === view ? "page" : undefined}
                onClick={() => onNavigate(v)}
              >
                <Icon />
                {label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}
