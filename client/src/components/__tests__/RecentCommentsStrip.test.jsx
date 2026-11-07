import React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const mocks = vi.hoisted(() => ({
  useSettings: vi.fn(),
  fetchRecentProductComments: vi.fn(),
  fetchProfilesForEvents: vi.fn(),
  normalizeComments: vi.fn()
}));

vi.mock("../store/settings.jsx", () => ({
  useSettings: mocks.useSettings
}));
vi.mock("../nostr/read-comments.js", () => ({
  fetchRecentProductComments: mocks.fetchRecentProductComments
}));
vi.mock("../nostr/profiles.js", () => ({
  fetchProfilesForEvents: mocks.fetchProfilesForEvents
}));
vi.mock("../nostr/normalize.js", () => ({
  normalizeComments: mocks.normalizeComments
}));

import RecentCommentsStrip from "../RecentCommentsStrip.jsx";

describe("RecentCommentsStrip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchRecentProductComments.mockResolvedValue([]);
    mocks.fetchProfilesForEvents.mockResolvedValue([]);
    mocks.normalizeComments.mockReturnValue([]);
  });

  it("keeps hook order stable when the store public key becomes available", async () => {
    const relays = ["wss://relay.example"];
    const disabledSettings = {
      nostrCommentsEnabled: true,
      nostrShopPubkey: "",
      nostrRelays: relays
    };
    const enabledSettings = {
      nostrCommentsEnabled: true,
      nostrShopPubkey: "a".repeat(64),
      nostrRelays: relays
    };

    mocks.useSettings.mockReturnValue({ settings: disabledSettings });

    const renderTree = () => (
      <MemoryRouter>
        <RecentCommentsStrip products={[]} />
      </MemoryRouter>
    );
    const { container, rerender } = render(renderTree());

    expect(container.firstChild).toBeNull();

    mocks.useSettings.mockReturnValue({ settings: enabledSettings });

    await act(async () => {
      rerender(renderTree());
    });

    await waitFor(() => {
      expect(mocks.fetchRecentProductComments).toHaveBeenCalledWith({
        relays,
        storePubkey: "a".repeat(64),
        limit: 12
      });
    });
  });
});
