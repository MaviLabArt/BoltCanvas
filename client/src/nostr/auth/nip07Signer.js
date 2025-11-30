export class Nip07Signer {
  signer = null;
  pubkey = null;

  async init() {
    const checkInterval = 100;
    const maxAttempts = 50;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (window.nostr) {
        this.signer = window.nostr;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }

    throw new Error("Install a NIP-07 signer (Alby, nos2x, etc.) to log in.");
  }

  async getPublicKey() {
    if (!this.signer) throw new Error("Call init() first");
    if (!this.pubkey) {
      this.pubkey = await this.signer.getPublicKey();
    }
    return this.pubkey;
  }

  async signEvent(draftEvent) {
    if (!this.signer) throw new Error("Call init() first");
    return await this.signer.signEvent(draftEvent);
  }

  async nip04Encrypt(pubkey, plainText) {
    if (!this.signer) throw new Error("Call init() first");
    if (!this.signer.nip04?.encrypt) {
      throw new Error("The signer does not support nip04 encryption");
    }
    return await this.signer.nip04.encrypt(pubkey, plainText);
  }

  async nip04Decrypt(pubkey, cipherText) {
    if (!this.signer) throw new Error("Call init() first");
    if (!this.signer.nip04?.decrypt) {
      throw new Error("The signer does not support nip04 decryption");
    }
    return await this.signer.nip04.decrypt(pubkey, cipherText);
  }
}
