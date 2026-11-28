// rootcause://auth/callback is caught by the sign-in session (src/auth/sso.ts). If
// the router sees it too, just go back to the web app.
import { Redirect } from "expo-router";

export default function AuthCallback() {
  return <Redirect href="/" />;
}
