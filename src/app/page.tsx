import { redirect } from "next/navigation";

// La raíz del CRM redirige al dashboard (que exige sesión y manda a
// /login si no la hay — middleware.ts). El CRM no sirve landings.
export default function RootPage() {
  redirect("/dashboard");
}
