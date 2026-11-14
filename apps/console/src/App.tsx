import { lazy, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  describeError,
  getOwnerToken,
  setOwnerToken,
  setOwnerEmail,
  SESSION_ENDED_EVENT,
  SESSION_ENDED_MESSAGE,
} from "./lib/api";
import { queryKeys } from "./lib/queryClient";
import {
  patchAgentStatus,
  prependLiveEvent,
  useAgentsQuery,
  useLiveEventsQuery,
} from "./lib/queries";
import { useConsoleWs } from "./lib/consoleWs";
import { pushToast } from "./lib/toast";
import { ToastStack } from "./components/ToastStack";

const WorldView = lazy(() => import("./features/world/WorldView").then(m => ({ default: m.WorldView })));
// Off-world routes load on demand so the world entry chunk stays lean.
const AuthScreen = lazy(() => import("./features/auth/AuthScreen").then(m => ({ default: m.AuthScreen })));
const ClaimPage = lazy(() => import("./features/auth/ClaimPage").then(m => ({ default: m.ClaimPage })));
const OAuthConsentPage = lazy(() => import("./features/auth/OAuthConsentPage").then(m => ({ default: m.OAuthConsentPage })));
const VerifyEmailPage = lazy(() => import("./features/auth/VerifyEmailPage").then(m => ({ default: m.VerifyEmailPage })));
const ResetPasswordPage = lazy(() => import("./features/auth/ResetPasswordPage").then(m => ({ default: m.ResetPasswordPage })));
const PublicHomepage = lazy(() => import("./features/homepage/PublicHomepage").then(m => ({ default: m.PublicHomepage })));
const VerseFeed = lazy(() => import("./features/verse-feed/VerseFeed").then(m => ({ default: m.VerseFeed })));
const DocsPage = lazy(() => import("./features/docs/DocsPage").then(m => ({ default: m.DocsPage })));

export type View = "world" | "public" | "docs" | "verse" | "claim" | "verify-email" | "reset-password" | "oauth-consent";

export default function App() {
  const [authed, setAuthed] = useState(!!getOwnerToken());
  const [view, setView] = useState<View>(() => {
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/docs")) return "docs";
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/public")) return "public";
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/verse")) return "verse";
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/claim")) return "claim";
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/oauth/consent")) return "oauth-consent";
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/verify-email")) return "verify-email";
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/reset-password")) return "reset-password";
    return "world";
  });

  // Server state lives in TanStack Query now (Phase 1 of the state
  // migration): the agents list is a query keyed on `authed`, and the
  // live-events list is a cache entry the console WS writes into — the
  // two useState arrays and their hand-rolled WS patches are gone.
  const queryClient = useQueryClient();
  const agentsQuery = useAgentsQuery(authed);
  const agents = agentsQuery.data?.agents ?? [];
  const liveEvents = useLiveEventsQuery().data ?? [];

  const token = getOwnerToken();

  // The pre-Query code toasted when its imperative listAgents() failed.
  // The query's error state (which surfaces after retries) drives the
  // same toast now, once per failed fetch cycle.
  const agentsError = agentsQuery.error;
  const agentsErrorAt = agentsQuery.errorUpdatedAt;
  const lastAgentsErrorAt = useRef(0);
  useEffect(() => {
    if (!agentsError || agentsErrorAt === 0 || agentsErrorAt === lastAgentsErrorAt.current) return;
    lastAgentsErrorAt.current = agentsErrorAt;
    const { message, kind } = describeError(agentsError);
    pushToast(message, kind);
  }, [agentsError, agentsErrorAt]);

  function refreshAgents() {
    void agentsQuery.refetch();
  }

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
    onConsoleEvent: (event) => prependLiveEvent(queryClient, event),
    onAgentStatusChanged: (payload) => patchAgentStatus(queryClient, payload),
  });

  function goWorld() {
    setView("world");
    window.history.pushState(null, "", "/");
  }

  function goClaim() {
    setView("claim");
    window.history.pushState(null, "", "/claim");
  }

  function logout() {
    setOwnerToken(null);
    setOwnerEmail(null);
    setAuthed(false);
    queryClient.setQueryData(queryKeys.agents, { agents: [] });
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

  // OAuth consent (MCP plan Phase 2): an external client sent the owner
  // here from GET /oauth/authorize. Same sign-in gate as claim — the
  // AuthScreen returns to this same URL afterwards, request_id intact.
  if (view === "oauth-consent") {
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
        <OAuthConsentPage onDone={goWorld} />
      </>
    );
  }

  return (
    <>
      <ToastStack />
      <WorldView agents={agents} liveEvents={liveEvents} authed={authed} onLogout={logout} onSignIn={goClaim} />
    </>
  );
}
