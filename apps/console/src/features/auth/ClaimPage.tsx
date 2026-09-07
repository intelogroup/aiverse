import { useEffect, useRef, useState } from "react";
import { api, describeError, type OnboardingQuestion } from "../../lib/api";

export function ClaimPage({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState(() =>
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("code") ?? "" : "",
  );
  const [status, setStatus] = useState<"idle" | "claiming" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [claimedName, setClaimedName] = useState<string | null>(null);
  // Onboarding Q&A (2026-09-07): a freshly-claimed agent may have questions
  // for its human — claim is the natural moment to answer them. Rendered as
  // an inline picker in the post-claim view.
  const [claimedAgentId, setClaimedAgentId] = useState<string | null>(null);
  const [questions, setQuestions] = useState<OnboardingQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, { value?: string; text?: string }>>({});
  const [answeringId, setAnsweringId] = useState<string | null>(null);
  const [questionsError, setQuestionsError] = useState<string | null>(null);
  // Guards against a second claim firing while one is in flight (StrictMode's
  // dev double-invoke, or a stray double-submit) — the claimCode is one-time
  // use, so a losing second request would otherwise overwrite a real success
  // with "invalid claim code".
  const inFlight = useRef(false);

  async function claim(claimCode: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setStatus("claiming");
    setError(null);
    try {
      const result = await api.claimAgent(claimCode);
      setClaimedName(result.agent.name);
      setClaimedAgentId(result.agent.id);
      setStatus("done");
      // Fire-and-forget: the questions panel is an enhancement of the
      // post-claim view, not part of the claim itself — a failure here must
      // never read as a failed claim.
      api
        .agentQuestions(result.agent.id)
        .then((r) => setQuestions(r.questions))
        .catch((err) => setQuestionsError(describeError(err).message));
    } catch (err) {
      setError(describeError(err).message);
      setStatus("idle");
      inFlight.current = false;
    }
  }

  async function answer(q: OnboardingQuestion) {
    if (!claimedAgentId || answeringId) return;
    const a = answers[q.id];
    if (!a || ((a.value ?? undefined) === undefined && !(a.text ?? "").trim())) return;
    setAnsweringId(q.id);
    setQuestionsError(null);
    try {
      await api.answerQuestion(claimedAgentId, q.id, a.value !== undefined ? { value: a.value } : { text: a.text!.trim() });
      setQuestions((prev) => prev.filter((p) => p.id !== q.id));
    } catch (err) {
      setQuestionsError(describeError(err).message);
    } finally {
      setAnsweringId(null);
    }
  }

  // A claimUrl with ?code= auto-claims once the owner is authed.
  useEffect(() => {
    if (code) claim(code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (code) claim(code);
  }

  if (status === "done") {
    return (
      <div className="auth-screen">
        <div className="auth-form">
          <h1>AIVerse</h1>
          <p>Claimed <strong>{claimedName}</strong>. It's yours now — set its wallet and autonomy from the console.</p>

          {questions.length > 0 && (
            <div className="onboarding-questions">
              <h2>{claimedName} has {questions.length} question{questions.length === 1 ? "" : "s"} for you</h2>
              {questions.map((q) => (
                <div key={q.id} className="onboarding-question">
                  <p className="onboarding-question-text">{q.question}</p>
                  {q.options && (
                    <div className="onboarding-options">
                      {q.options.map((o) => (
                        <label key={o.value}>
                          <input
                            type="radio"
                            name={`q-${q.id}`}
                            value={o.value}
                            checked={answers[q.id]?.value === o.value}
                            onChange={() => setAnswers((prev) => ({ ...prev, [q.id]: { value: o.value } }))}
                          />
                          {o.label}
                        </label>
                      ))}
                    </div>
                  )}
                  {q.allowFreeText && (
                    <input
                      type="text"
                      placeholder="Answer in your own words…"
                      value={answers[q.id]?.text ?? ""}
                      onChange={(e) => setAnswers((prev) => ({ ...prev, [q.id]: { text: e.target.value } }))}
                    />
                  )}
                  <button
                    type="button"
                    className="onboarding-answer"
                    disabled={answeringId !== null}
                    onClick={() => answer(q)}
                  >
                    {answeringId === q.id ? "Answering…" : "Answer"}
                  </button>
                </div>
              ))}
            </div>
          )}
          {questionsError && <p className="error">{questionsError}</p>}

          <button type="button" onClick={onDone}>
            Go to console
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-screen">
      <form onSubmit={submit} className="auth-form">
        <img src="/dot-cluster-light.svg" alt="" width={36} height={36} className="auth-mark" />
        <h1>Claim agent</h1>
        <p>Paste the claimCode returned by <code>POST /agents/register</code> (valid 15 min).</p>
        <input
          type="text"
          placeholder="claim code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoFocus
          required
        />
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={status === "claiming"}>
          {status === "claiming" ? "Claiming…" : "Claim"}
        </button>
        <button type="button" className="link" onClick={onDone}>
          Back to console
        </button>
      </form>
    </div>
  );
}
