import { auth } from "@/auth";
import { redirect } from "next/navigation";
import OnboardingWizard from "./wizard";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const session = await auth().catch(() => null);
  if (!session?.user) redirect("/login");
  return <OnboardingWizard />;
}
