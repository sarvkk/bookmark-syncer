import { describe, expect, test } from "bun:test";
import app from "../src/index";

describe("api smoke", () => {
  test("GET /health returns ok", async () => {
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("POST /sync/push rejects missing device credentials", async () => {
    const response = await app.request("/sync/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operations: [] }),
    });
    expect(response.status).toBe(401);
  });

  test("GET /sync/pull rejects missing device credentials", async () => {
    const response = await app.request("/sync/pull?cursor=0");
    expect(response.status).toBe(401);
  });

  test("GET /devices rejects missing user token", async () => {
    const response = await app.request("/devices");
    expect(response.status).toBe(401);
  });

  test("unknown routes return JSON 404", async () => {
    const response = await app.request("/nope");
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("not found");
  });
});
