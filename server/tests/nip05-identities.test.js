import { describe, expect, it, vi } from "vitest";
import { buildNip05Response } from "../nip05-identities.js";

const MAIN = "a".repeat(64);
const BEA = "b".repeat(64);
const POSTILLA = "c".repeat(64);
const RELAYS = ["wss://relay.example", "wss://nos.lol"];

function makeResolver(mapping) {
  return vi.fn(async (identifier) => mapping[identifier] || "");
}

describe("NIP-05 multi-identity response", () => {
  it("returns only the primary identity when no name is requested", async () => {
    const resolvePubkey = makeResolver({
      "npub-main": MAIN,
      "npub-bea": BEA,
      "npub-postilla": POSTILLA
    });

    const payload = await buildNip05Response({
      settings: {
        nostrNpub: "npub-main",
        nostrNip05: "isolabellart@isolabellart.it.com",
        nostrAdditionalNip05Identities: [
          { name: "Beaunique", npub: "npub-bea" },
          { name: "postilla", npub: "npub-postilla" }
        ]
      },
      resolvePubkey,
      relays: RELAYS
    });

    expect(payload.names).toEqual({ isolabellart: MAIN });
    expect(payload.relays).toEqual({ [MAIN]: RELAYS });
    expect(resolvePubkey).toHaveBeenCalledTimes(1);
  });

  it("returns only the requested identity for a NIP-05 lookup", async () => {
    const resolvePubkey = makeResolver({
      "npub-main": MAIN,
      "npub-bea": BEA
    });
    const payload = await buildNip05Response({
      settings: {
        nostrNpub: "npub-main",
        nostrNip05: "isolabellart@isolabellart.it.com",
        nostrAdditionalNip05Identities: [{ name: "beaunique", npub: "npub-bea" }]
      },
      requestedName: "BEAUNIQUE",
      resolvePubkey,
      relays: RELAYS
    });

    expect(payload.names).toEqual({ beaunique: BEA });
    expect(payload.relays).toEqual({ [BEA]: RELAYS });
  });

  it("returns an empty mapping for an unknown requested name", async () => {
    const resolvePubkey = makeResolver({ "npub-main": MAIN });
    const payload = await buildNip05Response({
      settings: {
        nostrNpub: "npub-main",
        nostrNip05: "isolabellart",
        nostrAdditionalNip05Identities: []
      },
      requestedName: "unknown",
      resolvePubkey,
      relays: RELAYS
    });

    expect(payload).toEqual({ names: {} });
  });

  it("keeps the primary name authoritative and ignores invalid entries", async () => {
    const resolvePubkey = makeResolver({
      "npub-main": MAIN,
      "npub-duplicate": BEA,
      "npub-postilla": "not-a-public-key"
    });
    const payload = await buildNip05Response({
      settings: {
        nostrNpub: "npub-main",
        nostrNip05: "isolabellart",
        nostrAdditionalNip05Identities: [
          { name: "isolabellart", npub: "npub-duplicate" },
          { name: "invalid name", npub: "npub-duplicate" },
          { name: "postilla", npub: "npub-postilla" }
        ]
      },
      resolvePubkey,
      relays: RELAYS
    });

    expect(payload.names).toEqual({ isolabellart: MAIN });
    expect(payload.relays).toEqual({ [MAIN]: RELAYS });
  });

  it("retains the old query-name fallback when the primary NIP-05 field is empty", async () => {
    const resolvePubkey = makeResolver({ "npub-main": MAIN });
    const payload = await buildNip05Response({
      settings: { nostrNpub: "npub-main", nostrNip05: "" },
      requestedName: "isolabellart",
      resolvePubkey,
      relays: RELAYS
    });

    expect(payload.names).toEqual({ isolabellart: MAIN });
  });

  it("accepts additional identities stored as JSON text", async () => {
    const resolvePubkey = makeResolver({ "npub-bea": BEA });
    const payload = await buildNip05Response({
      settings: {
        nostrAdditionalNip05Identities: JSON.stringify([{ name: "beaunique", npub: "npub-bea" }])
      },
      requestedName: "beaunique",
      resolvePubkey
    });

    expect(payload.names).toEqual({ beaunique: BEA });
  });
  it("does not expose every alias when the requested name is invalid", async () => {
    const resolvePubkey = makeResolver({
      "npub-main": MAIN,
      "npub-bea": BEA
    });
    const payload = await buildNip05Response({
      settings: {
        nostrNpub: "npub-main",
        nostrNip05: "isolabellart",
        nostrAdditionalNip05Identities: [{ name: "beaunique", npub: "npub-bea" }]
      },
      requestedName: "invalid username",
      resolvePubkey,
      relays: RELAYS
    });

    expect(payload).toEqual({ names: {} });
  });

});
