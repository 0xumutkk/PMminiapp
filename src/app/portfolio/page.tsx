import { redirect } from "next/navigation";

export default function PortfolioPage() {
  redirect("/profile?view=portfolio");
}
