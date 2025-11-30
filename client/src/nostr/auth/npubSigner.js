import { nip19 } from "nostr-tools";

export class NpubSigner {
  pubkey = null;

  login(npub) {
    const { type, data } = nip19.decode(npub);
    if (type !== "npub") {
      throw new Error("Invalid npub");
    }
    this.pubkey = data;
    return this.pubkey;
  }

  async getPublicKey() {
    if (!this.pubkey) throw new Error("Not logged in");
    return this.pubkey;
  }

  async signEvent() {
    throw new Error("This login is read-only");
  }

  async nip04Encrypt() {
    throw new Error("This login is read-only");
  }

  async nip04Decrypt() {
    throw new Error("This login is read-only");
  }
}
