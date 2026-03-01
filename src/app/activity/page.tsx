import { redirect } from "next/navigation";

export default function ActivityPage() {
  redirect("/profile?view=activity");
}
