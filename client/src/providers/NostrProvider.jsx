import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import api from "../services/api.js";
import { Nip07Signer } from "../nostr/auth/nip07Signer.js";
import { NsecSigner } from "../nostr/auth/nsecSigner.js";
import { BunkerSigner } from "../nostr/auth/bunkerSigner.js";
import { NostrConnectionSigner } from "../nostr/auth/nostrConnectionSigner.js";
import { NpubSigner } from "../nostr/auth/npubSigner.js";
import LoginDialog from "../components/nostr/LoginDialog.jsx";
import { bytesToHex } from "@noble/hashes/utils";
import * as nip19 from "nostr-tools/nip19";
import * as nip49 from "nostr-tools/nip49";

const STORAGE_KEYS = {
  accounts: "nostr:accounts:v2",
  current: "nostr:current-account",
  secrets: "nostr:account-secrets:v1"
};
const AUTO_LOGIN_DISABLED = "nostr:auto-login-disabled";

const DEFAULT_STATE = {
  pubkey: "",
  account: null,
  signerType: "",
  sessionPubkey: ""
};

const NostrContext = createContext(undefined);

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

function shortKey(key = "") {
  const str = String(key || "");
  if (!str) return "";
  if (str.length <= 12) return str;
  return `${str.slice(0, 6)}…${str.slice(-6)}`;
}

function buildNostrShim(getPublicKey, signEvent) {
  return {
    getPublicKey,
    signEvent
  };
}

export function useNostr() {
  const ctx = useContext(NostrContext);
  if (!ctx) throw new Error("useNostr must be used within NostrProvider");
  return ctx;
}

