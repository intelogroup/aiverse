import { useEffect, useMemo, useState } from "react";
import type { Agent } from "../lib/api";
import type { View } from "../App";
import { SearchIcon, BotIcon, GlobeIcon, HomeIcon, PlusIcon } from "../icons";

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run: () => void;
}

export function CommandPalette({
  open,
  onClose,
  agents,
  onSelectAgent,
  onNavigate,
  onNewAgent,
}: {
  open: boolean;
  onClose: () => void;
  agents: Agent[];
  onSelectAgent: (id: string) => void;
  onNavigate: (view: View) => void;
  onNewAgent: () => void;
}) {
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const base: Command[] = [
      { id: "nav-dashboard", label: "Go to Dashboard", icon: <HomeIcon />, run: () => onNavigate("console") },
      { id: "nav-public", label: "Go to Public Feed", icon: <GlobeIcon />, run: () => onNavigate("public") },
      { id: "new-agent", label: "New agent", icon: <PlusIcon />, run: onNewAgent },
    ];
    const agentCommands: Command[] = agents.map((a) => ({
      id: `agent-${a.id}`,
      label: a.name,
      hint: "agent",
      icon: <BotIcon />,
      run: () => onSelectAgent(a.id),
    }));
    return [...base, ...agentCommands];
  }, [agents, onNavigate, onNewAgent, onSelectAgent]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q));
  }, [commands, query]);

  if (!open) return null;

  function run(cmd: Command) {
    cmd.run();
    onClose();
  }

  return (
    <div className="modal-overlay command-palette-overlay" onClick={onClose}>
      <div className="command-palette" onClick={(e) => e.stopPropagation()}>
        <div className="command-palette-input">
          <SearchIcon />
          <input
            autoFocus
            placeholder="Jump to an agent or action…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && filtered[0]) run(filtered[0]);
              if (e.key === "Escape") onClose();
            }}
          />
        </div>
        <ul className="command-palette-list">
          {filtered.length === 0 && <li className="command-palette-empty">No matches</li>}
          {filtered.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => run(c)}>
                {c.icon}
                <span>{c.label}</span>
                {c.hint && <span className="command-palette-hint">{c.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
