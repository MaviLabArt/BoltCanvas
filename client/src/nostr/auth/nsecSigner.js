import { finalizeEvent, getPublicKey as derivePubkey, nip04, nip19 } from "nostr-tools";

export class NsecSigner {
  privkey = null;
  pubkey = null;

  login(nsecOrPrivkey) {
    let privkey;
    if (typeof nsecOrPrivkey === "string") {
      const { type, data } = nip19.decode(nsecOrPrivkey);
      if (type !== "nsec") {
        throw new Error("Invalid nsec");
      }
      privkey = data;
    } else {
      privkey = nsecOrPrivkey;
    }
    this.privkey = privkey;
    this.pubkey = derivePubkey(privkey);
    return this.pubkey;
  }

  async getPublicKey() {
    if (!this.pubkey) throw new Error("Not logged in");
    return this.pubkey;
  }

  async signEvent(draftEvent) {
    if (!this.privkey) throw new Error("Not logged in");
    return finalizeEvent(draftEvent, this.privkey);
  }

  async nip04Encrypt(pubkey, plainText) {
    if (!this.privkey) throw new Error("Not logged in");
    return nip04.encrypt(this.privkey, pubkey, plainText);
  }

  async nip04Decrypt(pubkey, cipherText) {
    if (!this.privkey) throw new Error("Not logged in");
    return nip04.decrypt(this.privkey, pubkey, cipherText);
  }
}