export function NostrProvider({ children }) {
  const [state, setState] = useState(DEFAULT_STATE);
  const [accounts, setAccounts] = useState(() => readJSON(STORAGE_KEYS.accounts, []));
  const [accountSecrets, setAccountSecrets] = useState(() => readJSON(STORAGE_KEYS.secrets, {}));
  const [loginDialogOpen, setLoginDialogOpen] = useState(false);
  const [signer, setSigner] = useState(null);
  const [isBindingSession, setIsBindingSession] = useState(false);
  const [originalNostr] = useState(() => (typeof window !== "undefined" ? window.nostr : undefined));

  // keep window.nostr shim in sync with the active signer
  useEffect(() => {
    // Never override an existing extension, and don't replace window.nostr when using a nip07 signer.
    if (originalNostr || state.signerType === "nip07") {
      return;
    }
    if (!signer || !state.pubkey) {
      if (window.nostrShim) {
        if (window.nostr === window.nostrShim) {
          delete window.nostr;
        }
        delete window.nostrShim;
      }
      return;
    }
    const shim = buildNostrShim(
      () => signer.getPublicKey(),
      (draftEvent) => signer.signEvent(draftEvent)
    );
    window.nostrShim = shim;
    window.nostr = shim;
    return () => {
      if (window.nostr === shim) {
        delete window.nostr;
      }
      delete window.nostrShim;
    };
  }, [signer, state.pubkey]);

  // on mount: restore session from server and attempt auto-login from stored account
  useEffect(() => {
    const restore = async () => {
      try {
        const resp = await api.get("/nostr/me");
        const pk = resp?.data?.pubkey ? String(resp.data.pubkey) : "";
        if (pk) {
          setState((prev) => ({ ...prev, sessionPubkey: pk, pubkey: pk }));
          try {
            window.dispatchEvent(new CustomEvent("nostr:session", { detail: { pubkey: pk } }));
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }

      const storedAccounts = readJSON(STORAGE_KEYS.accounts, []);
      setAccounts(storedAccounts);
      const disableAutoLogin = localStorage.getItem(AUTO_LOGIN_DISABLED) === "1";
      if (disableAutoLogin) return;

      const currentPointer = readJSON(STORAGE_KEYS.current, null);
      const target = currentPointer || storedAccounts[0];
      if (!target) return;
      try {
        await switchAccount(target);
      } catch (err) {
        console.warn("[nostr] auto-login failed", err?.message || err);
      }
    };
    restore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persistAccounts = (nextAccounts, nextSecrets) => {
    setAccounts(nextAccounts);
    writeJSON(STORAGE_KEYS.accounts, nextAccounts);
    if (nextSecrets) {
      setAccountSecrets(nextSecrets);
      writeJSON(STORAGE_KEYS.secrets, nextSecrets);
    }
  };

  const bindServerSession = async (activeSigner, pubkey) => {
    setIsBindingSession(true);
    try {
      const challenge = await api
        .get("/nostr/login/challenge")
        .then((r) => r.data?.challenge)
        .catch((err) => {
          throw new Error(err?.response?.data?.error || "Login challenge failed");
        });
      if (!challenge) throw new Error("Missing challenge");
      const ev = {
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["challenge", challenge],
          ["domain", window.location.host]
        ],
        content: `Login to ${window.location.host}`,
        pubkey
      };
      const signed = await activeSigner.signEvent(ev);
      await api.post("/nostr/login/verify", { event: signed });
      setState((prev) => ({ ...prev, sessionPubkey: pubkey, pubkey }));
      try {
        window.dispatchEvent(new CustomEvent("nostr:session", { detail: { pubkey } }));
        window.dispatchEvent(new CustomEvent("nostr:session-bound", { detail: { pubkey } }));
      } catch {
        /* ignore */
      }
      return true;
    } finally {
      setIsBindingSession(false);
    }
  };

  const applyLogin = async ({ signerInstance, accountPointer, secretsUpdate }) => {
    const pubkey = await signerInstance.getPublicKey();
    localStorage.removeItem(AUTO_LOGIN_DISABLED);
    setSigner(signerInstance);
    setState((prev) => ({
      ...prev,
      pubkey,
      account: accountPointer,
      signerType: accountPointer.signerType,
      sessionPubkey: pubkey
    }));
    try {
      window.dispatchEvent(new CustomEvent("nostr:session", { detail: { pubkey } }));
    } catch {
      /* ignore */
    }

    const nextAccounts = upsertAccount(accounts, accountPointer);
    const nextSecrets = { ...accountSecrets };
    if (secretsUpdate?.pubkey) {
      nextSecrets[secretsUpdate.pubkey] = {
        ...(nextSecrets[secretsUpdate.pubkey] || {}),
        ...secretsUpdate.secret
      };
    }
    persistAccounts(nextAccounts, nextSecrets);
    writeJSON(STORAGE_KEYS.current, accountPointer);
    await bindServerSession(signerInstance, pubkey).catch((err) => {
      console.warn("[nostr] binding server session failed", err?.message || err);
    });
  };

  const startLogin = () => setLoginDialogOpen(true);
  const closeLogin = () => setLoginDialogOpen(false);

  const nip07Login = async () => {
    const signerInstance = new Nip07Signer();
    await signerInstance.init();
    const pubkey = await signerInstance.getPublicKey();
    await applyLogin({
      signerInstance,
      accountPointer: { pubkey, signerType: "nip07" }
    });
    closeLogin();
    return pubkey;
  };

  const nsecLogin = async (nsec, password) => {
    if (!nsec) throw new Error("Private key required");
    if (String(nsec).startsWith("ncryptsec")) {
      return ncryptsecLogin(nsec, password);
    }
    const signerInstance = new NsecSigner();
    const pubkey = signerInstance.login(nsec);
    await applyLogin({
      signerInstance,
      accountPointer: { pubkey, signerType: "nsec" },
      secretsUpdate: { pubkey, secret: { nsec } }
    });
    closeLogin();
    return pubkey;
  };

  const ncryptsecLogin = async (ncryptsec, password) => {
    if (!password) throw new Error("Password required for ncryptsec");
    const privkey = await nip49.decrypt(ncryptsec, password);
    const signerInstance = new NsecSigner();
    const pubkey = signerInstance.login(privkey);
    await applyLogin({
      signerInstance,
      accountPointer: { pubkey, signerType: "ncryptsec" },
      secretsUpdate: { pubkey, secret: { ncryptsec } }
    });
    closeLogin();
    return pubkey;
  };

  const bunkerLogin = async (bunker) => {
    if (!bunker) throw new Error("Bunker URL required");
    const existing = Object.values(accountSecrets || {}).find(
      (secret) => secret?.bunker === bunker
    )?.bunkerClientKey;
    const signerInstance = new BunkerSigner(existing);
    const pubkey = await signerInstance.login(bunker);
    const clientSecretKey = signerInstance.getClientSecretKey();
    await applyLogin({
      signerInstance,
      accountPointer: { pubkey, signerType: "bunker", bunker },
      secretsUpdate: { pubkey, secret: { bunker, bunkerClientKey: clientSecretKey } }
    });
    closeLogin();
    return pubkey;
  };

  const nostrConnectionLogin = async (clientSecretKey, connectionString) => {
    if (!clientSecretKey || !connectionString) {
      throw new Error("Missing Nostr Connect credentials");
    }
    const signerInstance = new NostrConnectionSigner(clientSecretKey, connectionString);
    const { pubkey, bunkerString } = await signerInstance.login();
    await applyLogin({
      signerInstance,
      accountPointer: { pubkey, signerType: "bunker", bunker: bunkerString },
      secretsUpdate: { pubkey, secret: { bunker: bunkerString, bunkerClientKey: bytesToHex(clientSecretKey) } }
    });
    closeLogin();
    return pubkey;
  };

  const npubLogin = async (npub) => {
    const signerInstance = new NpubSigner();
    const pubkey = signerInstance.login(npub);
    await applyLogin({
      signerInstance,
      accountPointer: { pubkey, signerType: "npub" }
    });
    closeLogin();
    return pubkey;
  };

  const logout = async () => {
    try {
      await api.post("/nostr/logout");
    } catch {
      /* ignore */
    }
    localStorage.setItem(AUTO_LOGIN_DISABLED, "1");
    setSigner(null);
    setState(DEFAULT_STATE);
    writeJSON(STORAGE_KEYS.current, null);
    try {
      window.dispatchEvent(new Event("nostr:logout"));
      window.dispatchEvent(new CustomEvent("nostr:session", { detail: { pubkey: "" } }));
    } catch {
      /* ignore */
    }
  };

  const removeAccount = (pointer) => {
    const filtered = accounts.filter((acc) => acc.pubkey !== pointer.pubkey);
    const nextSecrets = { ...accountSecrets };
    delete nextSecrets[pointer.pubkey];
    persistAccounts(filtered, nextSecrets);
    if (state.account?.pubkey === pointer.pubkey) {
      logout();
    }
  };

  async function switchAccount(pointer) {
    if (!pointer) {
      await logout();
      return;
    }
    const secrets = accountSecrets[pointer.pubkey] || {};
    let signerInstance = null;
    if (pointer.signerType === "nip07") {
      signerInstance = new Nip07Signer();
      await signerInstance.init();
    } else if (pointer.signerType === "nsec") {
      if (!secrets.nsec) throw new Error("No saved nsec for this account");
      signerInstance = new NsecSigner();
      signerInstance.login(secrets.nsec);
    } else if (pointer.signerType === "ncryptsec") {
      if (secrets.nsec) {
        signerInstance = new NsecSigner();
        signerInstance.login(secrets.nsec);
      } else {
        throw new Error("Password required to unlock this account");
      }
    } else if (pointer.signerType === "bunker") {
      if (!pointer.bunker && !secrets.bunker) throw new Error("Missing bunker URL");
      signerInstance = new BunkerSigner(secrets.bunkerClientKey);
      await signerInstance.login(pointer.bunker || secrets.bunker, false);
    } else if (pointer.signerType === "npub") {
      signerInstance = new NpubSigner();
      signerInstance.login(pointer.npub || nip19.npubEncode(pointer.pubkey));
    } else {
      throw new Error("Unsupported account type");
    }
    await applyLogin({
      signerInstance,
      accountPointer: pointer
    });
  }

  const value = useMemo(
    () => ({
      pubkey: state.pubkey,
      sessionPubkey: state.sessionPubkey,
      signerType: state.signerType,
      account: state.account,
      accounts,
      accountSecrets,
      startLogin,
      closeLogin,
      nip07Login,
      nsecLogin,
      ncryptsecLogin,
      bunkerLogin,
      nostrConnectionLogin,
      npubLogin,
      logout,
      removeAccount,
      switchAccount,
      signEvent: (draftEvent) => signer?.signEvent(draftEvent),
      getPublicKey: () => signer?.getPublicKey(),
      shortKey,
      isBindingSession,
      hasSigner: !!signer
    }),
    [
      state.pubkey,
      state.sessionPubkey,
      state.signerType,
      state.account,
      accounts,
      accountSecrets,
      signer,
      isBindingSession
    ]
  );

  return (
    <NostrContext.Provider value={value}>
      {children}
      <LoginDialog open={loginDialogOpen} onClose={closeLogin} />
    </NostrContext.Provider>
  );
}

function upsertAccount(list, account) {
  const seen = new Set();
  const next = [];
  const all = [account, ...list];
  for (const acc of all) {
    if (!acc?.pubkey || seen.has(acc.pubkey)) continue;
    seen.add(acc.pubkey);
    next.push(acc);
  }
  return next;
}
