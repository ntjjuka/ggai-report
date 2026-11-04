import { describe, expect, it } from "vitest";
import { publicBaseFromHeaders, publicBaseUrl, rebaseUrl } from "@/server/http";

describe("public base url for copied links", () => {
  it("uses the request host when APP_BASE_URL is localhost, honouring forwarded headers", () => {
    const req = (h: Record<string, string>) => new Request("http://ignored/x", { headers: h });
    expect(publicBaseUrl(req({ host: "124.55.163.59:3000" }), "http://localhost:3000")).toBe("http://124.55.163.59:3000");
    expect(publicBaseUrl(req({ "x-forwarded-host": "kkabi.example.com", "x-forwarded-proto": "https", host: "web:3000" }), "http://localhost:3000")).toBe("https://kkabi.example.com");
    expect(publicBaseUrl(req({}), "https://app.example.com/")).toBe("https://app.example.com");
    expect(rebaseUrl("http://localhost:3000/r/abc123?x=1", "http://124.55.163.59:3000")).toBe("http://124.55.163.59:3000/r/abc123?x=1");
    expect(rebaseUrl("not a url", "http://h")).toBe("not a url");
  });

  it("builds the same base from a server-component headers object", () => {
    expect(publicBaseFromHeaders(new Headers({ host: "192.168.0.10:3000" }), "http://localhost:3000")).toBe("http://192.168.0.10:3000");
    expect(publicBaseFromHeaders(new Headers(), "http://localhost:3000/")).toBe("http://localhost:3000");
  });
});
