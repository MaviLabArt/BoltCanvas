import { useRef } from "react";
import api from "../services/api.js";

export function useAdmin() {
  const loggedIn = useRef(false);
  async function me() {
    const r = await api.get("/admin/me");
    loggedIn.current = !!r.data?.loggedIn;
    return loggedIn.current;
  }
  return { me, loggedIn };
}
