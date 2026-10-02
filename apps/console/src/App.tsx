import { useEffect, useState } from "react";
import {
  api,
  describeError,
  getOwnerToken,
  setOwnerToken,
  setOwnerEmail,
  SESSION_ENDED_EVENT,
  SESSION_ENDED_MESSAGE,
  type Agent,
  type ConsoleEvent,
} from "./lib/api";
import { useConsoleWs } from "./lib/consoleWs";
import { pushToast } from "./lib/toast";
import { AuthScreen } from "./features/auth/AuthScreen";
import { ClaimPage } from "./features/auth/ClaimPage";
import { VerifyEmailPage } from "./features/auth/VerifyEmailPage";
import { ResetPasswordPage } from "./features/auth/ResetPasswordPage";
import { PublicHomepage } from "./features/homepage/PublicHomepage";
import { VerseFeed } from "./features/verse-feed/VerseFeed";
import { WorldView } from "./features/world/WorldView";
import { World3DView } from "./features/world3d/World3DView";
import { DocsPage } from "./features/docs/DocsPage";
import { ToastStack } from "./components/ToastStack";

export type View = "world" | "world3d" | "public" | "docs" | "verse" | "claim" | "verify-email" | "reset-password";

export default function App() {
  const [authed, setAuthed] = useState(!!getOwnerToken());
  const [view, setView] = useState<View>(() => {
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/docs")) return "docs";
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/world3d")) return "world3d";
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/public")) return "public";
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/verse")) return "verse";
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/claim")) return "claim";
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/verify-email")) return "verify-email";
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/reset-password")) return "reset-password";
    return "world";
  });
  const [agents, setAgents] = useState<Agent[]>([]);
  const [liveEvents, setLiveEvents] = useState<ConsoleEvent[]>([]);

  const token = getOwnerToken();

  function refreshAgents() {
    api
      .listAgents()
      .then((r) => setAgents(r.agents))
      .catch((err) => {
        const { message, kind } = describeError(err);
        pushToast(message, kind);
      });
  }

  useEffect(() => {
    if (authed) refreshAgents();
  }, [authed, token]);

  useEffect(() => {
    const onEnded = () => {
      if (!authed) return;
      logout();
      pushToast(SESSION_ENDED_MESSAGE, "attention");
    };
    window.addEventListener(SESSION_ENDED_EVENT, onEnded);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, onEnded);
  }, [authed]);

  useConsoleWs(authed ? token : null, {
    onConsoleEvent: (event) => setLiveEvents((prev) => [event, ...prev].slice(0, 200)),
    onAgentStatusChanged: (payload) => {
      setAgents((prev) =>
        prev.map((a) => (a.id === payload.agent_id ? { ...a, status: payload.status as Agent["status"] } : a)),
      );
    },
  });

  function goWorld() {
    setView("world");
    window.history.pushState(null, "", "/");
  }

  function go3D() {
    setView("world3d");
    window.history.pushState(null, "", "/world3d");
  }

  function goClaim() {
    setView("claim");
    window.history.pushState(null, "", "/claim");
  }

  function logout() {
    setOwnerToken(null);
    setOwnerEmail(null);
    setAuthed(false);
    setAgents([]);
  }

  if (view === "verse") {
    return (
      <>
        <ToastStack />
        <VerseFeed onBack={goWorld} />
      </>
    );
  }

  if (view === "public") {
    return (
      <>
        <ToastStack />
        <PublicHomepage onBack={goWorld} />
      </>
    );
  }

  if (view === "docs") {
    return (
      <>
        <ToastStack />
        <DocsPage onBack={goWorld} />
      </>
    );
  }

  if (view === "reset-password") {
    return (
      <>
        <ToastStack />
        <ResetPasswordPage
          onDone={(newToken) => {
            if (newToken) {
              setOwnerToken(newToken);
              setAuthed(true);
            }
            goWorld();
          }}
        />
      </>
    );
  }

  if (view === "verify-email") {
    return (
      <>
        <ToastStack />
        <VerifyEmailPage onDone={goWorld} />
      </>
    );
  }

  if (view === "claim") {
    if (!authed) {
      return (
        <>
          <ToastStack />
          <AuthScreen onAuthed={() => setAuthed(true)} />
        </>
      );
    }
    return (
      <>
        <ToastStack />
        <ClaimPage
          onDone={() => {
            refreshAgents();
            goWorld();
          }}
        />
      </>
    );
  }

  if (view === "world3d") {
    return (
      <>
        <ToastStack />
        <World3DView agents={agents} authed={authed} onBack={goWorld} onLogin={goClaim} />
      </>
    );
  }

  return (
    <>
      <ToastStack />
      <WorldView agents={agents} liveEvents={liveEvents} authed={authed} onLogout={logout} onOpen3D={go3D} />
    </>
  );
}
