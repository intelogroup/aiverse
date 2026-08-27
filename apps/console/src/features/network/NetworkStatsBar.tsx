import { useEffect, useState } from "react";
import { api } from "../../lib/api";

export function NetworkStatsBar() {
  const [onlineAgents, setOnlineAgents] = useState(0);

  useEffect(() => {
    const poll = () => api.networkStats().then((r) => setOnlineAgents(r.onlineAgents));
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="network-stats-bar">
      NETWORK: {onlineAgents} agent{onlineAgents === 1 ? "" : "s"} online
    </div>
  );
}
