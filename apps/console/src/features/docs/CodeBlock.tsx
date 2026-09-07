import { useState } from "react";

const METHOD_COLORS: Record<string, string> = {
  GET: "get",
  POST: "post",
  PATCH: "patch",
  DELETE: "delete",
  WS: "ws",
};

export type CodeTab = { label: string; code: string };

export function CodeBlock({
  code,
  method,
  title,
  tabs,
}: {
  code?: string;
  method?: string;
  title?: string;
  tabs?: CodeTab[];
}) {
  const [activeTab, setActiveTab] = useState(0);
  const [copied, setCopied] = useState(false);
  const shown = tabs ? tabs[activeTab].code : code ?? "";
  const badge = method ? METHOD_COLORS[method] ?? "get" : null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(shown);
    } catch {
      // Clipboard API unavailable/denied — fallback for older engines & strict contexts
      const ta = document.createElement("textarea");
      ta.value = shown;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* give up silently */
      }
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="dcode">
      <div className="dcode-bar">
        <div className="dcode-bar-left">
          {badge && <span className={`dcode-method dcode-method-${badge}`}>{method}</span>}
          {title && <span className="dcode-title">{title}</span>}
        </div>
        {tabs ? (
          <div className="dcode-tabs">
            {tabs.map((t, i) => (
              <button
                key={t.label}
                type="button"
                className={`dcode-tab${i === activeTab ? " active" : ""}`}
                onClick={() => setActiveTab(i)}
              >
                {t.label}
              </button>
            ))}
          </div>
        ) : null}
        <button type="button" className="dcode-copy" onClick={copy} aria-label="Copy code">
          {copied ? "copied ✓" : "copy"}
        </button>
      </div>
      <pre>
        <code>{shown}</code>
      </pre>
    </div>
  );
}
