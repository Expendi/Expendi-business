import { beforeEach, describe, expect, it, vi } from "vitest";

import { mountCardEmbed } from "./card-embed";

const fakes = vi.hoisted(() => ({
  environments: [] as string[],
  sessions: [] as string[],
  mounts: [] as unknown[],
}));

vi.mock("lithic-embed", () => ({
  Environment: { SANDBOX: "SANDBOX", PRODUCTION: "PRODUCTION" },
  default: class {
    constructor(environment: string) {
      fakes.environments.push(environment);
    }
    card(session: string) {
      fakes.sessions.push(session);
      return {
        mount: (configuration: unknown) => {
          fakes.mounts.push(configuration);
          return Promise.resolve();
        },
      };
    }
  },
}));

const elements = {
  pan: { tag: "pan" },
  cvv: { tag: "cvv" },
  expMonth: { tag: "expMonth" },
  expYear: { tag: "expYear" },
} as unknown as Parameters<typeof mountCardEmbed>[1];

describe("mountCardEmbed", () => {
  beforeEach(() => {
    fakes.environments.length = 0;
    fakes.sessions.length = 0;
    fakes.mounts.length = 0;
  });

  it("uses Lithic's sandbox, whatever else happens", async () => {
    // #when
    await mountCardEmbed("not-a-real-session", elements).mounted;

    // #then
    expect(fakes.environments).toEqual(["SANDBOX"]);
  });

  it("gives the session to the embed and mounts number, CVV and expiry", async () => {
    // #when
    await mountCardEmbed("not-a-real-session", elements).mounted;
    const [mounted] = fakes.mounts as Record<string, { element: unknown }>[];

    // #then
    expect({
      session: fakes.sessions,
      pan: mounted?.pan?.element,
      cvv: mounted?.cvv?.element,
      expMonth: mounted?.expMonth?.element,
      expYear: mounted?.expYear?.element,
    }).toEqual({
      session: ["not-a-real-session"],
      pan: elements.pan,
      cvv: elements.cvv,
      expMonth: elements.expMonth,
      expYear: elements.expYear,
    });
  });
});
