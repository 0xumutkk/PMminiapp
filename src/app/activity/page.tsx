import { AppShell } from "@/components/app-shell";

const SAMPLE_ACTIVITY = [
  { id: "a1", title: "Bet confirmed", detail: "You bought YES on BTC > $120k before Dec 2026", time: "2m ago" },
  { id: "a2", title: "Market moved", detail: "Fed rate cut probability moved from 39% to 42%", time: "18m ago" },
  { id: "a3", title: "Reminder", detail: "3 markets in your portfolio close this week", time: "1h ago" }
];

export default function ActivityPage() {
  return (
    <AppShell title="Activity" subtitle="Execution and market updates" scrollContent>
      <div className="activity-list">
        {SAMPLE_ACTIVITY.map((item) => (
          <article key={item.id} className="activity-item">
            <p className="activity-item__title">{item.title}</p>
            <p className="activity-item__detail">{item.detail}</p>
            <p className="activity-item__time">{item.time}</p>
          </article>
        ))}
      </div>
    </AppShell>
  );
}
