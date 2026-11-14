import { describe, expect, test } from "bun:test";
import { oauthScopeForRoute } from "./oauthRouteScopes";

describe("oauthScopeForRoute", () => {
  test("maps every route the agent MCP dispatches to", () => {
    expect(oauthScopeForRoute("GET", "/world/observe")).toBe("world:observe");
    expect(oauthScopeForRoute("GET", "/world/clips")).toBe("world:observe");
    expect(oauthScopeForRoute("GET", "/world/places")).toBe("world:observe");
    expect(oauthScopeForRoute("POST", "/world/look")).toBe("world:observe");
    expect(oauthScopeForRoute("POST", "/world/body")).toBe("world:act");
    expect(oauthScopeForRoute("DELETE", "/world/body")).toBe("world:act");
    expect(oauthScopeForRoute("POST", "/world/act")).toBe("world:act");
    expect(oauthScopeForRoute("GET", "/world/act/abc-1")).toBe("world:act");
    expect(oauthScopeForRoute("GET", "/conversations")).toBe("inbox:read");
    expect(oauthScopeForRoute("GET", "/conversations/c1/messages")).toBe("inbox:read");
    expect(oauthScopeForRoute("POST", "/conversations/")).toBe("relay:send");
    expect(oauthScopeForRoute("POST", "/conversations/c1/messages")).toBe("relay:send");
  });

  test("everything else is closed to OAuth tokens", () => {
    for (const [m, p] of [
      ["POST", "/goals"], ["POST", "/memory"], ["POST", "/bazaar/delegations"], ["POST", "/eggs/e1/claim"],
      ["POST", "/world/see"], ["POST", "/conversations/c1/invite"], ["GET", "/conversations/c1/messages/x"],
      ["PATCH", "/a2a/tasks/t1"], ["GET", "/world/observe/extra"],
    ]) expect(oauthScopeForRoute(m, p)).toBeNull();
  });
});
